'use strict';

const { todayIST, addDays, addMonths, isDate, formatDate } = require('./util');

const PRESETS = [
  ['month', 'This month'],
  ['3m', 'Last 3 months'],
  ['fy', 'This financial year'],
  ['lastfy', 'Last financial year'],
  ['all', 'All time'],
];

/** Start of the Indian financial year (1 April) containing a date. */
function fyStart(ymd) {
  const y = Number(ymd.slice(0, 4));
  return Number(ymd.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
}

/**
 * Reads ?period= (or ?from=&to=) into a date range. `all` runs from `earliest` (the first data we
 * have, e.g. the company's first bank transaction) to today.
 */
function periodFrom(query, { earliest = null, latest = null, fallback = 'fy' } = {}) {
  const today = todayIST();
  if (isDate(query.from) && isDate(query.to) && query.from <= query.to) {
    return { key: 'custom', from: query.from, to: query.to, label: `${formatDate(query.from)} – ${formatDate(query.to)}` };
  }
  const key = PRESETS.some((p) => p[0] === query.period) ? query.period : fallback;
  let from;
  let to = today;
  if (key === 'month') from = `${today.slice(0, 7)}-01`;
  else if (key === '3m') from = addMonths(`${today.slice(0, 7)}-01`, -2);
  else if (key === 'lastfy') { from = addMonths(fyStart(today), -12); to = addDays(fyStart(today), -1); }
  else if (key === 'all') from = earliest && earliest < today ? earliest : fyStart(today);
  else from = fyStart(today);
  if (key === 'all' && latest && latest > to) to = latest;
  const label = (PRESETS.find((p) => p[0] === key) || [])[1];
  return { key, from, to, label: `${label} · ${formatDate(from)} – ${formatDate(to)}` };
}

/** Month keys 'YYYY-MM' from one date to another, inclusive. */
function monthsBetween(from, to) {
  const out = [];
  let m = `${from.slice(0, 7)}-01`;
  while (m.slice(0, 7) <= to.slice(0, 7) && out.length < 240) { out.push(m.slice(0, 7)); m = addMonths(m, 1); }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key, withYear) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]}${withYear ? ` ${key.slice(2, 4)}` : ''}`;

module.exports = { PRESETS, fyStart, periodFrom, monthsBetween, monthLabel };
