/*
 * Haptags Hub: video meetings. Every participant connects directly to every other one (WebRTC
 * mesh), which suits calls of up to about 6–8 people. The server only relays the connection
 * handshake through /meet/:token/signal; audio and video never pass through it.
 */
(function () {
  'use strict';

  var RT = window.HubRT;
  var cfg = JSON.parse(document.getElementById('room-data').textContent);
  var base = '/meet/' + cfg.token;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var S = {
    stream: new MediaStream(), // our camera + mic
    camTrack: null, micTrack: null, screenTrack: null,
    mic: true, cam: true, sharing: false, hand: false,
    cid: null, key: null, self: null, channel: null,
    peers: {}, // cid -> { info, pc, stream, tile, polite, makingOffer, ignoreOffer, pendingIce }
    joinedAt: 0, panel: null, unread: 0, left: false, audioCtx: null,
  };
  if (location.hash === '#debug') window.meetDebug = S;

  function stage(name) { $$('[data-stage]').forEach(function (s) { s.hidden = s.getAttribute('data-stage') !== name; }); }
  function initials(name) { return String(name || '?').split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }
  function toast(title, body, tone) { if (RT) RT.toast({ title: title, body: body, tone: tone }); }

  function api(path, data) {
    return RT.post(base + path, Object.assign({ cid: S.cid, key: S.key }, data || {}));
  }

  // ---------------- Devices ----------------
  var AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  var VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };

  function getMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error(location.protocol === 'https:' || location.hostname === 'localhost' ? 'unsupported' : 'insecure'));
    }
    var gum = function (c) { return navigator.mediaDevices.getUserMedia(c); };
    return gum({ audio: AUDIO, video: VIDEO })
      .catch(function () { return gum({ audio: AUDIO }); })
      .catch(function () { return gum({ video: VIDEO }); });
  }

  function useStream(stream) {
    stream.getTracks().forEach(function (t) {
      S.stream.addTrack(t);
      if (t.kind === 'audio') S.micTrack = t; else S.camTrack = t;
    });
  }

  var preview = $('[data-preview]');
  var mediaMsg = $('[data-media-msg]');
  function paintPreview() {
    var camOn = S.cam && S.camTrack;
    preview.srcObject = S.stream;
    preview.hidden = !camOn;
    $('[data-preview-off]').hidden = Boolean(camOn);
    $('[data-pre="mic"]').classList.toggle('off', !S.mic || !S.micTrack);
    $('[data-pre="cam"]').classList.toggle('off', !camOn);
    $('[data-pre="mic"]').setAttribute('aria-pressed', String(S.mic && Boolean(S.micTrack)));
    $('[data-pre="cam"]').setAttribute('aria-pressed', String(Boolean(camOn)));
  }

  getMedia().then(function (stream) {
    useStream(stream);
    var parts = [];
    if (!S.micTrack) parts.push('No microphone found, so others won’t hear you.');
    if (!S.camTrack) parts.push('No camera found. You can still join with audio.');
    mediaMsg.textContent = parts.join(' ') || 'Camera and microphone are ready.';
  }).catch(function (err) {
    S.mic = false; S.cam = false;
    mediaMsg.textContent = err && err.message === 'insecure'
      ? 'Camera and microphone only work over https.'
      : 'Camera and microphone are blocked. You can still join to watch and listen. To fix it, allow access from the lock icon in the address bar, then reload.';
  }).then(paintPreview);

  $$('[data-pre]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-pre');
      if (kind === 'mic' && S.micTrack) { S.mic = !S.mic; S.micTrack.enabled = S.mic; }
      if (kind === 'cam' && S.camTrack) { S.cam = !S.cam; S.camTrack.enabled = S.cam; }
      paintPreview();
    });
  });
  var nameInput = $('#join-name');
  nameInput.addEventListener('input', function () { $('[data-preview-initials]').textContent = initials(nameInput.value); });

  // ---------------- Join ----------------
  $('[data-join-form]').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameInput.value.trim();
    var errEl = $('[data-join-error]');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Enter your name so others know who you are.'; nameInput.focus(); return; }
    var btn = $('[data-join-btn]');
    btn.disabled = true; btn.textContent = 'Joining…';
    try { S.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (x) { /* speaking rings are optional */ }
    RT.post(base + '/join', { name: name, mic: S.mic && Boolean(S.micTrack), cam: S.cam && Boolean(S.camTrack) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not join'); return j; }); })
      .then(function (res) {
        S.cid = res.cid; S.key = res.key; S.self = res.self;
        S.channel = new RT.Channel({
          onEvent: onEvent,
          onLost: function () { if (!S.left) end('Connection lost', 'The connection to the server dropped. Rejoin to continue.'); return true; },
        });
        S.channel.start({ cid: res.cid, key: res.key, seq: res.seq });
        window.addEventListener('pagehide', beacon);
        if (res.state === 'in') enterCall(res.peers, res.waiting);
        else {
          stage('waiting');
          if (!res.hostsPresent) $('[data-wait-msg]').textContent = 'Nobody from the team is here yet. We’ve let them know you’re waiting.';
        }
      })
      .catch(function (err) {
        errEl.textContent = err.message === 'Failed to fetch' ? 'Couldn’t reach the server. Check your connection.' : err.message;
        btn.disabled = false; btn.textContent = 'Join now';
      });
  });

  function beacon() {
    if (S.left || !S.cid) return;
    var body = new URLSearchParams({ _csrf: RT.csrf, cid: S.cid, key: S.key });
    if (navigator.sendBeacon) navigator.sendBeacon(base + '/leave', body);
  }

  // ---------------- In the call ----------------
  var grid = $('[data-grid]');
  var tpl = $('#tile-tpl');

  function enterCall(peers, waiting) {
    stage('call');
    S.joinedAt = Date.now();
    setInterval(clock, 1000);
    addTile('self', S.self.name + ' (you)', S.stream, true);
    paintControls();
    (peers || []).forEach(function (p) { addPeer(p, true); });
    renderLobby(waiting || []);
    paintPeople();
    if (!window.RTCPeerConnection) toast('Video calls aren’t supported in this browser', 'Use a recent Chrome, Edge, Safari or Firefox.', 'important');
  }

  function clock() {
    var s = Math.floor((Date.now() - S.joinedAt) / 1000);
    var h = Math.floor(s / 3600); var m = Math.floor((s % 3600) / 60); var sec = s % 60;
    $('[data-clock]').textContent = (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(sec).padStart(2, '0');
  }

  function addTile(id, name, stream, isSelf) {
    var tile = tpl.content.firstElementChild.cloneNode(true);
    tile.setAttribute('data-tile', id);
    if (isSelf) tile.classList.add('self');
    $('.avatar', tile).textContent = initials(name);
    $('[data-name]', tile).textContent = name;
    var video = $('video', tile);
    video.srcObject = stream;
    if (isSelf) video.muted = true;
    video.addEventListener('loadedmetadata', function () {
      var p = video.play();
      if (p && p.catch) p.catch(function (err) { if (err && err.name === 'NotAllowedError') showUnmuteHint(video); });
    });
    grid.appendChild(tile);
    layout();
    return tile;
  }

  var unmuteShown = false;
  function showUnmuteHint(video) {
    if (unmuteShown) return;
    unmuteShown = true;
    RT.toast({ title: 'Click to hear the meeting', body: 'Your browser paused the sound.', sticky: true, actions: [{ label: 'Turn on sound', primary: true, onClick: function () { $$('video', grid).forEach(function (v) { v.play().catch(function () {}); }); unmuteShown = false; } }] });
    video.play().catch(function () {});
  }

  function layout() {
    var tiles = $$('.tile', grid);
    grid.setAttribute('data-n', Math.min(tiles.length, 9));
    var spot = tiles.filter(function (t) { return t.classList.contains('sharing') && !t.classList.contains('self'); })[0];
    grid.classList.toggle('has-spotlight', Boolean(spot));
    tiles.forEach(function (t) { t.classList.toggle('spotlight', t === spot); });
    $('[data-count]').textContent = tiles.length;
  }

  function paintTile(tile, info, hasVideo) {
    tile.classList.toggle('muted', !info.mic);
    tile.classList.toggle('cam-off', !info.cam && !info.sharing);
    tile.classList.toggle('sharing', Boolean(info.sharing));
    tile.classList.toggle('hand', Boolean(info.hand));
    if (hasVideo === false) tile.classList.add('cam-off');
  }

  function paintSelf() {
    var t = $('[data-tile="self"]');
    if (!t) return;
    paintTile(t, { mic: S.mic && S.micTrack, cam: S.cam && S.camTrack, sharing: S.sharing, hand: S.hand });
    var v = $('video', t);
    var want = S.sharing && S.screenTrack ? (S.screenStream = S.screenStream || new MediaStream([S.screenTrack])) : S.stream;
    v.classList.toggle('mirror', !S.sharing);
    if (v.srcObject !== want) v.srcObject = want;
    layout();
  }

  // ---------------- Peer connections (perfect negotiation) ----------------
  function addPeer(info, initiator) {
    if (S.peers[info.cid]) return S.peers[info.cid];
    var pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
    var p = {
      info: info, pc: pc, stream: new MediaStream(), pendingIce: [],
      polite: S.cid < info.cid, makingOffer: false, ignoreOffer: false,
    };
    S.peers[info.cid] = p;
    p.tile = addTile(info.cid, info.name, p.stream, false);
    paintTile(p.tile, info);
    status(p, 'Connecting…');

    pc.ontrack = function (e) {
      p.stream.getTracks().filter(function (t) { return t.kind === e.track.kind; }).forEach(function (t) { p.stream.removeTrack(t); });
      p.stream.addTrack(e.track);
      var v = $('video', p.tile);
      if (v.srcObject !== p.stream) v.srcObject = p.stream;
      if (v.paused) v.play().catch(function (err) { if (err && err.name === 'NotAllowedError') showUnmuteHint(v); });
      if (e.track.kind === 'audio') watchVolume(p.tile, e.track);
    };
    pc.onicecandidate = function (e) { if (e.candidate) signal(info.cid, { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onnegotiationneeded = function () {
      p.makingOffer = true;
      pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () { signal(info.cid, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); })
        .catch(function (err) { console.error('offer', err); })
        .then(function () { p.makingOffer = false; });
    };
    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === 'connected') status(p, '');
      else if (st === 'disconnected') status(p, 'Reconnecting…');
      else if (st === 'failed') {
        status(p, 'Can’t connect. Their network may be blocking calls.');
        if (pc.restartIce) pc.restartIce();
      }
    };

    // Whoever joins later sets up the audio and video lanes; the other side answers. The lanes
    // stay fixed for the whole call, so switching camera ⇄ screen never needs renegotiation.
    if (initiator) {
      pc.addTransceiver(S.micTrack || 'audio', { direction: 'sendrecv', streams: [S.stream] });
      pc.addTransceiver(currentVideo() || 'video', { direction: 'sendrecv', streams: [S.stream] });
    }
    return p;
  }

  function currentVideo() { return S.sharing ? S.screenTrack : S.camTrack; }

  /** After an offer arrives, send our own tracks on the lanes it created. */
  function attachLocal(p) {
    p.pc.getTransceivers().forEach(function (t) {
      var kind = t.receiver.track && t.receiver.track.kind;
      if (!kind || t.stopped) return;
      if (t.direction === 'recvonly' || t.direction === 'inactive') t.direction = 'sendrecv';
      var track = kind === 'audio' ? S.micTrack : currentVideo();
      if (t.sender.track !== track) t.sender.replaceTrack(track || null).catch(function () {});
    });
  }

  function videoSenders() {
    var out = [];
    Object.keys(S.peers).forEach(function (cid) {
      S.peers[cid].pc.getTransceivers().forEach(function (t) {
        if (t.receiver.track && t.receiver.track.kind === 'video' && !t.stopped) out.push(t);
      });
    });
    return out;
  }

  function onSignal(from, data) {
    var p = S.peers[from];
    if (!p) return;
    var pc = p.pc;
    if (data.description) {
      var d = data.description;
      var collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      var ready = collision && pc.signalingState !== 'stable'
        ? pc.setLocalDescription({ type: 'rollback' }).then(function () { return pc.setRemoteDescription(d); })
        : pc.setRemoteDescription(d);
      ready.then(function () {
        p.pendingIce.splice(0).forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
        if (d.type !== 'offer') return null;
        attachLocal(p);
        return pc.createAnswer().then(function (a) { return pc.setLocalDescription(a); }).then(function () {
          signal(from, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        });
      }).catch(function (err) { console.error('description', err); });
    } else if (data.candidate) {
      if (!pc.remoteDescription) p.pendingIce.push(data.candidate);
      else pc.addIceCandidate(data.candidate).catch(function (err) { if (!p.ignoreOffer) console.warn('ice', err); });
    }
  }

  function signal(to, data) {
    api('/signal', { to: to, data: data }).catch(function () {});
  }

  function status(p, text) {
    var el = $('.tile-status', p.tile);
    el.textContent = text; el.hidden = !text;
  }

  function removePeer(cid) {
    var p = S.peers[cid];
    if (!p) return;
    try { p.pc.close(); } catch (e) { /* already closed */ }
    if (p.tile) p.tile.remove();
    delete S.peers[cid];
    layout(); paintPeople();
  }

  // Speaking ring: a cheap volume meter per audio track.
  function watchVolume(tile, track) {
    if (!S.audioCtx) return;
    try {
      var src = S.audioCtx.createMediaStreamSource(new MediaStream([track]));
      var an = S.audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      var buf = new Uint8Array(an.fftSize);
      var iv = setInterval(function () {
        if (!tile.isConnected || track.readyState === 'ended') { clearInterval(iv); return; }
        an.getByteTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i += 1) { var v = (buf[i] - 128) / 128; sum += v * v; }
        tile.classList.toggle('speaking', Math.sqrt(sum / buf.length) > 0.04 && !tile.classList.contains('muted'));
      }, 200);
    } catch (e) { /* optional */ }
  }

  // ---------------- Events from the server ----------------
  function onEvent(e) {
    var d = e.data || {};
    switch (e.type) {
      case 'room.joined':
        addPeer(d.peer, false); paintPeople();
        toast(d.peer.name + ' joined');
        break;
      case 'room.left': {
        var who = S.peers[d.cid];
        removePeer(d.cid);
        if (who) toast(who.info.name + ' left');
        break;
      }
      case 'signal': onSignal(d.from, d.data || {}); break;
      case 'room.state': {
        var p = S.peers[d.peer.cid];
        if (!p) break;
        var raised = d.peer.hand && !p.info.hand;
        p.info = d.peer;
        paintTile(p.tile, d.peer); layout(); paintPeople();
        if (raised) { toast('✋ ' + d.peer.name + ' raised their hand'); RT.chime(1); }
        break;
      }
      case 'room.chat': addChat(d); break;
      case 'room.react': floatReaction(d.cid === S.cid ? 'self' : d.cid, d.emoji); break;
      case 'room.lobby': renderLobby(d.waiting); break;
      case 'room.admitted': S.self = d.self; enterCall(d.peers, []); break;
      case 'room.denied': end('You weren’t let in', 'The meeting host declined your request to join.', true); break;
      case 'room.removed': end('You were removed', (d.by || 'The host') + ' removed you from the meeting.', true); break;
      case 'room.ended': end('The meeting has ended', 'The host ended the meeting for everyone.', true); break;
      case 'room.mute':
        if (S.mic && S.micTrack) toggleMic();
        toast((d.by || 'The host') + ' muted you', 'Unmute when you want to speak.');
        break;
      default: break;
    }
  }

  // ---------------- Controls ----------------
  function sendState() {
    api('/action', { action: 'state', state: { mic: S.mic && Boolean(S.micTrack), cam: S.cam && Boolean(S.camTrack), sharing: S.sharing, hand: S.hand } });
  }

  function paintControls() {
    var set = function (name, on, label) {
      var b = $('[data-ctl="' + name + '"]');
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', String(on));
      if (label) $('.ctl-label', b).textContent = label;
    };
    set('mic', S.mic && Boolean(S.micTrack), S.mic && S.micTrack ? 'Mute' : 'Unmute');
    set('cam', S.cam && Boolean(S.camTrack), S.cam && S.camTrack ? 'Stop video' : 'Start video');
    var share = $('[data-ctl="share"]');
    share.classList.toggle('active', S.sharing);
    $('.ctl-label', share).textContent = S.sharing ? 'Stop sharing' : 'Share';
    share.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    var hand = $('[data-ctl="hand"]');
    hand.classList.toggle('active', S.hand);
    $('.ctl-label', hand).textContent = S.hand ? 'Lower' : 'Raise';
    paintSelf();
  }

  /** Asks for a device we didn't get at the start (e.g. the camera was blocked, then allowed). */
  function acquire(kind) {
    return navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: AUDIO } : { video: VIDEO }).then(function (s) {
      var track = s.getTracks()[0];
      useStream(s);
      Object.keys(S.peers).forEach(function (cid) {
        S.peers[cid].pc.getTransceivers().forEach(function (t) {
          if (t.receiver.track && t.receiver.track.kind === kind && !(kind === 'video' && S.sharing)) t.sender.replaceTrack(track).catch(function () {});
        });
      });
      return track;
    });
  }

  function toggleMic() {
    if (!S.micTrack) {
      return acquire('audio').then(function () { S.mic = true; paintControls(); sendState(); })
        .catch(function () { toast('Microphone blocked', 'Allow microphone access from the address bar, then try again.', 'important'); });
    }
    S.mic = !S.mic; S.micTrack.enabled = S.mic;
    paintControls(); sendState();
    return null;
  }

  function toggleCam() {
    if (!S.camTrack) {
      return acquire('video').then(function () { S.cam = true; paintControls(); sendState(); })
        .catch(function () { toast('Camera blocked', 'Allow camera access from the address bar, then try again.', 'important'); });
    }
    S.cam = !S.cam; S.camTrack.enabled = S.cam;
    paintControls(); sendState();
    return null;
  }

  function startShare() {
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false }).then(function (s) {
      S.screenTrack = s.getVideoTracks()[0];
      if ('contentHint' in S.screenTrack) S.screenTrack.contentHint = 'detail';
      S.screenTrack.addEventListener('ended', stopShare);
      S.sharing = true;
      videoSenders().forEach(function (t) { t.sender.replaceTrack(S.screenTrack).catch(function () {}); });
      paintControls(); sendState();
    }).catch(function () { /* cancelled */ });
  }

  function stopShare() {
    if (!S.sharing) return;
    S.sharing = false;
    if (S.screenTrack) S.screenTrack.stop();
    S.screenTrack = null; S.screenStream = null;
    videoSenders().forEach(function (t) { t.sender.replaceTrack(S.camTrack || null).catch(function () {}); });
    paintControls(); sendState();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ctl]');
    if (b) {
      var c = b.getAttribute('data-ctl');
      if (c === 'mic') toggleMic();
      else if (c === 'cam') toggleCam();
      else if (c === 'share') { if (S.sharing) stopShare(); else startShare(); }
      else if (c === 'hand') { S.hand = !S.hand; paintControls(); sendState(); }
      else if (c === 'chat') openPanel(S.panel === 'chat' ? null : 'chat');
      else if (c === 'react') $('[data-react-pop]').hidden = !$('[data-react-pop]').hidden;
      return;
    }
    var em = e.target.closest('[data-emoji]');
    if (em) {
      $('[data-react-pop]').hidden = true;
      api('/action', { action: 'react', emoji: em.getAttribute('data-emoji') });
      floatReaction('self', em.getAttribute('data-emoji'));
      return;
    }
    if (!e.target.closest('.react-wrap')) { var pop = $('[data-react-pop]'); if (pop) pop.hidden = true; }
    var pb = e.target.closest('[data-panel-btn]');
    if (pb) { var which = pb.getAttribute('data-panel-btn'); openPanel(S.panel === which && pb.closest('.call-top') ? null : which); return; }
    if (e.target.closest('[data-panel-close]')) { openPanel(null); return; }
    if (e.target.closest('[data-leave]')) { leave(); return; }
    if (e.target.closest('[data-end]')) {
      if (window.confirm('End the meeting for everyone?')) api('/action', { action: 'end' }).then(function () { leave('The meeting has ended', 'You ended the meeting for everyone.'); });
      return;
    }
    var host = e.target.closest('[data-host-action]');
    if (host) {
      api('/action', { action: host.getAttribute('data-host-action'), target: host.getAttribute('data-target') });
      if (host.getAttribute('data-host-action') === 'remove') host.disabled = true;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || !S.joinedAt) return;
    var k = e.key.toLowerCase();
    if (k === 'd') { e.preventDefault(); toggleMic(); }
    if (k === 'e') { e.preventDefault(); toggleCam(); }
  });

  // ---------------- Side panel: people, lobby, chat ----------------
  function openPanel(which) {
    S.panel = which;
    var panel = $('[data-panel]');
    panel.hidden = !which;
    $$('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== which; });
    $$('.panel-tabs [data-panel-btn]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-panel-btn') === which); });
    $('[data-ctl="chat"]').classList.toggle('active', which === 'chat');
    if (which === 'chat') {
      S.unread = 0; paintChatBadge();
      setTimeout(function () { var i = $('[data-chat-form] input'); if (i) i.focus(); }, 50);
    }
  }

  function li(name, sub, actions) {
    var item = document.createElement('li');
    var av = document.createElement('span'); av.className = 'avatar avatar-sm'; av.textContent = initials(name);
    var txt = document.createElement('span'); txt.className = 'grow';
    var b = document.createElement('b'); b.textContent = name; txt.appendChild(b);
    if (sub) { var s = document.createElement('span'); s.className = 'muted small'; s.textContent = ' ' + sub; txt.appendChild(s); }
    item.appendChild(av); item.appendChild(txt);
    (actions || []).forEach(function (a) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-sm ' + (a.cls || 'btn-ghost'); btn.textContent = a.label;
      btn.setAttribute('data-host-action', a.action); btn.setAttribute('data-target', a.target);
      item.appendChild(btn);
    });
    return item;
  }

  function paintPeople() {
    var ul = $('[data-people]');
    if (!ul || !S.self) return;
    ul.textContent = '';
    ul.appendChild(li(S.self.name + ' (you)', S.self.host ? 'Host' : ''));
    Object.keys(S.peers).forEach(function (cid) {
      var info = S.peers[cid].info;
      var flags = [info.host ? 'Host' : 'Guest', info.hand ? '✋' : '', info.mic ? '' : 'muted', info.sharing ? 'presenting' : ''].filter(Boolean).join(' · ');
      var acts = cfg.host && !info.host ? [
        { label: 'Mute', action: 'mute', target: cid },
        { label: 'Remove', action: 'remove', target: cid, cls: 'btn-danger' },
      ] : cfg.host && info.mic ? [{ label: 'Mute', action: 'mute', target: cid }] : [];
      ul.appendChild(li(info.name, flags, acts));
    });
    $('[data-count]').textContent = Object.keys(S.peers).length + 1;
  }

  var lastLobby = 0;
  function renderLobby(waiting) {
    if (!cfg.host) return;
    var box = $('[data-lobby-list]');
    var alert = $('[data-lobby-alert]');
    box.textContent = '';
    alert.textContent = '';
    alert.hidden = !waiting.length;
    if (!waiting.length) return;
    var label = document.createElement('div'); label.className = 'panel-label'; label.textContent = 'Waiting in the lobby (' + waiting.length + ')';
    box.appendChild(label);
    var ul = document.createElement('ul'); ul.className = 'people';
    waiting.forEach(function (w) {
      ul.appendChild(li(w.name, '', [{ label: 'Admit', action: 'admit', target: w.cid, cls: 'btn-success' }, { label: 'Deny', action: 'deny', target: w.cid }]));
    });
    box.appendChild(ul);
    // A banner over the call, so hosts notice without opening the panel.
    var first = waiting[0];
    var msg = document.createElement('span');
    msg.textContent = waiting.length === 1 ? first.name + ' is waiting to join' : first.name + ' and ' + (waiting.length - 1) + ' more are waiting to join';
    alert.appendChild(msg);
    alert.appendChild(li('', '', [{ label: 'Admit', action: 'admit', target: first.cid, cls: 'btn-success' }]).lastChild);
    var view = document.createElement('button'); view.type = 'button'; view.className = 'btn btn-ghost btn-sm'; view.textContent = 'View all';
    view.setAttribute('data-panel-btn', 'people');
    alert.appendChild(view);
    if (waiting.length > lastLobby) RT.chime(1);
    lastLobby = waiting.length;
  }

  var chatList = $('[data-chat-list]');
  var timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  function addChat(d) {
    var mine = d.cid === S.cid;
    var row = document.createElement('div'); row.className = 'room-msg' + (mine ? ' mine' : '');
    var meta = document.createElement('div'); meta.className = 'muted small'; meta.textContent = (mine ? 'You' : d.name) + ' · ' + timeFmt.format(new Date(d.at));
    var body = document.createElement('div'); body.textContent = d.text;
    row.appendChild(meta); row.appendChild(body);
    chatList.appendChild(row);
    chatList.scrollTop = chatList.scrollHeight;
    if (S.panel !== 'chat' && !mine) {
      S.unread += 1; paintChatBadge();
      toast(d.name, d.text.length > 90 ? d.text.slice(0, 90) + '…' : d.text);
    }
  }
  function paintChatBadge() { var b = $('[data-chat-badge]'); b.textContent = S.unread; b.hidden = !S.unread; }

  $('[data-chat-form]').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('input', e.target);
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    api('/action', { action: 'chat', text: text });
  });

  function floatReaction(tileId, emoji) {
    var tile = $('[data-tile="' + tileId + '"]');
    if (!tile) return;
    var r = document.createElement('span'); r.textContent = emoji; r.className = 'float-emoji';
    r.style.left = (20 + Math.random() * 60) + '%';
    $('.tile-react', tile).appendChild(r);
    setTimeout(function () { r.remove(); }, 2600);
  }

  // ---------------- Leaving ----------------
  function cleanup() {
    S.left = true;
    if (S.channel) S.channel.stop();
    Object.keys(S.peers).forEach(function (cid) { try { S.peers[cid].pc.close(); } catch (e) { /* closed */ } });
    S.peers = {};
    S.stream.getTracks().forEach(function (t) { t.stop(); });
    if (S.screenTrack) S.screenTrack.stop();
    window.removeEventListener('pagehide', beacon);
  }

  function end(title, msg, serverSide) {
    if (S.left) return;
    if (!serverSide) beacon();
    cleanup();
    $('[data-ended-title]').textContent = title;
    $('[data-ended-msg]').textContent = msg || '';
    stage('ended');
  }

  function leave(title, msg) {
    if (S.left) return;
    var done = function () { end(title || 'You left the meeting', msg || '', true); };
    if (!S.cid) { stage('ended'); return; }
    api('/leave').then(done, done);
  }
})();
