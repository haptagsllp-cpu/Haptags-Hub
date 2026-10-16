/*
 * Haptags Hub: video meetings. Every participant connects directly to every other one (WebRTC
 * mesh), which suits calls of up to about 6–8 people. The server only relays the connection
 * handshake through /meet/:token/signal; audio and video never pass through it.
 *
 * Camera "off" really releases the camera (the light goes out): the track is stopped and the
 * video senders carry nothing until it's turned back on.
 */
(function () {
  'use strict';

  var RT = window.HubRT;
  var FX = window.MeetFX;
  var cfg = JSON.parse(document.getElementById('room-data').textContent);
  var base = '/meet/' + cfg.token;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---------------- Preferences (per browser) ----------------
  var PREF_KEY = 'hub-meet-prefs';
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* storage off */ } }

  var S = {
    stage: 'prejoin',
    micTrack: null, micOn: prefs.micOn !== false,
    camRaw: null, fx: null, camOn: prefs.camOn !== false, camBusy: null,
    effect: prefs.effect && prefs.effect.type !== 'custom' ? prefs.effect : { type: 'none' }, customImage: null,
    screenTrack: null, sharing: false, hand: false,
    speakerId: prefs.speaker || '',
    cid: null, key: null, self: null, channel: null,
    peers: {}, order: [], pinned: null,
    unread: 0, panel: null, left: false, audioCtx: null, tiles: {},
  };
  if (location.hash === '#debug') window.meetDebug = S;

  function stage(name) {
    S.stage = name;
    $$('[data-stage]').forEach(function (s) { s.hidden = s.getAttribute('data-stage') !== (name === 'waiting' ? 'call' : name); });
    var call = $('.call');
    call.classList.toggle('is-waiting', name === 'waiting');
    $('[data-waiting]').hidden = name !== 'waiting';
    if (name === 'call' || name === 'waiting') layout();
  }
  function initials(name) { return String(name || '?').trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }
  var COLORS = ['#1a73e8', '#e8710a', '#188038', '#a142f4', '#d93025', '#007b83', '#c5221f', '#9334e6', '#b06000', '#1967d2'];
  function colorFor(name) { var h = 0; for (var i = 0; i < String(name).length; i += 1) h = (h * 31 + String(name).charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function toast(title, body, tone) { if (RT) RT.toast({ title: title, body: body, tone: tone }); }
  function api(path, data) { return RT.post(base + path, Object.assign({ cid: S.cid, key: S.key }, data || {})); }

  // ---------------- Media ----------------
  var AUDIO = function () { return Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, prefs.mic ? { deviceId: { ideal: prefs.mic } } : {}); };
  var VIDEO = function () { return Object.assign({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }, prefs.cam ? { deviceId: { ideal: prefs.cam } } : { facingMode: 'user' }); };
  var hasMedia = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  /** What we show of ourselves (camera, with any effect), or null when the camera is off. */
  function camVideo() { return S.camOn && S.camRaw ? (S.fx ? S.fx.track : S.camRaw) : null; }
  /** What we send: the screen while presenting, otherwise the camera. */
  function outVideo() { return S.sharing && S.screenTrack ? S.screenTrack : camVideo(); }

  function effectSpec() {
    if (S.effect.type === 'image') return { type: 'image', image: S.effect.preset ? FX.presetImage(S.effect.preset) : S.customImage };
    return { type: S.effect.type };
  }

  function needsFx() { return FX && FX.supported && S.effect.type !== 'none' && (S.effect.type !== 'image' || effectSpec().image); }

  /** Wraps the raw camera in the effect pipeline, or unwraps it, to match S.effect. */
  function syncFx() {
    if (!S.camRaw) return;
    if (!needsFx()) {
      if (S.fx) { S.fx.stop(); S.fx = null; }
      return;
    }
    if (S.fx) { S.fx.setEffect(effectSpec()); return; }
    S.fx = FX.Pipeline(S.camRaw, effectSpec());
    fxNote('Loading effects…');
    FX.load().then(function () { fxNote(''); }, function () {
      fxNote('Effects couldn’t load on this device.');
      if (S.fx) { S.fx.stop(); S.fx = null; mediaChanged(); }
    });
  }

  /** getUserMedia, retried once: a camera that was just released can briefly report busy. */
  function getMedia(constraints) {
    var dead = function (stream) {
      // A camera grabbed by another app can hand back a track that is already ended.
      if (stream.getTracks().some(function (t) { return t.readyState === 'ended'; })) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var e = new Error('Device ended'); e.name = 'NotReadableError'; throw e;
      }
      return stream;
    };
    return navigator.mediaDevices.getUserMedia(constraints).then(dead).catch(function (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
      return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return navigator.mediaDevices.getUserMedia(constraints).then(dead); });
    });
  }

  function useCamera(track) {
    if (S.camRaw && S.camRaw !== track) S.camRaw.stop();
    S.camRaw = track;
    S.camRaw.addEventListener('ended', function () { if (S.camOn && S.camRaw === track) { S.camOn = false; S.camRaw = null; mediaChanged(); } });
    S.camOn = true;
    syncFx();
    mediaChanged();
  }

  function useMic(track) {
    var old = S.micTrack;
    S.micTrack = track;
    S.micTrack.enabled = S.micOn;
    eachSender('audio', function (s) { s.replaceTrack(S.micTrack).catch(function () {}); });
    if (old && old !== track) old.stop();
    if (S.tiles.self) watchVolume(S.tiles.self, S.micTrack, true);
  }

  function startCamera() {
    if (!hasMedia) return Promise.reject(new Error('unsupported'));
    if (S.camBusy) return S.camBusy;
    S.camBusy = getMedia({ video: VIDEO() }).then(function (stream) {
      S.camBusy = null;
      useCamera(stream.getVideoTracks()[0]);
      refreshDevices();
    }).finally(function () { S.camBusy = null; });
    return S.camBusy;
  }

  function stopCamera() {
    S.camOn = false;
    if (S.fx) { S.fx.stop(); S.fx = null; }
    if (S.camRaw) { S.camRaw.stop(); S.camRaw = null; } // releases the camera, so its light goes off
    mediaChanged();
  }

  function startMic() {
    if (!hasMedia) return Promise.reject(new Error('unsupported'));
    return getMedia({ audio: AUDIO() }).then(function (stream) {
      useMic(stream.getAudioTracks()[0]);
      refreshDevices();
    });
  }

  function eachSender(kind, fn) {
    Object.keys(S.peers).forEach(function (cid) {
      S.peers[cid].pc.getTransceivers().forEach(function (t) {
        if (!t.stopped && t.receiver.track && t.receiver.track.kind === kind) fn(t.sender, cid);
      });
    });
  }

  /** Push the current tracks to every connection and every preview, then tell the room. */
  function mediaChanged() {
    var v = outVideo();
    eachSender('video', function (s) { if (s.track !== v) s.replaceTrack(v).catch(function () {}); });
    var cam = camVideo();
    var stream = cam ? new MediaStream([cam]) : null;
    [$('[data-preview]'), $('[data-fx-preview]'), S.tiles.self && $('video', S.tiles.self)].forEach(function (el) {
      if (el && (el.srcObject ? el.srcObject.getVideoTracks()[0] : null) !== cam) el.srcObject = stream;
    });
    paintControls();
    if (S.cid && S.stage === 'call') sendState();
  }

  // ---------------- Devices ----------------
  var canPickSpeaker = 'setSinkId' in HTMLMediaElement.prototype;
  if (!canPickSpeaker) $$('[data-speaker-wrap]').forEach(function (el) { el.hidden = true; });

  function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      var current = {
        audioinput: S.micTrack && S.micTrack.getSettings().deviceId,
        videoinput: (S.camRaw && S.camRaw.getSettings().deviceId) || prefs.cam,
        audiooutput: S.speakerId,
      };
      ['audioinput', 'audiooutput', 'videoinput'].forEach(function (kind) {
        var devices = list.filter(function (d) { return d.kind === kind; });
        $$('select[data-device="' + kind + '"]').forEach(function (sel) {
          sel.textContent = '';
          if (!devices.length) {
            var none = document.createElement('option');
            none.textContent = kind === 'audioinput' ? 'No microphone found' : kind === 'videoinput' ? 'No camera found' : 'Default speaker';
            sel.appendChild(none); sel.disabled = kind !== 'audiooutput'; return;
          }
          sel.disabled = false;
          devices.forEach(function (d, i) {
            var o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || (kind === 'audioinput' ? 'Microphone ' : kind === 'videoinput' ? 'Camera ' : 'Speaker ') + (i + 1);
            sel.appendChild(o);
          });
          if (current[kind] && devices.some(function (d) { return d.deviceId === current[kind]; })) sel.value = current[kind];
        });
      });
    });
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  document.addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-device]');
    if (!sel || !sel.value) return;
    var kind = sel.getAttribute('data-device');
    if (kind === 'audioinput') { prefs.mic = sel.value; savePrefs(); startMic().catch(function () { toast('Couldn’t switch microphone', '', 'important'); }); }
    if (kind === 'videoinput') { prefs.cam = sel.value; savePrefs(); if (S.camOn) startCamera().catch(function () { toast('Couldn’t switch camera', 'It may be in use by another app.', 'important'); }); }
    if (kind === 'audiooutput') { S.speakerId = sel.value; prefs.speaker = sel.value; savePrefs(); applySpeaker(); }
    $$('select[data-device="' + kind + '"]').forEach(function (o) { if (o !== sel) o.value = sel.value; });
  });

  function applySpeaker() {
    if (!canPickSpeaker || !S.speakerId) return;
    $$('.tile:not(.self) video').forEach(function (v) { v.setSinkId(S.speakerId).catch(function () {}); });
  }

  // ---------------- Ready to join? ----------------
  var nameInput = $('#join-name');
  var mediaMsg = $('[data-media-msg]');

  function paintPreview() {
    var on = Boolean(camVideo());
    var msg = $('[data-preview-msg]');
    msg.hidden = on;
    msg.textContent = S.camBusy ? 'Camera is starting' : 'Camera is off';
    $('[data-preview]').hidden = !on;
    $('[data-preview-name]').textContent = nameInput.value.trim();
  }
  nameInput.addEventListener('input', paintPreview);

  function initMedia() {
    if (!hasMedia) {
      mediaMsg.textContent = location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'This browser can’t use a camera or microphone. Try Chrome, Edge, Safari or Firefox.'
        : 'Camera and microphone only work over https.';
      S.camOn = false; paintPreview(); paintControls(); return;
    }
    var wantCam = S.camOn;
    S.camOn = false;
    S.camBusy = Promise.resolve(); // shows "Camera is starting" until we know
    paintPreview();
    // One request for both devices means one permission prompt; fall back to each on its own.
    var both = wantCam
      ? getMedia({ audio: AUDIO(), video: VIDEO() }).then(function (stream) {
        useMic(stream.getAudioTracks()[0]);
        S.camBusy = null;
        useCamera(stream.getVideoTracks()[0]);
        return [];
      })
      : Promise.reject(new Error('camera off'));
    both.catch(function () {
      var mic = S.micTrack ? Promise.resolve() : startMic().catch(function () { S.micOn = false; return 'mic'; });
      return mic.then(function (m) {
        S.camBusy = null;
        if (!wantCam) return [m];
        return startCamera().then(function () { return [m]; }, function () { S.camOn = false; return [m, 'cam']; });
      });
    }).then(function (r) {
      S.camBusy = null;
      var blocked = r.filter(Boolean);
      mediaMsg.textContent = !blocked.length ? ''
        : blocked.length === 2 ? 'Camera and microphone are blocked. You can still join to watch and listen. To fix it, allow access from the icon in the address bar, then reload.'
          : blocked[0] === 'mic' ? 'Microphone is blocked or missing, so others won’t hear you.' : 'Camera is blocked or in use by another app.';
      paintPreview(); paintControls(); refreshDevices();
    });
  }
  initMedia();

  // Who's already here
  function pollWho() {
    if (S.stage !== 'prejoin') return;
    fetch(base + '/status', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var n = d.names || [];
      $('[data-who]').textContent = !n.length ? 'No one else is here'
        : n.length === 1 ? n[0] + ' is in this call'
          : n.length === 2 ? n[0] + ' and ' + n[1] + ' are in this call'
            : n[0] + ', ' + n[1] + ' and ' + (n.length - 2) + ' more are in this call';
    }).catch(function () {});
    setTimeout(pollWho, 6000);
  }
  pollWho();

  // ---------------- Join ----------------
  $('[data-join-form]').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameInput.value.trim();
    var errEl = $('[data-join-error]');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Enter your name so others know who you are.'; nameInput.focus(); return; }
    var btn = $('[data-join-btn]');
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = cfg.host ? 'Joining…' : 'Asking to join…';
    try { S.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (x) { /* speaking rings are optional */ }
    RT.post(base + '/join', { name: name, mic: S.micOn && Boolean(S.micTrack), cam: Boolean(camVideo()) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not join'); return j; }); })
      .then(function (res) {
        S.cid = res.cid; S.key = res.key; S.self = res.self;
        S.channel = new RT.Channel({
          onEvent: onEvent,
          onLost: function () { if (!S.left) end('Connection lost', 'The connection to the server dropped. Rejoin to continue.'); return true; },
        });
        S.channel.start({ cid: res.cid, key: res.key, seq: res.seq });
        window.addEventListener('pagehide', beacon);
        buildSelfTile();
        startClock();
        if (res.state === 'in') enterCall(res.peers, res.waiting);
        else {
          stage('waiting');
          if (!res.hostsPresent) $('[data-wait-msg]').textContent = 'Nobody from the team is here yet. We’ve let them know you’re waiting.';
        }
      })
      .catch(function (err) {
        errEl.textContent = err.message === 'Failed to fetch' ? 'Couldn’t reach the server. Check your connection.' : err.message;
        btn.disabled = false; btn.textContent = label;
      });
  });

  function beacon() {
    if (S.left || !S.cid) return;
    if (navigator.sendBeacon) navigator.sendBeacon(base + '/leave', new URLSearchParams({ _csrf: RT.csrf, cid: S.cid, key: S.key }));
  }

  // ---------------- Tiles and layout ----------------
  var grid = $('[data-grid]');
  var area = $('[data-stage-area]');
  var tpl = $('#tile-tpl');

  function makeTile(id, name, isSelf) {
    var tile = tpl.content.firstElementChild.cloneNode(true);
    tile.setAttribute('data-tile', id);
    if (isSelf) { tile.classList.add('self'); $('.tile-pin', tile).remove(); }
    var av = $('.tile-initial', tile);
    av.textContent = initials(name); av.style.background = colorFor(name);
    $('[data-name]', tile).textContent = isSelf ? 'You' : name;
    var video = $('video', tile);
    if (isSelf) { video.muted = true; video.classList.add('mirror'); }
    video.addEventListener('loadedmetadata', function () {
      var p = video.play();
      if (p && p.catch) p.catch(function (err) { if (err && err.name === 'NotAllowedError') showUnmuteHint(); });
    });
    if (!isSelf && canPickSpeaker && S.speakerId) video.setSinkId(S.speakerId).catch(function () {});
    grid.appendChild(tile);
    S.tiles[id] = tile;
    return tile;
  }

  function buildSelfTile() {
    if (S.tiles.self) return;
    makeTile('self', S.self.name, true);
    mediaChanged();
    if (S.micTrack) watchVolume(S.tiles.self, S.micTrack, true);
  }

  var unmuteShown = false;
  function showUnmuteHint() {
    if (unmuteShown) return;
    unmuteShown = true;
    RT.toast({ title: 'Click to hear the meeting', body: 'Your browser paused the sound.', sticky: true, actions: [{ label: 'Turn on sound', primary: true, onClick: function () { $$('video', grid).forEach(function (v) { v.play().catch(function () {}); }); unmuteShown = false; } }] });
  }

  function place(tile, x, y, w, h) {
    tile.style.left = Math.round(x) + 'px'; tile.style.top = Math.round(y) + 'px';
    tile.style.width = Math.round(w) + 'px'; tile.style.height = Math.round(h) + 'px';
  }

  /** Best rows × columns for n tiles in W × H: the layout with the biggest tiles wins. */
  function bestGrid(n, W, H, gap) {
    var best = null;
    [16 / 9, 4 / 3, 1, 3 / 4].forEach(function (ratio) {
      for (var cols = 1; cols <= n; cols += 1) {
        var rows = Math.ceil(n / cols);
        var w = (W - gap * (cols - 1)) / cols;
        var h = w / ratio;
        if (h * rows + gap * (rows - 1) > H) { h = (H - gap * (rows - 1)) / rows; w = h * ratio; }
        if (w > 0 && h > 0 && (!best || w * h > best.w * best.h + 1)) best = { cols: cols, rows: rows, w: w, h: h };
      }
    });
    return best;
  }

  function placeGrid(tiles, x0, y0, W, H, gap) {
    if (!tiles.length) return;
    var g = bestGrid(tiles.length, W, H, gap);
    var top = y0 + (H - (g.rows * g.h + (g.rows - 1) * gap)) / 2;
    tiles.forEach(function (t, i) {
      var row = Math.floor(i / g.cols);
      var inRow = row < g.rows - 1 ? g.cols : tiles.length - g.cols * (g.rows - 1);
      var col = i - row * g.cols;
      var left = x0 + (W - (inRow * g.w + (inRow - 1) * gap)) / 2;
      place(t, left + col * (g.w + gap), top + row * (g.h + gap), g.w, g.h);
    });
  }

  /**
   * Meet-style layout, recomputed on every join/leave/resize:
   * alone → you fill the screen; two people → they fill it and you float in the corner;
   * more → an even grid in join order with you last; someone presenting or pinned → they take
   * the stage and everyone else lines up beside (or under, on phones) them.
   */
  function layout() {
    if (!S.tiles.self) return;
    var W = area.clientWidth; var H = area.clientHeight;
    var gap = W < 600 ? 6 : 10;
    var self = S.tiles.self;
    var others = S.order.map(function (cid) { return S.peers[cid] && S.peers[cid].tile; }).filter(Boolean);
    var all = others.concat([self]);
    all.forEach(function (t) { t.classList.remove('pip', 'main', 'strip', 'hidden-tile'); });

    if (S.stage === 'waiting') {
      var pw = Math.max(150, Math.min(300, W * 0.24));
      self.classList.add('pip');
      place(self, W - pw - 16, H - pw * 9 / 16 - 16, pw, pw * 9 / 16);
      return;
    }
    var spotCid = S.pinned && S.peers[S.pinned] ? S.pinned
      : S.order.filter(function (cid) { return S.peers[cid].info.sharing; })[0];
    if (spotCid) {
      var main = S.peers[spotCid].tile;
      var rest = all.filter(function (t) { return t !== main; });
      main.classList.add('main');
      if (W >= 760) {
        var sw = Math.min(280, W * 0.22); var sh = sw * 9 / 16;
        place(main, 0, 0, W - sw - gap, H);
        var fit = Math.max(1, Math.floor((H + gap) / (sh + gap)));
        var y = (H - (Math.min(rest.length, fit) * (sh + gap) - gap)) / 2;
        rest.forEach(function (t, i) {
          t.classList.add('strip');
          if (i >= fit) { t.classList.add('hidden-tile'); place(t, W - sw, 0, 1, 1); return; }
          place(t, W - sw, y + i * (sh + gap), sw, sh);
        });
      } else {
        var bh = Math.min(110, H * 0.22); var bw = bh * 16 / 9;
        place(main, 0, 0, W, H - bh - gap);
        var fitX = Math.max(1, Math.floor((W + gap) / (bw + gap)));
        var x = (W - (Math.min(rest.length, fitX) * (bw + gap) - gap)) / 2;
        rest.forEach(function (t, i) {
          t.classList.add('strip');
          if (i >= fitX) { t.classList.add('hidden-tile'); place(t, 0, H - 1, 1, 1); return; }
          place(t, x + i * (bw + gap), H - bh, bw, bh);
        });
      }
    } else if (others.length === 0) {
      place(self, 0, 0, W, H);
    } else if (others.length === 1) {
      place(others[0], 0, 0, W, H);
      var p = Math.max(120, Math.min(280, W * 0.22));
      self.classList.add('pip');
      place(self, W - p - 14, H - p * 9 / 16 - 14, p, p * 9 / 16);
    } else {
      placeGrid(all, 0, 0, W, H, gap);
    }
    $$('[data-count]').forEach(function (el) { el.textContent = others.length + 1; });
  }
  if (window.ResizeObserver) new ResizeObserver(function () { layout(); }).observe(area);
  else window.addEventListener('resize', layout);

  function paintTile(tile, info) {
    tile.classList.toggle('muted', !info.mic);
    tile.classList.toggle('cam-off', !info.cam && !info.sharing);
    tile.classList.toggle('sharing', Boolean(info.sharing));
    tile.classList.toggle('hand', Boolean(info.hand));
  }

  function paintSelf() {
    if (!S.tiles.self) return;
    paintTile(S.tiles.self, { mic: S.micOn && Boolean(S.micTrack), cam: Boolean(camVideo()), sharing: false, hand: S.hand });
  }

  // ---------------- Peer connections (perfect negotiation) ----------------
  function addPeer(info, initiator) {
    if (S.peers[info.cid]) return S.peers[info.cid];
    var pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
    var p = { info: info, pc: pc, stream: new MediaStream(), pendingIce: [], polite: S.cid < info.cid, makingOffer: false, ignoreOffer: false };
    S.peers[info.cid] = p;
    S.order.push(info.cid);
    p.tile = makeTile(info.cid, info.name, false);
    $('video', p.tile).srcObject = p.stream;
    paintTile(p.tile, info);
    status(p, 'Connecting…');

    pc.ontrack = function (e) {
      p.stream.getTracks().filter(function (t) { return t.kind === e.track.kind; }).forEach(function (t) { p.stream.removeTrack(t); });
      p.stream.addTrack(e.track);
      var v = $('video', p.tile);
      if (v.paused) v.play().catch(function (err) { if (err && err.name === 'NotAllowedError') showUnmuteHint(); });
      if (e.track.kind === 'audio') watchVolume(p.tile, e.track, false);
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
      if (st === 'connected') { status(p, ''); tuneBitrates(); }
      else if (st === 'disconnected') status(p, 'Reconnecting…');
      else if (st === 'failed') {
        status(p, 'Can’t connect. Their network may be blocking calls.');
        if (pc.restartIce) pc.restartIce();
      }
    };

    // Whoever joins later sets up one audio and one video lane; the other side answers. The lanes
    // stay for the whole call, so camera on/off and screen sharing never renegotiate.
    if (initiator) {
      pc.addTransceiver(S.micTrack || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(outVideo() || 'video', { direction: 'sendrecv' });
    }
    layout();
    return p;
  }

  /** After an offer arrives, send our own tracks on the lanes it created. */
  function attachLocal(p) {
    p.pc.getTransceivers().forEach(function (t) {
      var kind = t.receiver.track && t.receiver.track.kind;
      if (!kind || t.stopped) return;
      if (t.direction === 'recvonly' || t.direction === 'inactive') t.direction = 'sendrecv';
      var track = kind === 'audio' ? S.micTrack : outVideo();
      if (t.sender.track !== track) t.sender.replaceTrack(track || null).catch(function () {});
    });
  }

  /** Every extra person is another upload, so lower each video's bitrate as the call grows. */
  function tuneBitrates() {
    var n = Object.keys(S.peers).length;
    var max = S.sharing ? 1500000 : n <= 1 ? 1500000 : n === 2 ? 900000 : n <= 4 ? 500000 : 300000;
    eachSender('video', function (s) {
      if (!s.getParameters || !s.setParameters) return;
      var params = s.getParameters();
      if (!params.encodings || !params.encodings.length) return;
      params.encodings[0].maxBitrate = max;
      params.encodings[0].scaleResolutionDownBy = !S.sharing && n >= 5 ? 2 : 1;
      s.setParameters(params).catch(function () {});
    });
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

  function signal(to, data) { api('/signal', { to: to, data: data }).catch(function () {}); }

  function status(p, text) {
    var el = $('.tile-status', p.tile);
    el.textContent = text; el.hidden = !text;
  }

  function removePeer(cid) {
    var p = S.peers[cid];
    if (!p) return;
    try { p.pc.close(); } catch (e) { /* already closed */ }
    p.tile.remove();
    delete S.peers[cid]; delete S.tiles[cid];
    S.order = S.order.filter(function (c) { return c !== cid; });
    if (S.pinned === cid) S.pinned = null;
    layout(); paintPeople(); tuneBitrates();
  }

  // Speaking indicator: a cheap volume meter per audio track.
  function watchVolume(tile, track, isSelf) {
    if (!S.audioCtx) return;
    try {
      if (tile._volume) clearInterval(tile._volume);
      var src = S.audioCtx.createMediaStreamSource(new MediaStream([track]));
      var an = S.audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      var buf = new Uint8Array(an.fftSize);
      tile._volume = setInterval(function () {
        if (!tile.isConnected || track.readyState === 'ended') { clearInterval(tile._volume); return; }
        an.getByteTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i += 1) { var v = (buf[i] - 128) / 128; sum += v * v; }
        var on = Math.sqrt(sum / buf.length) > 0.035 && (isSelf ? S.micOn : !tile.classList.contains('muted'));
        tile.classList.toggle('speaking', on);
      }, 180);
    } catch (e) { /* optional */ }
  }

  // ---------------- Server events ----------------
  function enterCall(peers, waiting) {
    stage('call');
    (peers || []).forEach(function (p) { addPeer(p, true); });
    renderLobby(waiting || []);
    paintPeople(); paintControls(); layout();
    sendState();
    if (!window.RTCPeerConnection) toast('Video calls aren’t supported in this browser', 'Use a recent Chrome, Edge, Safari or Firefox.', 'important');
  }

  function onEvent(e) {
    var d = e.data || {};
    switch (e.type) {
      case 'room.joined': addPeer(d.peer, false); paintPeople(); toast(d.peer.name + ' joined'); break;
      case 'room.left': {
        var who = S.peers[d.cid];
        removePeer(d.cid);
        if (who) toast(who.info.name + ' left the meeting');
        break;
      }
      case 'signal': onSignal(d.from, d.data || {}); break;
      case 'room.state': {
        var p = S.peers[d.peer.cid];
        if (!p) break;
        var raised = d.peer.hand && !p.info.hand;
        var shared = d.peer.sharing !== p.info.sharing;
        p.info = d.peer;
        paintTile(p.tile, d.peer); paintPeople();
        if (shared) layout();
        if (raised) { toast('✋ ' + d.peer.name + ' raised a hand'); RT.chime(1); }
        if (d.peer.sharing && shared) toast(d.peer.name + ' is presenting');
        break;
      }
      case 'room.chat': addChat(d); break;
      case 'room.react': floatReaction(d.cid === S.cid ? 'You' : d.name, d.emoji); break;
      case 'room.lobby': renderLobby(d.waiting); break;
      case 'room.admitted': S.self = d.self; enterCall(d.peers, []); break;
      case 'room.denied': end('You can’t join this call', 'Someone in the call denied your request to join.', true); break;
      case 'room.removed': end('You’ve been removed from the meeting', (d.by || 'The host') + ' removed you from the call.', true); break;
      case 'room.ended': end('The meeting has ended', 'The host ended the meeting for everyone.', true); break;
      case 'room.mute':
        if (S.micOn) toggleMic();
        toast((d.by || 'The host') + ' muted you', 'Unmute when you want to speak.');
        break;
      default: break;
    }
  }

  // ---------------- Controls ----------------
  function sendState() {
    if (!S.cid || S.left) return;
    api('/action', { action: 'state', state: { mic: S.micOn && Boolean(S.micTrack), cam: Boolean(camVideo()), sharing: S.sharing, hand: S.hand } });
  }

  function paintControls() {
    var micOn = S.micOn && Boolean(S.micTrack);
    var camOn = Boolean(camVideo()) || Boolean(S.camBusy);
    $$('[data-ctl="mic"], [data-toggle="mic"]').forEach(function (b) {
      b.classList.toggle('off', !micOn);
      b.title = micOn ? 'Turn off microphone' : 'Turn on microphone';
      b.setAttribute('aria-pressed', String(micOn));
    });
    $$('[data-ctl="cam"], [data-toggle="cam"]').forEach(function (b) {
      b.classList.toggle('off', !camOn);
      b.title = camOn ? 'Turn off camera' : 'Turn on camera';
      b.setAttribute('aria-pressed', String(camOn));
    });
    $$('[data-ctl="share"]').forEach(function (b) { b.classList.toggle('active', S.sharing); });
    $$('.bar [data-ctl="share"]').forEach(function (b) { b.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia); });
    $$('[data-ctl="hand"]').forEach(function (b) { b.classList.toggle('active', S.hand); });
    $('[data-presenting]').hidden = !S.sharing;
    $$('[data-fx]').forEach(function (b) { b.classList.toggle('selected', S.effect.type === b.getAttribute('data-fx')); });
    $$('[data-fx-preset]').forEach(function (b) { b.classList.toggle('selected', S.effect.type === 'image' && S.effect.preset === b.getAttribute('data-fx-preset')); });
    var fxMsg = $('[data-fx-msg]'); if (fxMsg) fxMsg.hidden = Boolean(camVideo());
    paintSelf();
    if (S.stage === 'prejoin') paintPreview();
  }

  function toggleMic() {
    if (!S.micTrack) {
      return startMic().then(function () { S.micOn = true; S.micTrack.enabled = true; prefs.micOn = true; savePrefs(); paintControls(); sendState(); })
        .catch(function () { toast('Microphone blocked', 'Allow microphone access from the address bar, then try again.', 'important'); });
    }
    S.micOn = !S.micOn; S.micTrack.enabled = S.micOn;
    prefs.micOn = S.micOn; savePrefs();
    paintControls(); sendState();
    return null;
  }

  function toggleCam() {
    if (S.camBusy) return;
    if (camVideo()) {
      stopCamera();
      prefs.camOn = false; savePrefs();
      return;
    }
    S.camOn = true; paintControls();
    startCamera().then(function () { prefs.camOn = true; savePrefs(); })
      .catch(function () {
        S.camOn = false; paintControls();
        toast('Camera unavailable', 'Allow camera access from the address bar, or close other apps using it.', 'important');
      });
  }

  function startShare() {
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false }).then(function (s) {
      S.screenTrack = s.getVideoTracks()[0];
      if ('contentHint' in S.screenTrack) S.screenTrack.contentHint = 'detail';
      S.screenTrack.addEventListener('ended', stopShare);
      S.sharing = true;
      mediaChanged(); tuneBitrates();
    }).catch(function () { /* cancelled */ });
  }

  function stopShare() {
    if (!S.sharing) return;
    S.sharing = false;
    if (S.screenTrack) S.screenTrack.stop();
    S.screenTrack = null;
    mediaChanged(); tuneBitrates();
  }

  function closeMenus(except) {
    $$('[data-more-menu], [data-react-pop]').forEach(function (m) { if (m !== except) m.hidden = true; });
  }

  document.addEventListener('click', function (e) {
    var tog = e.target.closest('[data-toggle]');
    if (tog) { if (tog.getAttribute('data-toggle') === 'mic') toggleMic(); else toggleCam(); return; }
    var b = e.target.closest('[data-ctl]');
    if (b) {
      var c = b.getAttribute('data-ctl');
      if (c === 'mic') toggleMic();
      else if (c === 'cam') toggleCam();
      else if (c === 'share') { if (S.sharing) stopShare(); else startShare(); }
      else if (c === 'hand') { S.hand = !S.hand; paintControls(); sendState(); paintPeople(); }
      else if (c === 'react' || c === 'more') {
        var menu = c === 'react' ? $('[data-react-pop]') : $('[data-more-menu]');
        closeMenus(menu); menu.hidden = !menu.hidden; return;
      }
      closeMenus();
      return;
    }
    var em = e.target.closest('[data-emoji]');
    if (em) {
      closeMenus();
      api('/action', { action: 'react', emoji: em.getAttribute('data-emoji') });
      floatReaction('You', em.getAttribute('data-emoji'));
      return;
    }
    var opener = e.target.closest('[data-open]');
    if (opener) { closeMenus(); openDialog(opener.getAttribute('data-open')); return; }
    if (!e.target.closest('.pop-wrap')) closeMenus();
    var pb = e.target.closest('[data-panel-btn]');
    if (pb) { closeMenus(); var which = pb.getAttribute('data-panel-btn'); openPanel(S.panel === which ? null : which); return; }
    if (e.target.closest('[data-panel-close]')) { openPanel(null); return; }
    if (e.target.closest('[data-leave]')) { leave(); return; }
    if (e.target.closest('[data-end]')) {
      if (window.confirm('End the meeting for everyone?')) api('/action', { action: 'end' }).then(function () { leave('The meeting has ended', 'You ended the meeting for everyone.'); });
      return;
    }
    var pin = e.target.closest('.tile-pin');
    if (pin) {
      var cid = pin.closest('.tile').getAttribute('data-tile');
      S.pinned = S.pinned === cid ? null : cid;
      $$('.tile').forEach(function (t) { t.classList.toggle('pinned', t.getAttribute('data-tile') === S.pinned); });
      layout();
      return;
    }
    var host = e.target.closest('[data-host-action]');
    if (host) {
      var act = host.getAttribute('data-host-action');
      if (act === 'admit-all') {
        $$('[data-lobby-list] [data-host-action="admit"]').forEach(function (a) { api('/action', { action: 'admit', target: a.getAttribute('data-target') }); });
      } else api('/action', { action: act, target: host.getAttribute('data-target') });
      if (act === 'remove') host.disabled = true;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenus();
    if (!(e.ctrlKey || e.metaKey)) return;
    var k = e.key.toLowerCase();
    if (k === 'd') { e.preventDefault(); toggleMic(); }
    if (k === 'e') { e.preventDefault(); toggleCam(); }
  });

  // ---------------- Dialogs: effects and settings ----------------
  function openDialog(name) {
    var d = $('[data-dialog="' + name + '"]');
    if (!d || !d.showModal) return;
    refreshDevices();
    if (name === 'effects') {
      if (!FX || !FX.supported) fxNote('Background effects need Chrome, Edge or Firefox on a computer.');
      mediaChanged();
    }
    d.showModal();
  }
  $$('dialog[data-dialog]').forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });

  function fxNote(text) { var n = $('[data-fx-note]'); if (n) n.textContent = text || 'Effects run on your device. Nothing is uploaded.'; }

  if (FX) {
    var holder = $('[data-fx-backgrounds]');
    FX.presets.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'fx-opt fx-img'; btn.title = p.label;
      btn.setAttribute('data-fx-preset', p.id);
      var img = document.createElement('img'); img.alt = p.label; img.src = FX.thumb(p.id);
      btn.appendChild(img); holder.appendChild(btn);
    });
  }

  function setEffect(effect) {
    if (!FX || !FX.supported) return;
    S.effect = effect;
    prefs.effect = effect.type === 'image' && !effect.preset ? { type: 'none' } : effect;
    savePrefs();
    var apply = function () { syncFx(); mediaChanged(); };
    if (!camVideo()) {
      // Picking an effect turns the camera on, as in Meet.
      S.camOn = true; paintControls();
      startCamera().then(function () { prefs.camOn = true; savePrefs(); }).catch(function () { S.camOn = false; paintControls(); toast('Camera unavailable', '', 'important'); });
    } else apply();
    paintControls();
  }

  document.addEventListener('click', function (e) {
    var opt = e.target.closest('[data-fx]');
    if (opt) { setEffect({ type: opt.getAttribute('data-fx') }); return; }
    var pre = e.target.closest('[data-fx-preset]');
    if (pre) setEffect({ type: 'image', preset: pre.getAttribute('data-fx-preset') });
  });
  var upload = $('[data-fx-upload]');
  if (upload) {
    upload.addEventListener('change', function () {
      var file = upload.files[0];
      upload.value = '';
      if (!file) return;
      var img = new Image();
      img.onload = function () { S.customImage = img; setEffect({ type: 'image' }); };
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------------- Side panel: people, lobby, chat ----------------
  function openPanel(which) {
    S.panel = which;
    $('[data-panel]').hidden = !which;
    $$('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== which; });
    $('[data-panel-title]').textContent = which === 'chat' ? 'In-call messages' : 'People';
    $$('.bar [data-panel-btn]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-panel-btn') === which); });
    if (which === 'chat') {
      S.unread = 0; $('[data-chat-badge]').hidden = true;
      setTimeout(function () { var i = $('[data-chat-form] input'); if (i) i.focus(); }, 50);
    }
    setTimeout(layout, 0);
  }

  function person(name, sub, flags, actions) {
    var item = document.createElement('li');
    var av = document.createElement('span'); av.className = 'p-avatar'; av.textContent = initials(name); av.style.background = colorFor(name);
    var txt = document.createElement('span'); txt.className = 'p-text';
    var b = document.createElement('b'); b.textContent = name; txt.appendChild(b);
    if (sub) { var s = document.createElement('small'); s.textContent = sub; txt.appendChild(s); }
    item.appendChild(av); item.appendChild(txt);
    if (flags) { var f = document.createElement('span'); f.className = 'p-flags'; f.textContent = flags; item.appendChild(f); }
    (actions || []).forEach(function (a) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'pill pill-sm ' + (a.cls || 'pill-light'); btn.textContent = a.label;
      btn.setAttribute('data-host-action', a.action); btn.setAttribute('data-target', a.target || '');
      item.appendChild(btn);
    });
    return item;
  }

  function paintPeople() {
    var ul = $('[data-people]');
    if (!ul || !S.self) return;
    ul.textContent = '';
    var list = S.order.map(function (cid) { return S.peers[cid].info; });
    // Raised hands first, like Meet.
    list.sort(function (a, b) { return (b.hand ? 1 : 0) - (a.hand ? 1 : 0); });
    ul.appendChild(person(S.self.name + ' (You)', S.self.host ? 'Meeting host' : '', (S.hand ? '✋ ' : '') + (S.micOn && S.micTrack ? '' : '🔇')));
    list.forEach(function (info) {
      var acts = [];
      if (cfg.host && info.mic) acts.push({ label: 'Mute', action: 'mute', target: info.cid });
      if (cfg.host && !info.host) acts.push({ label: 'Remove', action: 'remove', target: info.cid, cls: 'pill-danger' });
      ul.appendChild(person(info.name, info.host ? 'Meeting host' : (info.userId ? '' : 'Guest'), (info.hand ? '✋ ' : '') + (info.sharing ? '🖥 ' : '') + (info.mic ? '' : '🔇'), acts));
    });
  }

  var lastLobby = 0;
  function renderLobby(waiting) {
    if (!cfg.host) return;
    var box = $('[data-lobby-list]');
    var alert = $('[data-lobby-alert]');
    box.textContent = ''; alert.textContent = '';
    alert.hidden = !waiting.length;
    if (!waiting.length) { lastLobby = 0; return; }
    var head = document.createElement('div'); head.className = 'side-label row-between';
    var lt = document.createElement('span'); lt.textContent = 'Waiting to join (' + waiting.length + ')'; head.appendChild(lt);
    if (waiting.length > 1) {
      var all = document.createElement('button'); all.type = 'button'; all.className = 'pill pill-sm pill-light'; all.textContent = 'Admit all';
      all.setAttribute('data-host-action', 'admit-all'); head.appendChild(all);
    }
    box.appendChild(head);
    var ul = document.createElement('ul'); ul.className = 'people';
    waiting.forEach(function (w) {
      ul.appendChild(person(w.name, 'Wants to join', '', [{ label: 'Deny', action: 'deny', target: w.cid }, { label: 'Admit', action: 'admit', target: w.cid, cls: 'pill-primary' }]));
    });
    box.appendChild(ul);
    // Banner over the call, so hosts notice without opening the panel.
    var first = waiting[0];
    var msg = document.createElement('span');
    msg.textContent = waiting.length === 1 ? first.name + ' wants to join this call' : first.name + ' and ' + (waiting.length - 1) + (waiting.length === 2 ? ' other' : ' others') + ' want to join this call';
    alert.appendChild(msg);
    var view = document.createElement('button'); view.type = 'button'; view.className = 'pill pill-sm pill-ghost'; view.textContent = 'View all';
    view.setAttribute('data-panel-btn', 'people');
    alert.appendChild(view);
    var admit = document.createElement('button'); admit.type = 'button'; admit.className = 'pill pill-sm pill-primary'; admit.textContent = 'Admit';
    admit.setAttribute('data-host-action', 'admit'); admit.setAttribute('data-target', first.cid);
    alert.appendChild(admit);
    if (waiting.length > lastLobby) RT.chime(1);
    lastLobby = waiting.length;
  }

  var chatList = $('[data-chat-list]');
  var timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  function addChat(d) {
    var mine = d.cid === S.cid;
    var row = document.createElement('div'); row.className = 'room-msg';
    var meta = document.createElement('div'); meta.className = 'room-msg-meta';
    var who = document.createElement('b'); who.textContent = mine ? 'You' : d.name;
    var t = document.createElement('span'); t.textContent = timeFmt.format(new Date(d.at));
    meta.appendChild(who); meta.appendChild(t);
    var body = document.createElement('div'); body.textContent = d.text;
    row.appendChild(meta); row.appendChild(body);
    chatList.appendChild(row);
    chatList.scrollTop = chatList.scrollHeight;
    if (S.panel !== 'chat' && !mine) {
      S.unread += 1; $('[data-chat-badge]').hidden = false;
      toast(d.name, d.text.length > 90 ? d.text.slice(0, 90) + '…' : d.text);
    }
  }

  $('[data-chat-form]').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('input', e.target);
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    api('/action', { action: 'chat', text: text });
  });

  var reactLayer = document.createElement('div'); reactLayer.className = 'react-layer'; area.appendChild(reactLayer);
  function floatReaction(name, emoji) {
    var r = document.createElement('div'); r.className = 'float-react';
    r.style.left = (4 + Math.random() * 18) + '%';
    var e = document.createElement('span'); e.className = 'float-emoji'; e.textContent = emoji;
    var n = document.createElement('span'); n.className = 'float-name'; n.textContent = name;
    r.appendChild(e); r.appendChild(n);
    reactLayer.appendChild(r);
    setTimeout(function () { r.remove(); }, 3400);
  }

  function startClock() {
    var tick = function () { $('[data-clock]').textContent = timeFmt.format(new Date()); };
    tick(); setInterval(tick, 10000);
  }

  // ---------------- Leaving ----------------
  function cleanup() {
    S.left = true;
    if (S.channel) S.channel.stop();
    Object.keys(S.peers).forEach(function (cid) { try { S.peers[cid].pc.close(); } catch (e) { /* closed */ } });
    S.peers = {}; S.order = [];
    stopCamera();
    if (S.micTrack) { S.micTrack.stop(); S.micTrack = null; }
    if (S.screenTrack) { S.screenTrack.stop(); S.screenTrack = null; }
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
    if (!S.cid) { cleanup(); stage('ended'); return; }
    api('/leave').then(done, done);
  }
})();
