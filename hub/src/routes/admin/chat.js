'use strict';

const express = require('express');
const { db } = require('../../db');
const rt = require('../../lib/realtime');
const chat = require('../../lib/chat');
const { createMeeting } = require('../../lib/meetings');
const { nowSql, str, int } = require('../../lib/util');
const { idParam } = require('./_helpers');

const router = express.Router();

const MAX_FILE = 8 * 1024 * 1024;
const ids = (v) => [].concat(v || []).map((x) => int(x, 0)).filter(Boolean);
const decode = (v) => {
  try { return decodeURIComponent(v || ''); } catch { return ''; }
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function team(userId) {
  return chat.activeStaff().whereNot('id', userId).orderBy('name').select('id', 'name', 'role');
}

/** Loads the channel into req.channel, or 404s when the user can't see it. */
async function channelParam(req, res, next) {
  const channel = await chat.accessibleChannel(req.user.id, idParam(req));
  if (!channel) return req.accepts(['html', 'json']) === 'json' ? res.status(404).json({ error: 'Not found' }) : next('route');
  req.channel = channel;
  next();
}

async function renderChat(req, res, channel) {
  const list = await chat.channelList(req.user.id);
  const data = { me: { id: req.user.id, name: req.user.name }, channelId: channel ? channel.id : null, messages: [], online: rt.onlineUsers() };
  let members = [];
  let current = null;
  if (channel) {
    current = [...list.channels, ...list.direct].find((c) => c.id === channel.id);
    members = await chat.members(channel.id);
    data.messages = await chat.fetchMessages(channel.id);
    data.members = members.map((m) => ({ id: m.id, name: m.name }));
    await chat.markRead(channel.id, req.user.id);
    if (current) {
      res.locals.counts.chat = Math.max(0, (res.locals.counts.chat || 0) - current.unread);
      current.unread = 0;
    }
  }
  res.render('admin/chat/index', {
    title: current ? (current.kind === 'channel' ? `#${current.label}` : current.label) : 'Chat',
    flush: true, scripts: ['chat'], list, current, members, team: await team(req.user.id), data,
  });
}

router.get('/', async (req, res) => {
  await chat.ensureMemberships(req.user.id);
  if (req.query.list) return renderChat(req, res, null);
  const { channels, direct } = await chat.channelList(req.user.id);
  const recent = [...direct, ...channels].sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0];
  res.redirect(`/admin/chat/${recent.id}`);
});

// Start a 1:1 chat (one person) or a group chat (several).
router.post('/new', async (req, res) => {
  const people = ids(req.body.user_ids).filter((id) => id !== req.user.id);
  const valid = await chat.activeStaff().whereIn('id', people.length ? people : [0]).pluck('id');
  if (!valid.length) {
    req.flash('error', 'Choose at least one person.');
    return res.redirect('/admin/chat');
  }
  const id = valid.length === 1
    ? await chat.directChannel(req.user.id, valid[0])
    : await chat.groupChannel(req.user.id, valid, str(req.body.name, 120));
  res.redirect(`/admin/chat/${id}`);
});

router.post('/channels', async (req, res) => {
  const name = slug(req.body.name);
  if (!name) {
    req.flash('error', 'Give the channel a name.');
    return res.redirect('/admin/chat');
  }
  if (await db('channels').where({ kind: 'channel', name }).first()) {
    req.flash('error', `#${name} already exists.`);
    return res.redirect('/admin/chat');
  }
  const isPrivate = Boolean(req.body.is_private);
  const [id] = await db('channels').insert({
    kind: 'channel', name, topic: str(req.body.topic, 255), is_private: isPrivate, created_by: req.user.id, created_at: nowSql(), last_message_at: nowSql(),
  });
  const memberIds = isPrivate
    ? await chat.activeStaff().whereIn('id', [req.user.id, ...ids(req.body.user_ids)]).pluck('id')
    : await chat.activeStaff().pluck('id');
  await chat.addMembers(id, memberIds);
  await chat.postMessage({ channelId: id, kind: 'system', body: `${req.user.name} created #${name}` });
  res.redirect(`/admin/chat/${id}`);
});

// Files are only served to people in the conversation they were shared in.
router.get('/files/:fid', async (req, res, next) => {
  const msg = await db('messages').where({ file_id: idParam(req, 'fid') }).whereNull('deleted_at').first();
  if (!msg || !(await chat.accessibleChannel(req.user.id, msg.channel_id))) return next('route');
  const file = await db('files').where({ id: msg.file_id }).first();
  const inline = chat.IMAGE_TYPES.includes(file.mime) && !req.query.download;
  res.set({
    'Content-Type': file.mime,
    'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(Buffer.from(file.data));
});

router.get('/:id', channelParam, (req, res) => renderChat(req, res, req.channel));

router.get('/:id/messages', channelParam, async (req, res) => {
  const messages = await chat.fetchMessages(req.channel.id, { before: int(req.query.before, 0), after: int(req.query.after, 0) });
  res.json({ messages });
});

router.post('/:id/messages', channelParam, async (req, res) => {
  const body = str(req.body.body, 5000);
  if (!body) return res.status(422).json({ error: 'Write a message first.' });
  const message = await chat.postMessage({ channelId: req.channel.id, userId: req.user.id, body });
  res.status(201).json({ message });
});

router.post('/:id/files', channelParam, express.raw({ type: () => true, limit: MAX_FILE }), async (req, res) => {
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return res.status(422).json({ error: 'The file is empty.' });
  const name = decode(req.get('x-file-name')).replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'file';
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('content-type') || '') ? req.get('content-type').toLowerCase() : 'application/octet-stream';
  const [fileId] = await db('files').insert({ name, mime, size: data.length, data, uploaded_by: req.user.id, created_at: nowSql() });
  const message = await chat.postMessage({
    channelId: req.channel.id, userId: req.user.id, fileId, body: str(decode(req.get('x-caption')), 5000) || '',
  });
  res.status(201).json({ message });
});

router.post('/:id/read', channelParam, async (req, res) => {
  await chat.markRead(req.channel.id, req.user.id, int(req.body.id, 0));
  res.status(204).end();
});

router.post('/:id/typing', channelParam, async (req, res) => {
  const others = (await chat.memberIds(req.channel.id)).filter((id) => id !== req.user.id);
  rt.publish({ users: others }, 'chat.typing', { channelId: req.channel.id, userId: req.user.id, name: req.user.name });
  res.status(204).end();
});

// Rename a channel or change its topic.
router.post('/:id/settings', channelParam, async (req, res) => {
  const c = req.channel;
  if (c.kind === 'dm') return res.redirect(`/admin/chat/${c.id}`);
  const patch = { topic: str(req.body.topic, 255) };
  if (c.kind === 'group') patch.name = str(req.body.name, 120);
  if (c.kind === 'channel') {
    const name = slug(req.body.name) || c.name;
    if (name !== c.name && await db('channels').where({ kind: 'channel', name }).whereNot('id', c.id).first()) {
      req.flash('error', `#${name} already exists.`);
      return res.redirect(`/admin/chat/${c.id}`);
    }
    patch.name = name;
  }
  await db('channels').where({ id: c.id }).update(patch);
  await chat.postMessage({ channelId: c.id, kind: 'system', body: `${req.user.name} updated the ${c.kind === 'channel' ? 'channel' : 'chat'} details` });
  res.redirect(`/admin/chat/${c.id}`);
});

router.post('/:id/members', channelParam, async (req, res) => {
  const c = req.channel;
  if (c.kind === 'dm' || (c.kind === 'channel' && !c.is_private)) return res.redirect(`/admin/chat/${c.id}`);
  const before = await chat.memberIds(c.id);
  const add = await chat.activeStaff().whereIn('id', ids(req.body.user_ids)).whereNotIn('id', before.length ? before : [0]).select('id', 'name');
  if (add.length) {
    await chat.addMembers(c.id, add.map((u) => u.id));
    await chat.postMessage({ channelId: c.id, kind: 'system', body: `${req.user.name} added ${add.map((u) => u.name).join(', ')}` });
  }
  res.redirect(`/admin/chat/${c.id}`);
});

router.post('/:id/leave', channelParam, async (req, res) => {
  const c = req.channel;
  if (c.kind === 'dm' || (c.kind === 'channel' && !c.is_private)) return res.redirect(`/admin/chat/${c.id}`);
  await db('channel_members').where({ channel_id: c.id, user_id: req.user.id }).del();
  await chat.postMessage({ channelId: c.id, kind: 'system', body: `${req.user.name} left` });
  req.flash('success', 'You left the conversation.');
  res.redirect('/admin/chat');
});

// Start a video call with everyone in this conversation: posts a Join card and rings their tabs.
router.post('/:id/call', channelParam, async (req, res) => {
  const c = req.channel;
  const memberIds = await chat.memberIds(c.id);
  const label = c.kind === 'channel' ? `#${c.name}` : c.name || 'Chat';
  const title = c.kind === 'dm' ? `Call with ${req.user.name}` : `${label} call`;
  const meetingId = await createMeeting({
    title, startsAt: nowSql(), duration: 30, allowGuests: false, createdBy: req.user.id, userIds: memberIds, channelId: c.id,
  });
  const meeting = await db('meetings').where({ id: meetingId }).first();
  await chat.postMessage({ channelId: c.id, userId: req.user.id, kind: 'call', body: `${req.user.name} started a call`, meetingId });
  rt.publish({ users: memberIds.filter((id) => id !== req.user.id) }, 'call.ring', {
    channelId: c.id, by: req.user.name, title, url: `/meet/${meeting.room_token}`,
  });
  const url = `/meet/${meeting.room_token}`;
  if (req.accepts(['html', 'json']) === 'json') return res.json({ url });
  res.redirect(url);
});

router.post('/messages/:mid/edit', async (req, res) => {
  const m = await db('messages').where({ id: idParam(req, 'mid'), user_id: req.user.id, kind: 'text' }).whereNull('deleted_at').first();
  const body = str(req.body.body, 5000);
  if (!m || !body) return res.status(404).json({ error: 'Not found' });
  await db('messages').where({ id: m.id }).update({ body, edited_at: nowSql() });
  res.json({ message: await chat.broadcastUpdate(m.id) });
});

router.post('/messages/:mid/delete', async (req, res) => {
  const m = await db('messages').where({ id: idParam(req, 'mid'), user_id: req.user.id }).whereNull('deleted_at').first();
  if (!m) return res.status(404).json({ error: 'Not found' });
  await db('messages').where({ id: m.id }).update({ deleted_at: nowSql(), body: null });
  if (m.file_id) await db('files').where({ id: m.file_id }).del();
  res.json({ message: await chat.broadcastUpdate(m.id) });
});

module.exports = router;
