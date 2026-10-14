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
