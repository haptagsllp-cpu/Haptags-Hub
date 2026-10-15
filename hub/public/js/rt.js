/* Haptags Hub: live updates (long-polling), toasts and desktop notifications. */
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name=csrf-token]');
  var csrf = csrfMeta ? csrfMeta.content : '';

  function post(url, data) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(data || {}),
    });
  }

  /**
   * One long-poll loop. opts.connect() resolves to { cid, key, seq }. opts.onEvent(e) gets each
   * event; opts.onOnline(ids) the team members online; opts.onReset() runs when events may have
   * been missed; opts.onLost() runs when the server forgot this connection (return true to stop).
   */
  function Channel(opts) {
    this.opts = opts;
    this.stopped = false;
    this.fails = 0;
  }
  Channel.prototype.start = function (creds) {
    var self = this;
    var begin = creds ? Promise.resolve(creds) : self.opts.connect();
    begin.then(function (c) {
      self.cid = c.cid; self.key = c.key; self.after = c.seq; self.fails = 0;
      self.loop();
    }, function () { self.retry(); });
  };
  Channel.prototype.retry = function () {
    var self = this;
    if (self.stopped) return;
    self.fails += 1;
    setTimeout(function () { self.start(); }, Math.min(30000, 1000 * Math.pow(2, Math.min(self.fails, 5))));
  };
  Channel.prototype.stop = function () { this.stopped = true; };
  Channel.prototype.loop = function () {
    var self = this;
    if (self.stopped) return;
    post('/api/rt/poll', { cid: self.cid, key: self.key, after: self.after }).then(function (res) {
      if (res.status === 401) { var e = new Error('lost'); e.lost = true; throw e; }
      if (!res.ok) throw new Error('poll failed: ' + res.status);
      return res.json();
    }).then(function (data) {
      self.fails = 0;
      if (data.online && self.opts.onOnline) self.opts.onOnline(data.online);
      if (data.reset) {
        if (self.opts.onReset) self.opts.onReset();
      } else {
        (data.events || []).forEach(function (e) {
          try { self.opts.onEvent(e); } catch (err) { console.error(err); }
        });
      }
      self.after = data.seq;
      if (data.gone) { self.stopped = true; return; }
      self.loop();
    }).catch(function (err) {
      if (self.stopped) return;
      if (err.lost) {
        if (self.opts.onLost && self.opts.onLost()) { self.stopped = true; return; }
        if (self.opts.onReset) self.opts.onReset();
        self.retry();
        return;
      }
      self.fails += 1;
      setTimeout(function () { self.loop(); }, Math.min(15000, 1000 * self.fails));
    });
  };

  // ---------- Toasts ----------
  var box = document.querySelector('[data-toasts]');
  /** opts: { title, body, href, actions: [{ label, href, primary, newTab }], sticky, tone } */
  function toast(opts) {
    if (!box) return null;
    var el = document.createElement('div');
    el.className = 'toast' + (opts.tone ? ' toast-' + opts.tone : '');
    el.setAttribute('role', 'status');
    var main = document.createElement(opts.href ? 'a' : 'div');
    main.className = 'toast-main';
    if (opts.href) main.href = opts.href;
    var t = document.createElement('b'); t.textContent = opts.title || '';
    main.appendChild(t);
    if (opts.body) { var b = document.createElement('span'); b.textContent = opts.body; main.appendChild(b); }
    el.appendChild(main);
    if (opts.actions && opts.actions.length) {
      var row = document.createElement('div'); row.className = 'toast-actions';
      opts.actions.forEach(function (a) {
        var btn = document.createElement(a.href ? 'a' : 'button');
        btn.className = 'btn btn-sm ' + (a.primary ? (a.tone === 'green' ? 'btn-success' : '') : 'btn-ghost');
        btn.textContent = a.label;
        if (a.href) { btn.href = a.href; if (a.newTab) { btn.target = '_blank'; btn.rel = 'noopener'; } }
        else btn.type = 'button';
        btn.addEventListener('click', function () { if (a.onClick) a.onClick(); close(); });
        row.appendChild(btn);
      });
      el.appendChild(row);
    }
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'toast-close'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    x.addEventListener('click', function () { close(); });
    el.appendChild(x);
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    var timer = setTimeout(close, opts.sticky ? 45000 : 7000);
    function close() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
    return { close: close };
  }

  // ---------- Sound: a short two-tone chime, made on the fly (no audio files) ----------
  var audioCtx = null;
  function chime(times) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var now = audioCtx.currentTime;
      for (var i = 0; i < (times || 1); i += 1) {
        [880, 1320].forEach(function (f, j) {
          var o = audioCtx.createOscillator(); var g = audioCtx.createGain();
          o.frequency.value = f; o.type = 'sine';
          var at = now + i * 1.1 + j * 0.16;
          g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.18, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
          o.connect(g); g.connect(audioCtx.destination); o.start(at); o.stop(at + 0.32);
        });
      }
    } catch (e) { /* sound is optional */ }
  }

  var HubRT = window.HubRT = { Channel: Channel, post: post, toast: toast, chime: chime, csrf: csrf, activeChannel: null };

  // ---------- Team member pages: notifications, badges, presence ----------
  var body = document.body;
  if (body.getAttribute('data-rt') !== 'staff') return;
  var me = Number(body.getAttribute('data-uid'));
  var baseTitle = document.title;
  var missed = 0;

  function badge(name, delta) {
    var el = document.querySelector('[data-count="' + name + '"]');
    if (!el) return;
    var n = Math.max(0, (parseInt(el.textContent, 10) || 0) + delta);
    el.textContent = n; el.hidden = n === 0;
  }
  HubRT.badge = badge;

  function away() { return document.visibilityState !== 'visible'; }

  function notify(title, text, href, tag) {
    if (away()) { missed += 1; document.title = '(' + missed + ') ' + baseTitle; }
    if (!away() || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      var n = new Notification(title, { body: text, tag: tag, icon: '/static/img/haptags-mark.png' });
      n.onclick = function () { window.focus(); if (href) location.href = href; n.close(); };
    } catch (e) { /* some browsers only allow notifications from a service worker */ }
  }
  document.addEventListener('visibilitychange', function () {
    if (!away()) { missed = 0; document.title = baseTitle; }
  });

  var online = [];
  function paintPresence() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-presence]'), function (el) {
      el.classList.toggle('online', online.indexOf(Number(el.getAttribute('data-presence'))) !== -1);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-presence-text]'), function (el) {
      el.textContent = online.indexOf(Number(el.getAttribute('data-presence-text'))) !== -1 ? 'Online' : 'Offline';
    });
  }
  HubRT.paintPresence = paintPresence;

  function emit(e) { window.dispatchEvent(new CustomEvent('hub:rt', { detail: e })); }

  function preview(m) {
    if (m.kind === 'call') return 'Started a call';
    if (m.file) return (m.body ? m.body + ' · ' : '') + '📎 ' + m.file.name;
    return m.body.length > 120 ? m.body.slice(0, 120) + '…' : m.body;
  }

  var handlers = {
    'chat.message': function (d) {
      var m = d.message;
      if (m.userId === me || m.kind === 'system') return;
      var watching = HubRT.activeChannel === d.channelId && !away();
      if (watching) return;
      if (HubRT.activeChannel !== d.channelId) badge('chat', 1);
      if (m.kind === 'call') return; // the call.ring event handles calls
      var href = '/admin/chat/' + d.channelId;
      if (HubRT.activeChannel !== d.channelId) toast({ title: m.userName, body: preview(m), href: href });
      notify(m.userName, preview(m), href, 'chat-' + d.channelId);
    },
    'call.ring': function (d) {
      toast({
        title: d.by + ' is calling', body: d.title, sticky: true, tone: 'call',
        actions: [{ label: 'Join', href: d.url, primary: true, tone: 'green', newTab: true }, { label: 'Dismiss' }],
      });
      chime(3);
      notify(d.by + ' is calling', 'Click to join ' + d.title, d.url, 'call');
    },
    'meeting.soon': function (d) {
      toast({ title: 'Starting soon: ' + d.title, body: 'Your meeting starts in a few minutes.', sticky: true, actions: [{ label: 'Join', href: d.url, primary: true, tone: 'green', newTab: true }] });
      chime(1);
      notify('Starting soon', d.title, d.url, 'meeting-' + d.id);
    },
    'meeting.invite': function (d) {
      toast({ title: d.by + ' invited you', body: d.title, href: d.url });
      notify(d.by + ' invited you to a meeting', d.title, d.url, 'invite-' + d.id);
    },
    'meeting.knock': function (d) {
      toast({ title: d.name + ' is waiting', body: 'In the lobby of “' + d.title + '”', sticky: true, actions: [{ label: 'Join to let them in', href: d.url, primary: true, tone: 'green', newTab: true }] });
      chime(2);
      notify(d.name + ' is waiting in the lobby', d.title, d.url, 'knock-' + d.id);
    },
    announcement: function (d) {
      badge('announcements', 1);
      toast({ title: (d.important ? 'Important: ' : 'Announcement: ') + d.title, body: 'From ' + d.by, href: '/admin/announcements', sticky: d.important, tone: d.important ? 'important' : '' });
      notify('Announcement from ' + d.by, d.title, '/admin/announcements', 'news-' + d.id);
    },
  };

  var channel = new Channel({
    connect: function () {
      return post('/api/rt/connect').then(function (r) {
        if (r.status === 401) { channel.stop(); throw new Error('signed out'); }
        return r.json();
      });
    },
    onEvent: function (e) {
      if (handlers[e.type]) handlers[e.type](e.data);
      emit(e);
    },
    onOnline: function (ids) {
      var changed = ids.length !== online.length || ids.some(function (id) { return online.indexOf(id) === -1; });
      online = ids;
      if (changed) { paintPresence(); window.dispatchEvent(new CustomEvent('hub:online', { detail: ids })); }
    },
    onReset: function () { window.dispatchEvent(new CustomEvent('hub:reset')); },
  });
  HubRT.online = function () { return online; };
  channel.start();

  // Offer desktop notifications once, from a click (browsers require a user gesture).
  var asked = false;
  try { asked = localStorage.getItem('hub-notify-asked') === '1'; } catch (e) { /* storage off */ }
  if ('Notification' in window && Notification.permission === 'default' && !asked) {
    setTimeout(function () {
      toast({
        title: 'Get desktop notifications?', body: 'For chat messages, calls and meetings when this tab is in the background.', sticky: true,
        actions: [
          { label: 'Turn on', primary: true, onClick: function () { Notification.requestPermission(); remember(); } },
          { label: 'Not now', onClick: remember },
        ],
      });
    }, 2500);
  }
  function remember() { try { localStorage.setItem('hub-notify-asked', '1'); } catch (e) { /* storage off */ } }
})();
