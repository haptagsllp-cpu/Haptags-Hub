'use strict';

const money = require('./money');
const util = require('./util');
const C = require('./constants');
const { icon } = require('./icons');

const TONES = {
  // leads
  new: 'blue', contacted: 'violet', qualified: 'cyan', proposal: 'amber', won: 'green', lost: 'grey',
  // invoices
  draft: 'grey', sent: 'blue', partially_paid: 'amber', overdue: 'red', paid: 'green', void: 'grey',
  // projects
  planning: 'grey', in_progress: 'blue', review: 'violet', on_hold: 'amber', completed: 'green', cancelled: 'grey',
  // quotes
  accepted: 'green', declined: 'red', expired: 'grey', invoiced: 'green',
  // tickets
  open: 'blue', awaiting_client: 'amber', resolved: 'green', closed: 'grey',
  // payments, retainers, clients
  confirmed: 'green', pending: 'amber', rejected: 'red', active: 'green', paused: 'amber', ended: 'grey', inactive: 'grey',
  // priorities
  low: 'grey', normal: 'blue', high: 'amber', urgent: 'red',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = {
  inr: money.formatINR,
  inrShort: money.formatINRShort,
  inrCompact: money.formatINRCompact,
  rupees: (p) => (p ? (Number(p) / 100).toFixed(2).replace(/\.00$/, '') : ''),
  words: money.amountInWords,
  date: util.formatDate,
  dateTime: util.formatDateTime,
  ago: util.timeAgo,
  today: util.todayIST,
  humanize: util.humanize,
  service: C.serviceLabel,
  budget: C.budgetLabel,
  timeline: C.timelineLabel,
  method: C.methodLabel,
  C,
  icon,
  badge(status, text) {
    return `<span class="badge tone-${TONES[status] || 'grey'}">${esc(text || util.humanize(status))}</span>`;
  },
  /** Plain text with line breaks preserved, safe for <%- %>. */
  nl2br: (s) => esc(s).replace(/\n/g, '<br>'),
  esc,
  selected: (a, b) => (String(a ?? '') === String(b ?? '') ? 'selected' : ''),
  checked: (v) => (v && v !== '0' ? 'checked' : ''),
  initials: (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(),
  waLink(phone, text) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    const num = digits.length === 10 ? `91${digits}` : digits;
    return `https://wa.me/${num}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  },
  qs(base, params) {
    const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
    return q.length ? `${base}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : base;
  },
};
