'use strict';

// Live meeting rooms, held in memory. Media flows browser-to-browser over WebRTC; the server
// only relays the handshake (offers, answers, ICE candidates) and room state.
// Team members are hosts. Guests wait in a lobby until a host lets them in.

const rt = require('./realtime');

const rooms = new Map(); // meetingId -> { meetingId, peers: Map<cid, peer> }
const roomOf = new Map(); // cid -> meetingId
const startHooks = [];

const view = (p) => ({ cid: p.cid, name: p.name, userId: p.userId, host: p.host, mic: p.mic, cam: p.cam, sharing: p.sharing, hand: p.hand });

function getRoom(meetingId) {
  if (!rooms.has(meetingId)) rooms.set(meetingId, { meetingId, peers: new Map() });
  return rooms.get(meetingId);
}

const peersIn = (room, exceptCid) => [...room.peers.values()].filter((p) => p.state === 'in' && p.cid !== exceptCid);
const lobby = (room) => [...room.peers.values()].filter((p) => p.state === 'waiting');
const cidsIn = (room, exceptCid) => peersIn(room, exceptCid).map((p) => p.cid);
const hostCids = (room) => peersIn(room).filter((p) => p.host).map((p) => p.cid);

function sendLobby(room) {
  rt.publish({ cids: hostCids(room) }, 'room.lobby', { waiting: lobby(room).map(view) });
}

function peerOf(cid) {
  const meetingId = roomOf.get(cid);
  const room = meetingId && rooms.get(meetingId);
  const peer = room && room.peers.get(cid);
  return peer ? { room, peer } : null;
}

function admitInto(room, peer) {
  peer.state = 'in';
  if (peersIn(room).length === 1) for (const fn of startHooks) fn(room.meetingId);
  rt.publish({ cids: cidsIn(room, peer.cid) }, 'room.joined', { peer: view(peer) });
}

/** Adds a tab to a room. Returns what the joiner needs to set up its connections. */
function join(meetingId, { cid, name, userId, host, mic, cam }) {
  const room = getRoom(meetingId);
  const peer = { cid, name, userId: userId || null, host: Boolean(host), mic: Boolean(mic), cam: Boolean(cam), sharing: false, hand: false, state: 'waiting' };
  room.peers.set(cid, peer);
  roomOf.set(cid, meetingId);
  if (peer.host) {
    admitInto(room, peer);
    return { state: 'in', self: view(peer), peers: peersIn(room, cid).map(view), waiting: lobby(room).map(view) };
  }
  sendLobby(room);
  return { state: 'waiting', self: view(peer), hostsPresent: hostCids(room).length > 0 };
}

function leave(cid) {
  const found = peerOf(cid);
  roomOf.delete(cid);
  if (!found) return;
  const { room, peer } = found;
  room.peers.delete(cid);
  if (peer.state === 'in') rt.publish({ cids: cidsIn(room) }, 'room.left', { cid });
  sendLobby(room);
  if (!room.peers.size) rooms.delete(room.meetingId);
}

/** Host-only actions on another participant, plus ending the meeting for everyone. */
function hostAction(cid, action, targetCid) {
  const found = peerOf(cid);
  if (!found || !found.peer.host || found.peer.state !== 'in') return false;
  const { room } = found;
  if (action === 'end') {
    rt.publish({ cids: [...room.peers.keys()].filter((c) => c !== cid) }, 'room.ended', {});
    for (const c of [...room.peers.keys()]) roomOf.delete(c);
    rooms.delete(room.meetingId);
    return true;
  }
  const target = room.peers.get(String(targetCid || ''));
  if (!target || target.cid === cid) return false;
  if (action === 'admit' && target.state === 'waiting') {
    admitInto(room, target);
    rt.publish({ cids: [target.cid] }, 'room.admitted', { self: view(target), peers: peersIn(room, target.cid).map(view) });
    sendLobby(room);
    return true;
  }
  if (action === 'deny' && target.state === 'waiting') {
    rt.publish({ cids: [target.cid] }, 'room.denied', {});
    leave(target.cid);
    return true;
  }
  if (action === 'remove' && target.state === 'in') {
    rt.publish({ cids: [target.cid] }, 'room.removed', { by: found.peer.name });
    leave(target.cid);
    return true;
  }
  if (action === 'mute' && target.state === 'in') {
    rt.publish({ cids: [target.cid] }, 'room.mute', { by: found.peer.name });
    return true;
  }
  return false;
}

function setState(cid, patch) {
  const found = peerOf(cid);
  if (!found || found.peer.state !== 'in') return false;
  for (const k of ['mic', 'cam', 'sharing', 'hand']) if (k in patch) found.peer[k] = Boolean(patch[k]);
  rt.publish({ cids: cidsIn(found.room, cid) }, 'room.state', { peer: view(found.peer) });
  return true;
}

/** Relays an offer/answer/ICE candidate between two admitted participants of the same room. */
function signal(fromCid, toCid, data) {
  const from = peerOf(fromCid);
  const to = peerOf(String(toCid || ''));
  if (!from || !to || from.room !== to.room || from.peer.state !== 'in' || to.peer.state !== 'in') return false;
  rt.publish({ cids: [toCid] }, 'signal', { from: fromCid, data });
  return true;
}

function chat(cid, text) {
  const found = peerOf(cid);
  if (!found || found.peer.state !== 'in') return false;
  rt.publish({ cids: cidsIn(found.room) }, 'room.chat', { cid, name: found.peer.name, text, at: new Date().toISOString() });
  return true;
}

function react(cid, emoji) {
  const found = peerOf(cid);
  if (!found || found.peer.state !== 'in') return false;
  rt.publish({ cids: cidsIn(found.room) }, 'room.react', { cid, name: found.peer.name, emoji });
  return true;
}

/** Number of people currently in each live room, for "Live now" badges. */
function liveCounts() {
  const out = {};
  for (const room of rooms.values()) {
    const n = peersIn(room).length;
    if (n) out[room.meetingId] = n;
  }
  return out;
}

/** Names of the people in a room, for the "Ready to join?" screen. */
function whoIsIn(meetingId) {
  const room = rooms.get(meetingId);
  return room ? peersIn(room).map((p) => p.name) : [];
}

function onRoomStart(fn) {
  startHooks.push(fn);
}

rt.onDisconnect((c) => leave(c.cid));

module.exports = { join, leave, hostAction, setState, signal, chat, react, liveCounts, whoIsIn, onRoomStart, peerOf };
