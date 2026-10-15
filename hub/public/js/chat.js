/* Haptags Hub: team chat. Messages are rendered with textContent only (never innerHTML). */
(function () {
  'use strict';

  var dataEl = document.getElementById('chat-data');
  if (!dataEl || !window.HubRT) return;
  var data = JSON.parse(dataEl.textContent);
  var me = data.me;
  var channelId = data.channelId;
  var RT = window.HubRT;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  // ---- Sidebar unread counts (other conversations) ----
  function bumpList(id, delta, reset) {
    var link = $('[data-channel-link="' + id + '"]');
    if (!link) return false;
    var c = $('[data-unread]', link);
    var n = reset ? 0 : Math.max(0, (parseInt(c.textContent, 10) || 0) + delta);
    c.textContent = n; c.hidden = n === 0;
    return true;
  }

  window.addEventListener('hub:rt', function (ev) {
    var e = ev.detail;
    if (e.type === 'chat.message' && e.data.channelId !== channelId && e.data.message.userId !== me.id && e.data.message.kind !== 'system') {
      // A brand-new conversation someone started with us: reload so it appears in the list.
      if (!bumpList(e.data.channelId, 1)) setTimeout(function () { if (!$('[data-input]') || !$('[data-input]').value) location.reload(); }, 400);
    }
  });

  if (!channelId) return;
  RT.activeChannel = channelId;

  var scroller = $('[data-scroll]');
  var listEl = $('[data-messages]');
  var moreBtn = $('[data-more]');
  var input = $('[data-input]');
  var form = $('[data-composer]');
  var fileInput = $('[data-file]');
  var typingEl = $('[data-typing]');
  var messages = [];
  var byId = {};
  var firstName = me.name.split(' ')[0].toLowerCase();

  // ---- Formatting ----
  var dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  var timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  var keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
  function dayKey(iso) { return keyFmt.format(new Date(iso)); }
  function dayLabel(iso) {
    var k = dayKey(iso);
    var today = keyFmt.format(new Date());
    var yest = keyFmt.format(new Date(Date.now() - 86400000));
    return k === today ? 'Today' : k === yest ? 'Yesterday' : dayFmt.format(new Date(iso));
  }
  function size(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function initials(name) { return String(name || '?').split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }
  function el(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text !== undefined) x.textContent = text;
    return x;
  }

  /** Text with clickable links and highlighted @mentions. */
  function richText(text) {
    var frag = document.createDocumentFragment();
    var re = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(@[\w.-]+)/g;
    var last = 0; var m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) {
        var a = el('a', null, m[1]); a.href = m[1]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        frag.appendChild(a);
      } else {
        frag.appendChild(el('span', m[2].slice(1).toLowerCase() === firstName || m[2] === '@everyone' ? 'mention mention-me' : 'mention', m[2]));
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function continues(m, prev) {
    return prev && prev.userId === m.userId && prev.kind === 'text' && m.kind === 'text' && !prev.deleted
      && dayKey(prev.createdAt) === dayKey(m.createdAt) && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60000;
  }

  function render(m, prev) {
    if (m.kind === 'system') {
      var s = el('div', 'cmsg-system');
      s.appendChild(el('span', null, m.body + ' · ' + timeFmt.format(new Date(m.createdAt))));
      s.setAttribute('data-id', m.id);
      return s;
    }
    var mine = m.userId === me.id;
    var row = el('div', 'cmsg' + (mine ? ' mine' : '') + (continues(m, prev) ? ' cont' : '') + (m.deleted ? ' deleted' : ''));
    row.setAttribute('data-id', m.id);
    row.appendChild(el('span', 'avatar avatar-sm', initials(m.userName)));
    var main = el('div', 'cmsg-main');
    var meta = el('div', 'cmsg-meta');
    meta.appendChild(el('b', null, mine ? 'You' : m.userName));
    var t = el('time', null, timeFmt.format(new Date(m.createdAt)));
    t.dateTime = m.createdAt; t.title = new Date(m.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    meta.appendChild(t);
    if (m.edited && !m.deleted) meta.appendChild(el('span', 'muted', '(edited)'));
    main.appendChild(meta);

    if (m.deleted) {
      main.appendChild(el('div', 'cmsg-body muted', 'This message was deleted'));
    } else if (m.kind === 'call') {
      var call = el('div', 'cmsg-call');
      call.appendChild(el('span', 'cmsg-call-ico', '📞'));
      call.appendChild(el('span', null, (mine ? 'You' : m.userName) + ' started a call'));
      if (m.meeting) {
        var j = el('a', 'btn btn-success btn-sm', 'Join'); j.href = m.meeting.url; j.target = '_blank'; j.rel = 'noopener';
        call.appendChild(j);
      }
      main.appendChild(call);
    } else {
      if (m.body) { var b = el('div', 'cmsg-body'); b.appendChild(richText(m.body)); main.appendChild(b); }
      if (m.file) {
        var url = '/admin/chat/files/' + m.file.id;
        if (m.file.image) {
          var ia = el('a', 'cmsg-img'); ia.href = url; ia.target = '_blank'; ia.rel = 'noopener';
          var img = el('img'); img.src = url; img.alt = m.file.name; img.loading = 'lazy';
          img.addEventListener('load', function () { if (atBottom(200)) toBottom(); });
          ia.appendChild(img); main.appendChild(ia);
        } else {
          var fa = el('a', 'cmsg-file'); fa.href = url + '?download=1';
          fa.appendChild(el('span', 'cmsg-file-ico', '📄'));
          var fi = el('span', 'cmsg-file-info'); fi.appendChild(el('b', null, m.file.name)); fi.appendChild(el('span', 'muted', size(m.file.size)));
          fa.appendChild(fi); main.appendChild(fa);
        }
      }
    }
    row.appendChild(main);

    if (mine && !m.deleted && m.kind !== 'call') {
      var acts = el('div', 'cmsg-actions');
      if (m.kind === 'text' && !m.file) { var eb = el('button', 'btn-link', 'Edit'); eb.type = 'button'; eb.setAttribute('data-edit', m.id); acts.appendChild(eb); }
      var db = el('button', 'btn-link danger', 'Delete'); db.type = 'button'; db.setAttribute('data-delete', m.id); acts.appendChild(db);
      row.appendChild(acts);
    }
    return row;
  }

  function dayDivider(m) {
    var d = el('div', 'msg-day'); d.appendChild(el('span', null, dayLabel(m.createdAt)));
    d.setAttribute('data-day', dayKey(m.createdAt));
    return d;
  }

  /** Re-renders everything (initial load and older pages). */
  function renderAll() {
    listEl.textContent = '';
    if (!messages.length) {
      var empty = el('div', 'empty chat-start');
      empty.appendChild(el('b', null, 'This is the start of the conversation'));
      empty.appendChild(document.createTextNode('Say hello 👋'));
      listEl.appendChild(empty);
      return;
    }
    var prev = null;
    messages.forEach(function (m) {
      if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) listEl.appendChild(dayDivider(m));
      listEl.appendChild(render(m, prev));
      prev = m;
    });
  }

  function append(m) {
    if (byId[m.id]) return false;
    var prev = messages[messages.length - 1];
    if (!prev) listEl.textContent = '';
    messages.push(m); byId[m.id] = m;
    if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) listEl.appendChild(dayDivider(m));
    listEl.appendChild(render(m, prev));
    return true;
  }

  function replace(m) {
    var i = messages.findIndex(function (x) { return x.id === m.id; });
    if (i === -1) return;
    messages[i] = m; byId[m.id] = m;
    var old = $('[data-id="' + m.id + '"]', listEl);
    if (old) old.replaceWith(render(m, messages[i - 1]));
  }

  function atBottom(slack) { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < (slack || 80); }
  function toBottom() { scroller.scrollTop = scroller.scrollHeight; }

  // ---- Read receipts (our own position) ----
  var readTimer = null;
  function markRead() {
    if (document.visibilityState !== 'visible' || !messages.length) return;
    clearTimeout(readTimer);
    readTimer = setTimeout(function () { RT.post('/admin/chat/' + channelId + '/read', { id: messages[messages.length - 1].id }); }, 600);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { markRead(); RT.activeChannel = channelId; }
  });

  // ---- "New messages" pill when scrolled up ----
  var pill = el('button', 'new-pill', 'New messages ↓'); pill.type = 'button'; pill.hidden = true;
  scroller.parentNode.insertBefore(pill, scroller.nextSibling);
  pill.addEventListener('click', function () { toBottom(); pill.hidden = true; });
  scroller.addEventListener('scroll', function () { if (atBottom()) pill.hidden = true; });

  function incoming(m) {
    var stick = atBottom() || m.userId === me.id;
    if (!append(m)) return;
    typingFrom[m.userId] = 0; paintTyping();
    if (stick) toBottom(); else pill.hidden = false;
    markRead();
  }

  // ---- Initial load ----
  messages = data.messages.slice();
  messages.forEach(function (m) { byId[m.id] = m; });
  renderAll();
  toBottom();
  moreBtn.hidden = messages.length < 60;

  moreBtn.addEventListener('click', function () {
    if (!messages.length) return;
    moreBtn.disabled = true;
    fetch('/admin/chat/' + channelId + '/messages?before=' + messages[0].id, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var h = scroller.scrollHeight;
        var older = res.messages.filter(function (m) { return !byId[m.id]; });
        older.forEach(function (m) { byId[m.id] = m; });
        messages = older.concat(messages);
        renderAll();
        scroller.scrollTop = scroller.scrollHeight - h;
        moreBtn.hidden = res.messages.length < 60;
      })
      .finally(function () { moreBtn.disabled = false; });
  });

  function catchUp() {
    var last = messages.length ? messages[messages.length - 1].id : 0;
    fetch('/admin/chat/' + channelId + '/messages?after=' + last, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (res) { res.messages.forEach(incoming); });
  }

  // ---- Live events ----
  var typingFrom = {};
  function paintTyping() {
    var now = Date.now();
    var names = Object.keys(typingFrom).filter(function (k) { return typingFrom[k] > now; }).map(function (k) { return typingFrom['n' + k]; });
    typingEl.textContent = !names.length ? '' : names.length === 1 ? names[0] + ' is typing…' : names.join(', ') + ' are typing…';
  }
  setInterval(paintTyping, 1000);

  window.addEventListener('hub:rt', function (ev) {
    var e = ev.detail;
    if (!e.data || e.data.channelId !== channelId) return;
    if (e.type === 'chat.message') incoming(e.data.message);
    else if (e.type === 'chat.update') replace(e.data.message);
    else if (e.type === 'chat.typing') {
      typingFrom[e.data.userId] = Date.now() + 4000; typingFrom['n' + e.data.userId] = e.data.name.split(' ')[0];
      paintTyping();
    }
  });
  window.addEventListener('hub:reset', catchUp);

  // ---- Composer ----
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
  var lastTyping = 0;
  input.addEventListener('input', function () {
    grow();
    if (input.value.trim() && Date.now() - lastTyping > 3000) {
      lastTyping = Date.now();
      RT.post('/admin/chat/' + channelId + '/typing');
    }
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(); });

  var draftKey = 'hub-draft-' + channelId;
  try { input.value = sessionStorage.getItem(draftKey) || ''; grow(); } catch (e) { /* storage off */ }
  input.addEventListener('input', function () { try { sessionStorage.setItem(draftKey, input.value); } catch (e) { /* storage off */ } });

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = ''; grow();
    try { sessionStorage.removeItem(draftKey); } catch (e) { /* storage off */ }
    lastTyping = 0;
    RT.post('/admin/chat/' + channelId + '/messages', { body: text })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Not sent'); return j; }); })
      .then(function (res) { incoming(res.message); })
      .catch(function (err) {
        input.value = text; grow();
        RT.toast({ title: 'Message not sent', body: err.message === 'Failed to fetch' ? 'Check your connection and try again.' : err.message, tone: 'important' });
      });
  }
  input.focus();

  // ---- Files: picker, drag and drop, paste ----
  var MAX = 8 * 1024 * 1024;
  function upload(file) {
    if (!file) return;
    if (file.size > MAX) { RT.toast({ title: 'File too large', body: 'Files can be up to 8 MB. Share a Drive link for bigger ones.', tone: 'important' }); return; }
    var name = file.name || ('pasted-' + Date.now() + '.png');
    typingEl.textContent = 'Uploading ' + name + '…';
    fetch('/admin/chat/' + channelId + '/files', {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-csrf-token': RT.csrf },
    })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j; }); })
      .then(function (res) { typingEl.textContent = ''; incoming(res.message); })
      .catch(function (err) { typingEl.textContent = ''; RT.toast({ title: 'Upload failed', body: err.message, tone: 'important' }); });
  }
  fileInput.addEventListener('change', function () { Array.prototype.forEach.call(fileInput.files, upload); fileInput.value = ''; });
  var main = $('.chat-main');
  main.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) { e.preventDefault(); main.classList.add('dropping'); } });
  main.addEventListener('dragleave', function (e) { if (!main.contains(e.relatedTarget)) main.classList.remove('dropping'); });
  main.addEventListener('drop', function (e) {
    main.classList.remove('dropping');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); Array.prototype.forEach.call(e.dataTransfer.files, upload);
  });
  input.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); Array.prototype.forEach.call(files, upload); }
  });

  // ---- Edit / delete own messages ----
  listEl.addEventListener('click', function (e) {
    var del = e.target.closest('[data-delete]');
    if (del) {
      if (!window.confirm('Delete this message for everyone?')) return;
      RT.post('/admin/chat/messages/' + del.getAttribute('data-delete') + '/delete').then(function (r) { return r.json(); }).then(function (res) { if (res.message) replace(res.message); });
      return;
    }
    var ed = e.target.closest('[data-edit]');
    if (!ed) return;
    var m = byId[ed.getAttribute('data-edit')];
    var row = ed.closest('.cmsg');
    var body = $('.cmsg-body', row);
    if (!m || !body || $('textarea', row)) return;
    var box = el('div', 'cmsg-edit');
    var ta = el('textarea'); ta.value = m.body; ta.rows = 2;
    var save = el('button', 'btn btn-sm', 'Save'); save.type = 'button';
    var cancel = el('button', 'btn btn-ghost btn-sm', 'Cancel'); cancel.type = 'button';
    var btns = el('div', 'row mt-8'); btns.appendChild(save); btns.appendChild(cancel);
    box.appendChild(ta); box.appendChild(btns);
    body.replaceWith(box); ta.focus();
    cancel.addEventListener('click', function () { replace(m); });
    function commit() {
      var text = ta.value.trim();
      if (!text || text === m.body) return replace(m);
      RT.post('/admin/chat/messages/' + m.id + '/edit', { body: text }).then(function (r) { return r.json(); }).then(function (res) { replace(res.message || m); });
    }
    save.addEventListener('click', commit);
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') replace(m);
    });
  });

  markRead();
})();
