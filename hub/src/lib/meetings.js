'use strict';

const config = require('../config');
const { db } = require('../db');
const rt = require('./realtime');
const rooms = require('./rooms');
const { sendMail } = require('./mailer');
const { getSettings } = require('./settings');
const { nowSql, randomToken, addMinutesSql, formatDateTime, formatTime } = require('./util');

const DURATIONS = [15, 30, 45, 60, 90, 120];
const REMIND_MINUTES = 5;

const joinUrl = (m) => `${config.baseUrl}/meet/${m.room_token}`;
const icsTime = (sql) => String(sql).replace(/[-: ]/g, '').slice(0, 15).replace(/^(\d{8})(\d{6})$/, '$1T$2Z');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds lines at 74 octets as RFC 5545 asks (Outlook rejects long lines). */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

/** A calendar event with a 10-minute alert. `cancel` produces the matching cancellation. */
function ics(meeting, { cancel = false, organizerName = 'Haptags', organizerEmail = 'info@haptags.com', attendees = [] } = {}) {
  const url = joinUrl(meeting);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Haptags//Hub//EN', 'CALSCALE:GREGORIAN', `METHOD:${cancel ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:meeting-${meeting.id}@${new URL(config.baseUrl).host}`,
    `SEQUENCE:${Math.floor(new Date(`${String(meeting.updated_at || meeting.created_at).replace(' ', 'T')}Z`).getTime() / 1000)}`,
    `DTSTAMP:${icsTime(nowSql())}`,
    `DTSTART:${icsTime(meeting.starts_at)}`,
    `DTEND:${icsTime(addMinutesSql(meeting.starts_at, meeting.duration_min))}`,
    `SUMMARY:${icsText(meeting.title)}`,
    `DESCRIPTION:${icsText(`${meeting.agenda ? `${meeting.agenda}\n\n` : ''}Join: ${url}`)}`,
    `LOCATION:${icsText(url)}`,
    `URL:${url}`,
    `ORGANIZER;CN=${icsText(organizerName)}:mailto:${organizerEmail}`,
    ...attendees.map((a) => `ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${a}`),
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  if (!cancel) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Meeting starts in 10 minutes', 'TRIGGER:-PT10M', 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

async function invitees(meetingId) {
  return db('meeting_invitees as i').leftJoin('users as u', 'u.id', 'i.user_id').where('i.meeting_id', meetingId)
    .orderByRaw('CASE WHEN i.user_id IS NULL THEN 1 ELSE 0 END').orderBy('u.name').orderBy('i.email')
    .select('i.*', 'u.name as user_name', 'u.email as user_email');
}

/** Team members to notify in-app: invitees plus the organiser. */
async function teamIds(meeting) {
  const ids = await db('meeting_invitees').where({ meeting_id: meeting.id }).whereNotNull('user_id').pluck('user_id');
  return [...new Set([...ids, meeting.created_by].filter(Boolean))];
}

/**
 * Saves invitees: `userIds` are team members, `emails` are outside guests. Keeps the RSVP of
 * anyone already invited, removes people no longer listed and returns the newly added emails.
 */
async function setInvitees(meetingId, userIds, emails) {
  const current = await db('meeting_invitees').where({ meeting_id: meetingId });
  const users = await db('users').whereIn('id', userIds.length ? userIds : [0]).where({ is_active: true }).select('id', 'email');
  const wantUsers = new Set(users.map((u) => u.id));
  const teamEmails = new Set(users.map((u) => u.email.toLowerCase()));
  const wantEmails = new Set(emails.map((e) => e.toLowerCase()).filter((e) => !teamEmails.has(e)));
  const remove = current.filter((i) => (i.user_id ? !wantUsers.has(i.user_id) : !wantEmails.has(String(i.email).toLowerCase()))).map((i) => i.id);
  if (remove.length) await db('meeting_invitees').whereIn('id', remove).del();
  const haveUsers = new Set(current.filter((i) => i.user_id).map((i) => i.user_id));
  const haveEmails = new Set(current.filter((i) => !i.user_id).map((i) => String(i.email).toLowerCase()));
  const add = [
    ...[...wantUsers].filter((id) => !haveUsers.has(id)).map((id) => ({ meeting_id: meetingId, user_id: id })),
    ...[...wantEmails].filter((e) => !haveEmails.has(e)).map((e) => ({ meeting_id: meetingId, email: e })),
  ];
  if (add.length) await db('meeting_invitees').insert(add);
  return add.map((a) => (a.user_id ? users.find((u) => u.id === a.user_id).email : a.email));
}

async function createMeeting({ title, agenda, startsAt, duration, allowGuests = true, createdBy, userIds = [], emails = [], channelId = null }) {
  const now = nowSql();
  const [id] = await db('meetings').insert({
    title, agenda, starts_at: startsAt, duration_min: duration, room_token: randomToken(16), allow_guests: allowGuests,
    status: 'scheduled', channel_id: channelId, created_by: createdBy, created_at: now, updated_at: now,
  });
  await setInvitees(id, userIds.filter((u) => Number(u) !== Number(createdBy)), emails);
  return id;
}

/**
 * Emails invitations (or a cancellation) with a calendar invite attached. `only` limits it to
 * those addresses; the person who made the change is never emailed about it.
 */
async function emailInvites(meetingId, { kind = 'invite', only = null, skipUserId = null } = {}) {
  const meeting = await db('meetings').where({ id: meetingId }).first();
  if (!meeting) return 0;
  const [s, people, organizer] = await Promise.all([
    getSettings(), invitees(meetingId), db('users').where({ id: meeting.created_by }).first(),
  ]);
  const skip = skipUserId ? (await db('users').where({ id: skipUserId }).first() || {}).email : null;
  const all = people.map((p) => p.user_email || p.email).filter(Boolean);
  const to = all.filter((e) => e !== skip && (!only || only.includes(e)));
  const organizerName = organizer ? organizer.name : s.company_name;
  const content = ics(meeting, { cancel: kind === 'cancel', organizerName, organizerEmail: s.email, attendees: all });
  const when = `${formatDateTime(meeting.starts_at)} – ${formatTime(addMinutesSql(meeting.starts_at, meeting.duration_min))} IST`;
  const heading = { invite: `You're invited: ${meeting.title}`, update: `Updated: ${meeting.title}`, cancel: `Cancelled: ${meeting.title}` }[kind];
  for (const email of to) {
    await sendMail({
      to: email,
      subject: heading,
      replyTo: organizer ? organizer.email : undefined,
      related: ['meeting', meeting.id],
      heading,
      lines: kind === 'cancel'
        ? [`${organizerName} cancelled this meeting.`]
        : [`${organizerName} invited you to a video meeting on Haptags Hub. It runs in your browser; there's nothing to install.`, ...(meeting.agenda ? meeting.agenda.split(/\n+/) : [])],
      rows: [['When', when], ['Duration', `${meeting.duration_min} minutes`]],
      button: kind === 'cancel' ? undefined : { label: 'Join meeting', url: joinUrl(meeting) },
      footnote: kind === 'cancel' ? undefined : `Or open ${joinUrl(meeting)} in Chrome, Edge, Safari or Firefox. Allow camera and microphone when asked.`,
      icalEvent: { method: kind === 'cancel' ? 'CANCEL' : 'REQUEST', filename: 'invite.ics', content },
    });
  }
  return to.length;
}

/** Meetings the user organises or is invited to, in a UTC window. */
function meetingsFor(userId, { from, to, includeCancelled = false } = {}) {
  const q = db('meetings as m').leftJoin('users as u', 'u.id', 'm.created_by')
    .where((w) => w.where('m.created_by', userId).orWhereExists(
      db('meeting_invitees as i').whereRaw('i.meeting_id = m.id').where('i.user_id', userId),
    ))
    .select('m.*', 'u.name as organizer_name')
    .orderBy('m.starts_at');
  if (from) q.where('m.starts_at', '>=', from);
  if (to) q.where('m.starts_at', '<', to);
  if (!includeCancelled) q.where('m.status', 'scheduled');
  return q;
}

/** A meeting is "live" while people are in the room, and "now" from 10 minutes before until it ends. */
function timing(meeting, live = rooms.liveCounts()) {
  const now = nowSql();
  const end = addMinutesSql(meeting.starts_at, meeting.duration_min);
  return {
    inCall: live[meeting.id] || 0,
    soon: meeting.status === 'scheduled' && now >= addMinutesSql(meeting.starts_at, -10) && now < end,
    past: now >= end,
    endsAt: end,
  };
}

// In-app nudge a few minutes before each meeting (the calendar invite carries its own alert).
async function sendReminders() {
  const now = nowSql();
  const due = await db('meetings').where({ status: 'scheduled' }).whereNull('reminded_at')
    .where('starts_at', '<=', addMinutesSql(now, REMIND_MINUTES)).where('starts_at', '>', addMinutesSql(now, -5));
  for (const m of due) {
    await db('meetings').where({ id: m.id }).update({ reminded_at: now });
    rt.publish({ users: await teamIds(m) }, 'meeting.soon', { id: m.id, title: m.title, url: `/meet/${m.room_token}`, startsAt: `${m.starts_at.replace(' ', 'T')}Z` });
  }
}

function startMeetingReminders() {
  setInterval(() => sendReminders().catch((err) => console.error('[meetings]', err)), 30 * 1000).unref();
}

rooms.onRoomStart((meetingId) => {
  db('meetings').where({ id: meetingId }).whereNull('started_at').update({ started_at: nowSql() }).catch(() => {});
});

module.exports = {
  DURATIONS, joinUrl, ics, invitees, teamIds, setInvitees, createMeeting, emailInvites, meetingsFor, timing,
  sendReminders, startMeetingReminders,
};
