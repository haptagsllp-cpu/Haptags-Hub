'use strict';

const express = require('express');
const { db } = require('../../db');
const rt = require('../../lib/realtime');
const rooms = require('../../lib/rooms');
const M = require('../../lib/meetings');
const chat = require('../../lib/chat');
const { nowSql, str, int, isEmail, istToUtc, utcToIst, addMinutesSql, todayIST } = require('../../lib/util');
const { idParam } = require('./_helpers');

const router = express.Router();

const ids = (v) => [].concat(v || []).map((x) => int(x, 0)).filter(Boolean);
const emailList = (v) => String(v || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Next half hour in India time, for a new meeting's default start. */
function nextSlot() {
  const t = utcToIst(addMinutesSql(nowSql(), 30 - (new Date().getUTCMinutes() % 30)));
  return { date: t.date, time: t.time };
}

async function formLocals(meeting, errors = {}) {
  return {
    meeting, errors, durations: M.DURATIONS,
    team: await chat.activeStaff().orderBy('name').select('id', 'name', 'email'),
  };
}

function readForm(body) {
  const date = String(body.date || '');
  const time = String(body.time || '');
  const emails = emailList(body.emails);
  const meeting = {
    title: str(body.title, 190),
    agenda: str(body.agenda, 5000),
    date, time,
    starts_at: istToUtc(date, time),
    duration_min: M.DURATIONS.includes(int(body.duration_min, 0)) ? int(body.duration_min, 0) : 30,
    allow_guests: Boolean(body.allow_guests),
    user_ids: ids(body.user_ids),
    emails: body.emails || '',
  };
  const errors = {};
  if (!meeting.title) errors.title = 'Give the meeting a title.';
  if (!meeting.starts_at) errors.date = 'Pick a date and time.';
  const bad = emails.filter((e) => !isEmail(e));
  if (bad.length) errors.emails = `Check these addresses: ${bad.join(', ')}`;
  return { meeting, emails: emails.filter(isEmail), errors };
}

async function canManage(req, meeting) {
  return meeting.created_by === req.user.id || ['owner', 'admin'].includes(req.user.role);
}

router.get('/', async (req, res) => {
  const view = ['upcoming', 'past', 'team'].includes(req.query.view) ? req.query.view : 'upcoming';
  const now = nowSql();
  let rows;
  if (view === 'team') {
    rows = await db('meetings as m').leftJoin('users as u', 'u.id', 'm.created_by').where('m.status', 'scheduled')
      .where('m.starts_at', '>=', addMinutesSql(now, -240)).orderBy('m.starts_at').limit(200).select('m.*', 'u.name as organizer_name');
  } else if (view === 'past') {
    rows = (await M.meetingsFor(req.user.id, { to: now, includeCancelled: true }).clearOrder().orderBy('m.starts_at', 'desc').limit(100));
  } else {
    rows = await M.meetingsFor(req.user.id, { from: addMinutesSql(now, -240) }).limit(200);
  }
  const live = rooms.liveCounts();
  rows = rows.map((m) => ({ ...m, ...M.timing(m, live) }));
  if (view !== 'past') rows = rows.filter((m) => !m.past || m.inCall);
  // Group by India date for the agenda view.
  const groups = [];
  for (const m of rows) {
    const d = utcToIst(m.starts_at).date;
    if (!groups.length || groups[groups.length - 1].date !== d) groups.push({ date: d, items: [] });
    groups[groups.length - 1].items.push(m);
  }
  res.render('admin/meetings/index', { title: 'Meetings', view, groups, today: todayIST() });
});

router.get('/new', async (req, res) => {
  const slot = nextSlot();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : slot.date;
  res.render('admin/meetings/form', {
    title: 'New meeting',
    ...(await formLocals({ title: '', agenda: '', date, time: req.query.time || slot.time, duration_min: 30, allow_guests: true, user_ids: ids(req.query.user_ids), emails: req.query.emails || '' })),
  });
});

router.post('/', async (req, res) => {
  const { meeting, emails, errors } = readForm(req.body);
  if (Object.keys(errors).length) return res.status(422).render('admin/meetings/form', { title: 'New meeting', ...(await formLocals(meeting, errors)) });
  const id = await M.createMeeting({
    title: meeting.title, agenda: meeting.agenda, startsAt: meeting.starts_at, duration: meeting.duration_min,
    allowGuests: meeting.allow_guests, createdBy: req.user.id, userIds: meeting.user_ids, emails,
  });
  const m = await db('meetings').where({ id }).first();
  const sent = req.body.send_invites ? await M.emailInvites(id, { skipUserId: req.user.id }) : 0;
  rt.publish({ users: (await M.teamIds(m)).filter((u) => u !== req.user.id) }, 'meeting.invite', {
    id, title: m.title, by: req.user.name, url: `/admin/meetings/${id}`, startsAt: `${m.starts_at.replace(' ', 'T')}Z`,
  });
  req.flash('success', sent ? `Meeting scheduled. Invitations sent to ${sent} ${sent === 1 ? 'person' : 'people'}.` : 'Meeting scheduled.');
  res.redirect(`/admin/meetings/${id}`);
});

// "Meet now": an instant room, straight in.
router.post('/now', async (req, res) => {
  const id = await M.createMeeting({
    title: str(req.body.title, 190) || `${req.user.name.split(' ')[0]}'s meeting`, startsAt: nowSql(), duration: 60, allowGuests: true, createdBy: req.user.id,
  });
  const m = await db('meetings').where({ id }).first();
  res.redirect(`/meet/${m.room_token}`);
});

async function load(req, res, next) {
  const m = await db('meetings as m').leftJoin('users as u', 'u.id', 'm.created_by').where('m.id', idParam(req))
    .select('m.*', 'u.name as organizer_name').first();
  if (!m) return next('route');
  req.meeting = m;
  next();
}

router.get('/:id', load, async (req, res) => {
  const m = req.meeting;
  const people = await M.invitees(m.id);
  const mine = people.find((p) => p.user_id === req.user.id);
  res.render('admin/meetings/show', {
    title: m.title, meeting: { ...m, ...M.timing(m) }, people, mine, canManage: await canManage(req, m), joinUrl: M.joinUrl(m),
  });
});

router.get('/:id/invite.ics', load, async (req, res) => {
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="meeting-${req.meeting.id}.ics"` });
  res.send(M.ics(req.meeting, { organizerName: req.meeting.organizer_name || 'Haptags' }));
});

router.get('/:id/edit', load, async (req, res) => {
  const m = req.meeting;
  if (!(await canManage(req, m))) return res.redirect(`/admin/meetings/${m.id}`);
  const people = await M.invitees(m.id);
  const t = utcToIst(m.starts_at);
  res.render('admin/meetings/form', {
    title: `Edit ${m.title}`,
    ...(await formLocals({
      ...m, date: t.date, time: t.time,
      user_ids: people.filter((p) => p.user_id).map((p) => p.user_id),
      emails: people.filter((p) => !p.user_id).map((p) => p.email).join(', '),
    })),
  });
});

router.post('/:id', load, async (req, res) => {
  const m = req.meeting;
  if (!(await canManage(req, m))) return res.redirect(`/admin/meetings/${m.id}`);
  const { meeting, emails, errors } = readForm(req.body);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/meetings/form', { title: `Edit ${m.title}`, ...(await formLocals({ ...meeting, id: m.id }, errors)) });
  }
  const timeChanged = meeting.starts_at !== m.starts_at || meeting.duration_min !== m.duration_min;
  await db('meetings').where({ id: m.id }).update({
    title: meeting.title, agenda: meeting.agenda, starts_at: meeting.starts_at, duration_min: meeting.duration_min,
    allow_guests: meeting.allow_guests, updated_at: nowSql(), ...(timeChanged ? { reminded_at: null } : {}),
  });
  const added = await M.setInvitees(m.id, meeting.user_ids.filter((u) => u !== m.created_by), emails);
  let sent = 0;
  if (req.body.send_invites) {
    sent += await M.emailInvites(m.id, { kind: 'invite', only: added, skipUserId: req.user.id });
    if (timeChanged) {
      const existing = (await M.invitees(m.id)).map((p) => p.user_email || p.email).filter((e) => !added.includes(e));
      sent += await M.emailInvites(m.id, { kind: 'update', only: existing, skipUserId: req.user.id });
    }
  }
  req.flash('success', sent ? `Meeting updated. ${sent} ${sent === 1 ? 'email' : 'emails'} sent.` : 'Meeting updated.');
  res.redirect(`/admin/meetings/${m.id}`);
});

router.post('/:id/cancel', load, async (req, res) => {
  const m = req.meeting;
  if (!(await canManage(req, m)) || m.status !== 'scheduled') return res.redirect(`/admin/meetings/${m.id}`);
  await db('meetings').where({ id: m.id }).update({ status: 'cancelled', updated_at: nowSql() });
  const sent = req.body.notify ? await M.emailInvites(m.id, { kind: 'cancel', skipUserId: req.user.id }) : 0;
  req.flash('success', sent ? `Meeting cancelled and ${sent} ${sent === 1 ? 'person' : 'people'} told.` : 'Meeting cancelled.');
  res.redirect(`/admin/meetings/${m.id}`);
});

router.post('/:id/rsvp', load, async (req, res) => {
  const response = ['accepted', 'declined'].includes(req.body.response) ? req.body.response : 'pending';
  await db('meeting_invitees').where({ meeting_id: req.meeting.id, user_id: req.user.id }).update({ response });
  res.redirect(`/admin/meetings/${req.meeting.id}`);
});

module.exports = router;
