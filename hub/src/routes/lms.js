'use strict';

// Haptags LMS integration (server-to-server from lms.haptags.com).
//
// POST /api/v1/lms/doubt-session   header X-API-Key: <LMS key>
//   { course_slug, course_title, student_email, student_name }
// Returns the course's daily doubt-clearing session (creating the meeting on first request
// of the day), adds the student as a guest and emails them the calendar invite once.

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db } = require('../db');
const { createMeeting, emailInvites, joinUrl } = require('../lib/meetings');
const { str, isEmail, sha256, safeEqual, todayIST, addDays, istToUtc, addMinutesSql, nowSql } = require('../lib/util');

const router = express.Router();

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

function authorised(req) {
  const key = req.get('x-api-key') || '';
  return Boolean(key) && safeEqual(sha256(key), config.lms.keySha256);
}

async function hostUser() {
  const q = db('users').where({ is_active: true });
  if (config.lms.hostEmail) {
    const u = await q.clone().where({ email: config.lms.hostEmail.toLowerCase() }).first();
    if (u) return u;
  }
  return q.clone().whereIn('role', ['owner', 'admin']).orderByRaw("CASE WHEN role = 'owner' THEN 0 ELSE 1 END").orderBy('id').first();
}

/** Today's session, or tomorrow's once today's has ended. */
function sessionSlot() {
  let date = todayIST();
  let startsAt = istToUtc(date, config.lms.sessionTime);
  if (nowSql() >= addMinutesSql(startsAt, config.lms.sessionMinutes)) {
    date = addDays(date, 1);
    startsAt = istToUtc(date, config.lms.sessionTime);
  }
  return { date, startsAt };
}

async function findOrCreateSession({ slug, title, date, startsAt }) {
  const existing = await db('lms_sessions').where({ course_slug: slug, session_date: date }).first();
  if (existing) return db('meetings').where({ id: existing.meeting_id }).first();
  const host = await hostUser();
  if (!host) throw new Error('No active owner/admin in Hub to host LMS sessions.');
  const meetingId = await createMeeting({
    title: `Doubt session · ${title}`.slice(0, 190),
    agenda: `Daily live doubt-clearing session for Haptags LMS students of "${title}".\nBring your questions on the notes, quizzes and the capstone project.`,
    startsAt,
    duration: config.lms.sessionMinutes,
    allowGuests: true,
    createdBy: host.id,
  });
  try {
    await db('lms_sessions').insert({ course_slug: slug, session_date: date, meeting_id: meetingId, created_at: nowSql() });
  } catch (err) {
    // Another request created today's session first: keep that one.
    const winner = await db('lms_sessions').where({ course_slug: slug, session_date: date }).first();
    if (!winner) throw err;
    await db('meetings').where({ id: meetingId }).del();
    return db('meetings').where({ id: winner.meeting_id }).first();
  }
  return db('meetings').where({ id: meetingId }).first();
}

router.post('/api/v1/lms/doubt-session', limiter, async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ error: 'Missing or invalid API key.' });
  const b = req.body || {};
  const slug = str(b.course_slug, 190) || '';
  const title = str(b.course_title, 160) || slug;
  const email = (str(b.student_email, 190) || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(422).json({ error: 'course_slug is required.' });
  if (email && !isEmail(email)) return res.status(422).json({ error: 'student_email is not valid.' });

  const slot = sessionSlot();
  const meeting = await findOrCreateSession({ slug, title, ...slot });

  let invited = false;
  if (email) {
    const already = await db('meeting_invitees').where({ meeting_id: meeting.id }).whereRaw('LOWER(email) = ?', [email]).first();
    if (!already) {
      await db('meeting_invitees').insert({ meeting_id: meeting.id, email });
      invited = (await emailInvites(meeting.id, { kind: 'invite', only: [email] })) > 0;
    }
  }

  res.json({
    title: meeting.title,
    date: slot.date,
    starts_at: `${meeting.starts_at.replace(' ', 'T')}Z`,
    duration_min: meeting.duration_min,
    join_url: joinUrl(meeting),
    invited,
  });
});

module.exports = router;
