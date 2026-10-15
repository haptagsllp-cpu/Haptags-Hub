'use strict';

const { db } = require('../db');
const rt = require('./realtime');
const { STAFF_ROLES } = require('./auth');
const { nowSql } = require('./util');

const PAGE = 60;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const iso = (v) => (v ? `${String(v).replace(' ', 'T')}Z` : null);

const activeStaff = () => db('users').whereIn('role', STAFF_ROLES).where({ is_active: true });

async function lastMessageId(channelId) {
  const row = await db('messages').where({ channel_id: channelId }).max({ m: 'id' }).first();
  return Number(row.m || 0);
}

async function addMembers(channelId, userIds) {
  const existing = await db('channel_members').where({ channel_id: channelId }).pluck('user_id');
  const lastId = await lastMessageId(channelId);
  const rows = [...new Set(userIds.map(Number))].filter((id) => id && !existing.includes(id))
    .map((user_id) => ({ channel_id: channelId, user_id, last_read_id: lastId, joined_at: nowSql() }));
  if (rows.length) await db('channel_members').insert(rows);
}

/** Creates #general on first use and adds the user to every public channel they're missing. */
async function ensureMemberships(userId) {
  const any = await db('channels').where({ kind: 'channel' }).first();
  if (!any) {
    const [id] = await db('channels').insert({ kind: 'channel', name: 'general', topic: 'Company-wide chat', created_at: nowSql(), last_message_at: nowSql() });
    await addMembers(id, await activeStaff().pluck('id'));
  }
  const missing = await db('channels as c').where({ 'c.kind': 'channel', 'c.is_private': false })
    .whereNotExists(db('channel_members as m').whereRaw('m.channel_id = c.id').where('m.user_id', userId)).pluck('c.id');
  for (const id of missing) await addMembers(id, [userId]);
}

/** The channel if this user may read it; public channels add the user on first visit. */
async function accessibleChannel(userId, channelId) {
  const channel = await db('channels').where({ id: channelId }).first();
  if (!channel) return null;
  const member = await db('channel_members').where({ channel_id: channelId, user_id: userId }).first();
  if (member) return channel;
  if (channel.kind === 'channel' && !channel.is_private) {
    await addMembers(channelId, [userId]);
    return channel;
  }
  return null;
}

const memberIds = (channelId) => db('channel_members').where({ channel_id: channelId }).pluck('user_id');

async function members(channelId) {
  return db('channel_members as m').join('users as u', 'u.id', 'm.user_id').where('m.channel_id', channelId)
    .orderBy('u.name').select('u.id', 'u.name', 'u.role', 'u.email');
}

/** Sidebar list: every conversation the user is in, with unread counts and names for DMs. */
async function channelList(userId) {
  const rows = await db('channels as c').join('channel_members as m', 'm.channel_id', 'c.id').where('m.user_id', userId)
    .select('c.*', 'm.last_read_id')
    .select(db.raw('(select count(*) from messages x where x.channel_id = c.id and x.id > m.last_read_id and x.deleted_at is null and (x.user_id is null or x.user_id <> ?)) as unread', [userId]));
  const ids = rows.filter((r) => r.kind !== 'channel').map((r) => r.id);
  const others = ids.length
    ? await db('channel_members as m').join('users as u', 'u.id', 'm.user_id').whereIn('m.channel_id', ids).whereNot('m.user_id', userId)
      .orderBy('u.name').select('m.channel_id', 'u.id', 'u.name')
    : [];
  for (const r of rows) {
    r.unread = Number(r.unread || 0);
    if (r.kind === 'channel') {
      r.label = r.name;
    } else {
      const people = others.filter((o) => o.channel_id === r.id);
      r.people = people;
      r.label = r.kind === 'group' && r.name ? r.name : people.map((p) => p.name.split(' ')[0]).join(', ') || 'Just you';
      if (r.kind === 'dm' && people[0]) { r.label = people[0].name; r.otherId = people[0].id; }
    }
  }
  const byRecent = (a, b) => String(b.last_message_at || b.created_at).localeCompare(String(a.last_message_at || a.created_at));
  return {
    channels: rows.filter((r) => r.kind === 'channel').sort((a, b) => a.label.localeCompare(b.label)),
    direct: rows.filter((r) => r.kind !== 'channel').sort(byRecent),
  };
}

async function unreadTotal(userId) {
  const row = await db('messages as x').join('channel_members as m', 'm.channel_id', 'x.channel_id')
    .where('m.user_id', userId).whereRaw('x.id > m.last_read_id').whereNull('x.deleted_at')
    .where((w) => w.whereNull('x.user_id').orWhereNot('x.user_id', userId)).count({ n: '*' }).first();
  return Number(row.n || 0);
}

function shape(m) {
  const deleted = Boolean(m.deleted_at);
  return {
    id: m.id,
    channelId: m.channel_id,
    userId: m.user_id,
    userName: m.user_name || 'Someone',
    kind: m.kind,
    body: deleted ? '' : m.body || '',
    file: !deleted && m.file_id ? { id: m.file_id, name: m.file_name, mime: m.file_mime, size: m.file_size, image: IMAGE_TYPES.includes(m.file_mime) } : null,
    meeting: m.meeting_id && m.meeting_token ? { id: m.meeting_id, url: `/meet/${m.meeting_token}`, title: m.meeting_title } : null,
    createdAt: iso(m.created_at),
    edited: Boolean(m.edited_at),
    deleted,
  };
}

function messageQuery() {
  return db('messages as m').leftJoin('users as u', 'u.id', 'm.user_id').leftJoin('files as f', 'f.id', 'm.file_id')
    .leftJoin('meetings as mt', 'mt.id', 'm.meeting_id')
    .select('m.*', 'u.name as user_name', 'f.name as file_name', 'f.mime as file_mime', 'f.size as file_size',
      'mt.room_token as meeting_token', 'mt.title as meeting_title');
}

/** Newest page by default; `before` pages back, `after` catches up. Always oldest first. */
async function fetchMessages(channelId, { before, after } = {}) {
  const q = messageQuery().where('m.channel_id', channelId);
  if (after) return (await q.where('m.id', '>', after).orderBy('m.id').limit(500)).map(shape);
  if (before) q.where('m.id', '<', before);
  const rows = await q.orderBy('m.id', 'desc').limit(PAGE);
  return rows.reverse().map(shape);
}

async function getMessage(id) {
  const row = await messageQuery().where('m.id', id).first();
  return row ? shape(row) : null;
}

async function markRead(channelId, userId, upTo) {
  const id = upTo || (await lastMessageId(channelId));
  await db('channel_members').where({ channel_id: channelId, user_id: userId }).where('last_read_id', '<', id).update({ last_read_id: id });
}

async function postMessage({ channelId, userId = null, body = '', kind = 'text', fileId = null, meetingId = null }) {
  const now = nowSql();
  const [id] = await db('messages').insert({ channel_id: channelId, user_id: userId, kind, body, file_id: fileId, meeting_id: meetingId, created_at: now });
  await db('channels').where({ id: channelId }).update({ last_message_at: now });
  if (userId) await markRead(channelId, userId, id);
  const message = await getMessage(id);
  rt.publish({ users: await memberIds(channelId) }, 'chat.message', { channelId, message });
  return message;
}

async function broadcastUpdate(messageId) {
  const message = await getMessage(messageId);
  if (message) rt.publish({ users: await memberIds(message.channelId) }, 'chat.update', { channelId: message.channelId, message });
  return message;
}

/** The one 1:1 chat between two people, created on first use. */
async function directChannel(userId, otherId) {
  const [a, b] = [Number(userId), Number(otherId)].sort((x, y) => x - y);
  const key = `${a}:${b}`;
  const found = await db('channels').where({ dm_key: key }).first();
  if (found) return found.id;
  const [id] = await db('channels').insert({ kind: 'dm', dm_key: key, is_private: true, created_by: userId, created_at: nowSql() });
  await addMembers(id, [a, b]);
  return id;
}

async function groupChannel(userId, userIds, name) {
  const [id] = await db('channels').insert({ kind: 'group', name: name || null, is_private: true, created_by: userId, created_at: nowSql() });
  await addMembers(id, [userId, ...userIds]);
  return id;
}

module.exports = {
  IMAGE_TYPES, activeStaff, ensureMemberships, accessibleChannel, addMembers, memberIds, members, channelList, unreadTotal,
  fetchMessages, getMessage, markRead, postMessage, broadcastUpdate, directChannel, groupChannel,
};
