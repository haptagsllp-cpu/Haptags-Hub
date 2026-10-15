'use strict';

// In-process event bus for chat, notifications and video-call signalling. Browsers long-poll
// /api/rt/poll, which works behind any proxy (WebSockets often don't on shared hosting).
// Events stay in memory for a few minutes. The database stays the source of truth, so after a
// restart clients reconnect and reload what they missed.

const { randomToken, safeEqual } = require('./util');

const KEEP_MS = 3 * 60 * 1000;
const MAX_EVENTS = 5000;
const WAIT_MS = 25 * 1000;
const STALE_MS = 45 * 1000;

let seq = 0;
let dropped = 0; // highest seq no longer in memory
const events = []; // { seq, at, users, cids, type, data }
const clients = new Map(); // cid -> { cid, key, userId, name, lastSeen, waiter }
const disconnectHooks = [];

/** Registers a browser tab. `key` is its secret; `cid` is safe to share with other participants. */
function connect({ userId = null, name = '' } = {}) {
  const cid = randomToken(8);
  const key = randomToken(16);
  clients.set(cid, { cid, key, userId: userId ? Number(userId) : null, name, lastSeen: Date.now(), waiter: null });
  return { cid, key, seq };
}

function auth(cid, key) {
  const c = clients.get(String(cid || ''));
  return c && key && safeEqual(String(key), c.key) ? c : null;
}

const matches = (e, c) => (e.cids && e.cids.includes(c.cid)) || Boolean(e.users && c.userId && e.users.includes(c.userId));

function onlineUsers() {
  const cutoff = Date.now() - STALE_MS;
  const ids = new Set();
  for (const c of clients.values()) if (c.userId && (c.waiter || c.lastSeen > cutoff)) ids.add(c.userId);
  return [...ids];
}

function pending(c, after) {
  return events.filter((e) => e.seq > after && matches(e, c)).map((e) => ({ seq: e.seq, type: e.type, data: e.data }));
}

function respond(c, payload) {
  const w = c.waiter;
  if (!w) return;
  c.waiter = null;
  c.lastSeen = Date.now();
  clearTimeout(w.timer);
  if (!w.res.headersSent) w.res.json({ seq, online: onlineUsers(), ...payload });
}

/** Sends `data` to every tab of the given users and/or to specific tabs. */
function publish({ users = null, cids = null }, type, data = {}) {
  const u = users ? [...new Set(users.filter(Boolean).map(Number))] : [];
  const k = cids ? cids.filter(Boolean) : [];
  if (!u.length && !k.length) return;
  seq += 1;
  const e = { seq, at: Date.now(), users: u.length ? u : null, cids: k.length ? k : null, type, data };
  events.push(e);
  while (events.length && (events.length > MAX_EVENTS || e.at - events[0].at > KEEP_MS)) dropped = events.shift().seq;
  for (const c of clients.values()) {
    if (c.waiter && matches(e, c)) respond(c, { events: pending(c, c.waiter.after) });
  }
}

/** Answers at once if something is waiting, otherwise holds the request for up to WAIT_MS. */
function poll(c, after, res) {
  c.lastSeen = Date.now();
  respond(c, { events: [] }); // a newer poll from the same tab replaces the old one
  const from = Number.isFinite(after) ? after : seq;
  if (from < dropped || from > seq) return res.json({ seq, online: onlineUsers(), events: [], reset: true });
  const ready = pending(c, from);
  if (ready.length) return res.json({ seq, online: onlineUsers(), events: ready });
  const timer = setTimeout(() => respond(c, { events: [] }), WAIT_MS);
  c.waiter = { after: from, res, timer };
  res.on('close', () => {
    if (c.waiter && c.waiter.res === res) {
      clearTimeout(c.waiter.timer);
      c.waiter = null;
      c.lastSeen = Date.now();
    }
  });
}

function disconnect(cid) {
  const c = clients.get(cid);
  if (!c) return;
  respond(c, { events: [], gone: true });
  clients.delete(cid);
  for (const fn of disconnectHooks) {
    try { fn(c); } catch (err) { console.error('[realtime] disconnect hook', err); }
  }
}

function onDisconnect(fn) {
  disconnectHooks.push(fn);
}

// Tabs that stop polling (closed, offline, asleep) are dropped after STALE_MS.
setInterval(() => {
  const cutoff = Date.now() - STALE_MS;
  for (const c of [...clients.values()]) if (!c.waiter && c.lastSeen < cutoff) disconnect(c.cid);
}, 10 * 1000).unref();

module.exports = { connect, auth, poll, publish, disconnect, onDisconnect, onlineUsers, STALE_MS };
