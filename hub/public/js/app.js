/* Haptags Hub — progressive enhancement only; every form also works without JS. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // Mobile sidebar
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-nav-toggle]');
    if (t) { document.body.classList.toggle('nav-open'); return; }
    if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar')) document.body.classList.remove('nav-open');
  });

  // Copy to clipboard: data-copy="#inputId" or data-copy-text="literal"
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy], [data-copy-text]');
    if (!b) return;
    e.preventDefault();
    var text = b.getAttribute('data-copy-text');
    if (!text) { var el = $(b.getAttribute('data-copy')); text = el ? (el.value || el.textContent) : ''; }
    var done = function () { var old = b.innerHTML; b.textContent = 'Copied ✓'; setTimeout(function () { b.innerHTML = old; }, 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
  });

  // Confirm destructive actions
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
    var btn = f.querySelector('button[type=submit]:not([name])');
    if (!e.defaultPrevented && btn && !f.hasAttribute('data-no-disable')) setTimeout(function () { btn.disabled = true; }, 0);
  });

  // Dialogs: data-dialog="#id" opens a <dialog>; data-close or a click on the backdrop closes it.
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-dialog]');
    if (opener) {
      var d = $(opener.getAttribute('data-dialog'));
      if (d && d.showModal) { e.preventDefault(); d.showModal(); }
      return;
    }
    if (e.target.closest('[data-close]')) { var c = e.target.closest('dialog'); if (c) c.close(); return; }
    if (e.target.tagName === 'DIALOG') e.target.close();
  });

  // Show a block while a checkbox is ticked: data-toggle-target="#id"
  $$('[data-toggle-target]').forEach(function (cb) {
    var target = $(cb.getAttribute('data-toggle-target'));
    if (!target) return;
    var sync = function () { target.hidden = !cb.checked; };
    cb.addEventListener('change', sync); sync();
  });

  // Enrolment form: picking a program fills its fee; a summary shows the instalments.
  var enrol = $('[data-enrol]');
  if (enrol) {
    var inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
    var prog = $('[name=program_id]', enrol);
    var fee = $('[name=fee]', enrol);
    var summary = function () {
      var total = Math.max(0, (parseFloat(fee.value) || 0) - (parseFloat($('[name=discount]', enrol).value) || 0));
      var n = parseInt($('[name=installments]', enrol).value, 10) || 1;
      var paid = parseFloat($('[name=paid_now]', enrol).value) || 0;
      $('[data-enrol-summary]', enrol).textContent = total
        ? 'Student pays ' + inr.format(total) + (n > 1 ? ' in ' + n + ' instalments of about ' + inr.format(total / n) : '') + (paid ? '; ' + inr.format(paid) + ' received now, ' + inr.format(Math.max(0, total - paid)) + ' left.' : '.')
        : '';
    };
    prog.addEventListener('change', function () {
      var f = prog.selectedOptions[0] && prog.selectedOptions[0].getAttribute('data-fee');
      if (f) fee.value = f;
      summary();
    });
    enrol.addEventListener('input', summary);
    summary();
  }

  // Bank statement upload: send the file as-is (no multipart), then show the result.
  $$('[data-bank-upload]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var file = $('[data-file]', form).files[0];
      if (!file) return; // pasted text goes as a normal form post
      e.preventDefault();
      var err = $('[data-upload-error]', form);
      var btn = $('button[type=submit]', form);
      err.textContent = '';
      if (file.size > 5 * 1024 * 1024) { err.textContent = 'That file is over 5 MB. Upload the statement in parts (e.g. one year at a time).'; return; }
      btn.disabled = true; btn.textContent = 'Reading statement…';
      fetch('/admin/finance/import', {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: {
          'content-type': 'text/csv', accept: 'application/json',
          'x-csrf-token': $('meta[name=csrf-token]').content,
          'x-account': encodeURIComponent($('[name=account]', form).value || ''),
          'x-file-name': encodeURIComponent(file.name),
        },
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j; }); })
        .then(function () { location.href = '/admin/finance?period=all'; })
        .catch(function (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Upload & analyse'; });
    });
  });

  // Student CSV import: read the chosen file into the form, then submit it normally.
  $$('[data-csv-upload]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var file = $('[data-file]', form).files[0];
      if (!file || form.getAttribute('data-ready')) return;
      e.preventDefault();
      if (file.size > 2 * 1024 * 1024) { $('[data-upload-error]', form).textContent = 'That file is over 2 MB.'; return; }
      var reader = new FileReader();
      reader.onload = function () { $('[name=csv]', form).value = reader.result; form.setAttribute('data-ready', '1'); form.submit(); };
      reader.readAsText(file);
    });
  });

  // Certificate upload on a student's page: the file goes as-is, the fields in the query string.
  $$('[data-cert-upload]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var file = $('[data-file]', form).files[0];
      var err = $('[data-upload-error]', form);
      err.textContent = '';
      if (!file) { err.textContent = 'Choose the certificate file.'; return; }
      if (file.size > 8 * 1024 * 1024) { err.textContent = 'That file is over 8 MB.'; return; }
      var q = new URLSearchParams();
      ['certificate_no', 'programme', 'issued_on', 'grade'].forEach(function (n) { var el = $('[name=' + n + ']', form); if (el && el.value) q.set(n, el.value); });
      fetch(form.getAttribute('data-cert-upload') + '?' + q.toString(), {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'content-type': file.type || 'application/pdf', accept: 'application/json', 'x-csrf-token': $('meta[name=csrf-token]').content },
      }).then(function (r) { return r.json(); })
        .then(function (j) { if (!j.ok) throw new Error(j.message || 'Upload failed'); location.reload(); })
        .catch(function (x) { err.textContent = x.message; });
    });
  });

  // Bank transactions: changing a category saves at once.
  document.addEventListener('change', function (e) {
    var sel = e.target.closest('[data-txn-category]');
    if (!sel) return;
    var form = sel.form;
    var body = new URLSearchParams({ _csrf: $('meta[name=csrf-token]').content, category: sel.value });
    sel.disabled = true;
    fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' }, body: body })
      .then(function (r) { if (!r.ok) throw new Error(); })
      .then(function () {
        var row = sel.closest('tr');
        if (row) row.classList.toggle('needs-review', sel.value === 'uncategorized');
        sel.classList.add('saved'); setTimeout(function () { sel.classList.remove('saved'); }, 1200);
      })
      .catch(function () { window.alert('Couldn’t save that change. Please try again.'); })
      .then(function () { sel.disabled = false; });
  });

  // Bulk selection on lists: [data-check] boxes feed a [data-bulk] bar; [data-check-all] ticks the page.
  var bulk = $('[data-bulk]');
  if (bulk) {
    var boxes = $$('[data-check]');
    var syncBulk = function () {
      var n = boxes.filter(function (b) { return b.checked; }).length;
      bulk.hidden = n === 0;
      $('[data-bulk-count]', bulk).textContent = n + ' selected';
      var all = $('[data-check-all]');
      if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
    };
    boxes.forEach(function (b) { b.addEventListener('change', syncBulk); });
    var allBox = $('[data-check-all]');
    if (allBox) allBox.addEventListener('change', function () { boxes.forEach(function (b) { b.checked = allBox.checked; }); syncBulk(); });
    syncBulk();
  }

  // A checkbox that switches between two URLs (e.g. show/hide observances on the calendar).
  $$('[data-href-on]').forEach(function (cb) {
    cb.addEventListener('change', function () { location.href = cb.getAttribute(cb.checked ? 'data-href-on' : 'data-href-off'); });
  });

  // Auto-submit filters
  $$('[data-autosubmit]').forEach(function (el) { el.addEventListener('change', function () { el.form.submit(); }); });

  // Print
  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  // Show a field only when a select has a given value: data-show-when="#status=lost"
  $$('[data-show-when]').forEach(function (el) {
    var parts = el.getAttribute('data-show-when').split('=');
    var src = $(parts[0]);
    if (!src) return;
    var sync = function () { el.hidden = src.value !== parts[1]; };
    src.addEventListener('change', sync); sync();
  });

  // Chart tooltips (per-column hover / focus)
  var tip = null;
  function showTip(target) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; tip.setAttribute('role', 'status'); document.body.appendChild(tip); }
    var r = target.getBoundingClientRect();
    tip.textContent = target.getAttribute('data-tip');
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top = (r.top + Math.min(40, r.height / 3)) + 'px';
    tip.hidden = false;
  }
  function hideTip() { if (tip) tip.hidden = true; }
  $$('.chart .hit[data-tip]').forEach(function (h) {
    h.addEventListener('mouseenter', function () { showTip(h); });
    h.addEventListener('focus', function () { showTip(h); });
    h.addEventListener('mouseleave', hideTip);
    h.addEventListener('blur', hideTip);
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  // ---- Line-item editor with live GST totals ----
  var editor = $('[data-doc-editor]');
  if (editor) {
    var tbody = $('#items tbody', editor);
    var tpl = $('#item-template');
    var fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
    var num = function (v) { var n = parseFloat(String(v || '').replace(/[₹,\s]/g, '')); return isFinite(n) ? n : 0; };
    var taxSel = $('[name=tax_mode]', editor);
    var rateIn = $('[name=gst_rate]', editor);
    var discIn = $('[name=discount]', editor);

    var recalc = function () {
      var sub = 0;
      $$('tr', tbody).forEach(function (tr) {
        var q = num($('[name=item_qty]', tr).value); var r = num($('[name=item_rate]', tr).value);
        var amt = Math.round(q * r * 100) / 100; sub += amt;
        $('.amt', tr).textContent = fmt.format(amt);
      });
      var disc = Math.min(discIn ? num(discIn.value) : 0, sub);
      var taxable = sub - disc;
      var rate = rateIn ? num(rateIn.value) : 0;
      var mode = taxSel ? taxSel.value : 'none';
      var half = mode === 'intra' ? Math.round(taxable * rate / 2) / 100 : 0;
      var igst = mode === 'inter' ? Math.round(taxable * rate) / 100 : 0;
      var set = function (k, v, show) { var el = $('[data-total=' + k + ']', editor); if (el) { el.textContent = fmt.format(v); el.parentNode.hidden = show === false; } };
      set('subtotal', sub); set('discount', -disc, disc > 0);
      set('cgst', half, mode === 'intra'); set('sgst', half, mode === 'intra'); set('igst', igst, mode === 'inter');
      set('total', taxable + half * 2 + igst);
      $$('[data-rate-label]', editor).forEach(function (l) { l.textContent = (l.getAttribute('data-rate-label') === 'half' ? rate / 2 : rate) + '%'; });
    };

    editor.addEventListener('input', recalc);
    editor.addEventListener('change', recalc);
    editor.addEventListener('click', function (e) {
      if (e.target.closest('[data-add-item]')) {
        e.preventDefault();
        var row = tpl.content.firstElementChild.cloneNode(true);
        var lastSac = $$('[name=item_sac]', tbody).pop();
        if (lastSac && lastSac.value) $('[name=item_sac]', row).value = lastSac.value;
        tbody.appendChild(row); $('[name=item_description]', row).focus(); recalc();
      }
      var rm = e.target.closest('[data-remove-item]');
      if (rm) {
        e.preventDefault();
        if ($$('tr', tbody).length > 1) rm.closest('tr').remove();
        else $$('input', rm.closest('tr')).forEach(function (i) { i.value = i.name === 'item_qty' ? '1' : ''; });
        recalc();
      }
    });

    // Pick CGST+SGST vs IGST from the client's state (only when we're GST-registered).
    var clientSel = $('[name=client_id]', editor);
    var projectSel = $('[name=project_id]', editor);
    var syncProjects = function () {
      if (!projectSel || !clientSel) return;
      $$('option[data-client]', projectSel).forEach(function (o) {
        o.hidden = clientSel.value && o.getAttribute('data-client') !== clientSel.value;
        if (o.hidden && o.selected) projectSel.value = '';
      });
    };
    if (clientSel && taxSel) {
      clientSel.addEventListener('change', function () {
        var o = clientSel.selectedOptions[0];
        var registered = editor.getAttribute('data-gst-registered') === '1';
        var home = (editor.getAttribute('data-company-state') || '').toLowerCase();
        if (o && o.value) {
          var st = (o.getAttribute('data-state') || '').toLowerCase();
          var country = (o.getAttribute('data-country') || 'india').toLowerCase();
          taxSel.value = !registered || country !== 'india' ? 'none' : (st && st !== home ? 'inter' : 'intra');
        }
        syncProjects(); recalc();
      });
    }
    syncProjects();
    recalc();
  }
})();
