'use strict';

const express = require('express');
const config = require('../../config');
const { db } = require('../../db');
const rt = require('../../lib/realtime');
const chat = require('../../lib/chat');
const { requireAdmin } = require('../../lib/auth');
const { sendMail } = require('../../lib/mailer');
const { nowSql, str } = require('../../lib/util');
const { paginate, idParam, back } = require('./_helpers');

const router = express.Router();

/** Announcements this user hasn't opened yet, pinned and important first. */
function unreadFor(userId) {
  return db('announcements as a').leftJoin('users as u', 'u.id', 'a.created_by')
    .whereNotExists(db('announcement_reads as r').whereRaw('r.announcement_id = a.id').where('r.user_id', userId))
    .orderBy('a.pinned', 'desc').orderBy('a.important', 'desc').orderBy('a.id', 'desc')
    .select('a.*', 'u.name as author_name');
}

async function markRead(userId, announcementIds) {
  if (!announcementIds.length) return;
  const seen = await db('announcement_reads').where({ user_id: userId }).whereIn('announcement_id', announcementIds).pluck('announcement_id');
  const rows = announcementIds.filter((id) => !seen.includes(id)).map((id) => ({ announcement_id: id, user_id: userId, read_at: nowSql() }));
  if (rows.length) await db('announcement_reads').insert(rows);
}

router.get('/', async (req, res) => {
  const query = db('announcements as a').leftJoin('users as u', 'u.id', 'a.created_by')
    .orderBy('a.pinned', 'desc').orderBy('a.id', 'desc').select('a.*', 'u.name as author_name');
  const page = await paginate(query, req, 20);
  const unread = new Set(await unreadFor(req.user.id).pluck('a.id'));
  for (const a of page.rows) a.unread = unread.has(a.id);

  // Read receipts for admins: who has seen each post.
  let receipts = {};
  let staffCount = 0;
  if (res.locals.isAdmin && page.rows.length) {
    const reads = await db('announcement_reads as r').join('users as u', 'u.id', 'r.user_id')
      .whereIn('r.announcement_id', page.rows.map((a) => a.id)).orderBy('r.read_at').select('r.announcement_id', 'u.name');
    receipts = reads.reduce((acc, r) => ({ ...acc, [r.announcement_id]: [...(acc[r.announcement_id] || []), r.name] }), {});
    staffCount = (await chat.activeStaff().count({ n: '*' }).first()).n;
  }
  await markRead(req.user.id, page.rows.map((a) => a.id));
  res.locals.counts.announcements = Math.max(0, (res.locals.counts.announcements || 0) - page.rows.filter((a) => a.unread).length);
  res.render('admin/announcements/index', { title: 'Announcements', ...page, receipts, staffCount: Number(staffCount) });
});

router.post('/', requireAdmin, async (req, res) => {
  const title = str(req.body.title, 190);
  const body = str(req.body.body, 10000);
  if (!title || !body) {
    req.flash('error', 'An announcement needs a title and a message.');
    return res.redirect('/admin/announcements');
  }
  const important = Boolean(req.body.important);
  const [id] = await db('announcements').insert({
    title, body, important, pinned: Boolean(req.body.pinned), created_by: req.user.id, created_at: nowSql(), updated_at: nowSql(),
  });
  await markRead(req.user.id, [id]);
  const staff = await chat.activeStaff().select('id', 'email');
  rt.publish({ users: staff.map((u) => u.id).filter((u) => u !== req.user.id) }, 'announcement', { id, title, important, by: req.user.name });
  let sent = 0;
  if (req.body.email) {
    for (const u of staff.filter((s) => s.id !== req.user.id)) {
      const ok = await sendMail({
        to: u.email, subject: `${important ? '[Important] ' : ''}${title}`, related: ['announcement', id], replyTo: req.user.email,
        heading: title, lines: [...body.split(/\n+/), `— ${req.user.name}`],
        button: { label: 'Open in Haptags Hub', url: `${config.baseUrl}/admin/announcements` },
      });
      if (ok) sent += 1;
    }
  }
  req.flash('success', sent ? `Announcement posted and emailed to ${sent} ${sent === 1 ? 'person' : 'people'}.` : 'Announcement posted.');
  res.redirect('/admin/announcements');
});

router.post('/:id/pin', requireAdmin, async (req, res) => {
  const a = await db('announcements').where({ id: idParam(req) }).first();
  if (a) await db('announcements').where({ id: a.id }).update({ pinned: !a.pinned, updated_at: nowSql() });
  res.redirect('/admin/announcements');
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  await db('announcements').where({ id: idParam(req) }).del();
  req.flash('success', 'Announcement deleted.');
  res.redirect('/admin/announcements');
});

// "Got it" from the dashboard banner.
router.post('/:id/read', async (req, res) => {
  await markRead(req.user.id, [idParam(req)]);
  if (req.accepts(['html', 'json']) === 'json') return res.status(204).end();
  res.redirect(back(req, '/admin'));
});

module.exports = router;
module.exports.unreadFor = unreadFor;
