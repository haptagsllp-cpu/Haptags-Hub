'use strict';

const crypto = require('crypto');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Current UTC time as 'YYYY-MM-DD HH:MM:SS'. */
function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD' + 'HH:MM' entered in India time -> UTC 'YYYY-MM-DD HH:MM:SS', or null if invalid. */
function istToUtc(dateStr, timeStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || ''));
  if (!d || !t || Number(t[1]) > 23 || Number(t[2]) > 59) return null;
  const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) - IST_OFFSET_MS;
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** UTC 'YYYY-MM-DD HH:MM:SS' -> { date: 'YYYY-MM-DD', time: 'HH:MM' } in India time. */
function utcToIst(value) {
  const ms = new Date(String(value).replace(' ', 'T') + 'Z').getTime() + IST_OFFSET_MS;
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Adds minutes to a UTC 'YYYY-MM-DD HH:MM:SS' string. */
function addMinutesSql(value, minutes) {
  const ms = new Date(String(value).replace(' ', 'T') + 'Z').getTime() + minutes * 60000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Today's date in India as 'YYYY-MM-DD'. Business dates (due dates, follow-ups) use IST. */
function todayIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parseDate(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(ymdStr, days) {
  const d = parseDate(ymdStr);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

/** Adds months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
function addMonths(ymdStr, months) {
  const d = parseDate(ymdStr);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return ymd(d);
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((parseDate(toYmd) - parseDate(fromYmd)) / 86400000);
}

/** Indian financial year label for a date, e.g. 2026-10-13 -> '26-27'. */
function financialYear(ymdStr) {
  const d = parseDate(ymdStr);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

function formatDate(value) {
  if (!value) return '';
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

/** '2:30 pm' in India time. */
function formatTime(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function timeAgo(value) {
  if (!value) return '';
  const then = new Date(String(value).replace(' ', 'T') + 'Z').getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(String(value).slice(0, 10));
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function str(value, max = 255) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function int(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDate(value).getTime());
}

/** 'awaiting_client' -> 'Awaiting client'. */
function humanize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

module.exports = {
  nowSql, todayIST, istToUtc, utcToIst, addMinutesSql, formatTime, addDays, addMonths, daysBetween, financialYear, parseDate, ymd,
  formatDate, formatDateTime, timeAgo, randomToken, sha256, safeEqual, str, int, isEmail, isDate, humanize,
};
