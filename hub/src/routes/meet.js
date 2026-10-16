'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db } = require('../db');
const rt = require('../lib/realtime');
const rooms = require('../lib/rooms');
const { teamIds } = require('../lib/meetings');
const { STAFF_ROLES } = require('../lib/auth');
const { str, addMinutesSql, nowSql } = require('../lib/util');

const router = express.Router();

const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });
const actionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });

const isStaff = (user) => Boolean(user && STAFF_ROLES.includes(user.role));

async function loadMeeting(req, res, next) {
  const token = String(req.params.token || '');
  const meeting = /^[a-f0-9]{32}$/.test(token) ? await db('meetings').where({ room_token: token }).first() : null;
  if (!meeting) {
    return res.status(404).render('public/message', {
      title: 'Meeting not found', heading: 'This meeting link isn’t valid', body: 'Check the link in your invitation, or ask the organiser to send it again.',
    });
  }
  req.meeting = meeting;
  next();
}

/** For the JSON endpoints: the caller's live connection, which must belong to this meeting. */
function peer(req, res, next) {
  const body = req.body || {};
  const c = rt.auth(body.cid, body.key);
  const found = c && rooms.peerOf(c.cid);
  if (!found || found.room.meetingId !== req.meeting.id) return res.status(403).json({ error: 'You are not in this meeting.' });
  req.rtClient = c;
  next();
}

router.get('/meet/:token', loadMeeting, async (req, res) => {
  const m = req.meeting;
  const host = isStaff(req.user);
  if (m.status === 'cancelled') {
    return res.status(410).render('public/message', { title: 'Meeting cancelled', heading: 'This meeting was cancelled', body: `“${m.title}” is no longer taking place.` });
  }
  if (!host && !m.allow_guests) {
    return res.status(403).render('public/message', {
      title: m.title, heading: 'This meeting is for the Haptags team', body: 'Sign in with your team account to join.',
      link: { href: `/login?next=${encodeURIComponent(req.originalUrl)}`, label: 'Sign in' },
    });
  }
  const organizer = await db('users').where({ id: m.created_by }).first();
  res.render('meet/room', {
    layout: 'room',
    title: m.title,
    meeting: m,
    organizer,
    host,
    endsAt: addMinutesSql(m.starts_at, m.duration_min),
    defaultName: req.user ? req.user.name : req.session.meetName || '',
    room: { token: m.room_token, host, iceServers: config.iceServers, back: host ? `/admin/meetings/${m.id}` : null },
  });
});

// Who's already in the call, shown on the join screen (anyone with the link can see it, as in Meet).
router.get('/meet/:token/status', loadMeeting, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ names: req.meeting.status === 'scheduled' ? rooms.whoIsIn(req.meeting.id) : [] });
});

router.post('/meet/:token/join', joinLimiter, loadMeeting, async (req, res) => {
  const m = req.meeting;
  const host = isStaff(req.user);
  if (m.status !== 'scheduled') return res.status(410).json({ error: 'This meeting was cancelled.' });
  if (!host && !m.allow_guests) return res.status(403).json({ error: 'Sign in with your team account to join.' });
  const name = host ? req.user.name : str(req.body.name, 60);
  if (!name) return res.status(422).json({ error: 'Enter your name so others know who you are.' });
  if (!host) req.session.meetName = name;

  const conn = rt.connect({ userId: req.user ? req.user.id : null, name });
  const result = rooms.join(m.id, { cid: conn.cid, name, userId: req.user ? req.user.id : null, host, mic: req.body.mic, cam: req.body.cam });
  if (result.state === 'waiting' && !result.hostsPresent) {
    // Nobody from the team is in the room yet: tell the organiser and invited team members.
    rt.publish({ users: await teamIds(m) }, 'meeting.knock', { id: m.id, title: m.title, name, url: `/meet/${m.room_token}` });
  }
  if (host) await db('meetings').where({ id: m.id }).whereNull('started_at').update({ started_at: nowSql() });
  res.json({ ...conn, ...result });
});

// Sent with navigator.sendBeacon when the tab closes, so it arrives as a form post.
router.post('/meet/:token/leave', loadMeeting, peer, (req, res) => {
  rooms.leave(req.rtClient.cid);
  rt.disconnect(req.rtClient.cid);
  res.status(204).end();
});

router.post('/meet/:token/signal', actionLimiter, loadMeeting, peer, (req, res) => {
  const ok = rooms.signal(req.rtClient.cid, req.body.to, req.body.data);
  res.status(ok ? 204 : 409).end();
});

router.post('/meet/:token/action', actionLimiter, loadMeeting, peer, (req, res) => {
  const { action } = req.body;
  const cid = req.rtClient.cid;
  let ok = false;
  if (action === 'state') ok = rooms.setState(cid, req.body.state || {});
  else if (action === 'chat') {
    const text = str(req.body.text, 2000);
    ok = Boolean(text) && rooms.chat(cid, text);
  } else if (action === 'react') {
    ok = ['👍', '👏', '❤️', '😂', '🎉', '😮'].includes(req.body.emoji) && rooms.react(cid, req.body.emoji);
  } else if (['admit', 'deny', 'remove', 'mute', 'end'].includes(action)) ok = rooms.hostAction(cid, action, req.body.target);
  res.status(ok ? 204 : 409).end();
});

module.exports = router;
