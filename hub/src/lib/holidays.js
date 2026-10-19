'use strict';

// Indian holidays for the team calendar. Google publishes "Holidays in India" as a public iCal
// feed that separates public holidays from observances and marks tentative dates (Eid etc.).
// We copy it into the database once a day, so the calendar never waits on Google.

const { db } = require('../db');
const { getSettings, setSettings } = require('./settings');
const { nowSql } = require('./util');

const GOOGLE_INDIA = 'https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics';
/** HOLIDAYS_ICS_URL overrides the feed; set it empty to turn syncing off. */
const feedUrl = () => (process.env.HOLIDAYS_ICS_URL === undefined ? GOOGLE_INDIA : process.env.HOLIDAYS_ICS_URL);
const DAY_MS = 24 * 60 * 60 * 1000;

const unescape = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** Parses VEVENTs from iCal text into { date, name, kind, tentative }. */
function parseIcs(text) {
  // Unfold continuation lines (RFC 5545: a line starting with a space continues the previous one).
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') {
      if (ev && ev.date && ev.name) out.push(ev);
      ev = null;
    } else if (ev) {
      const i = line.indexOf(':');
      if (i === -1) continue;
      const key = line.slice(0, i).split(';')[0];
      const value = line.slice(i + 1);
      if (key === 'DTSTART') {
        const m = /(\d{4})(\d{2})(\d{2})/.exec(value);
        if (m) ev.date = `${m[1]}-${m[2]}-${m[3]}`;
      } else if (key === 'SUMMARY') ev.name = unescape(value).replace(/\s*\(tentative\)\s*$/i, '').slice(0, 190);
      else if (key === 'DESCRIPTION') {
        const d = unescape(value);
        ev.kind = /public holiday/i.test(d) ? 'public' : 'observance';
        ev.tentative = /tentative/i.test(d);
      }
    }
  }
  return out.map((e) => ({ ...e, kind: e.kind || 'observance', tentative: Boolean(e.tentative) }));
}

/** Replaces the synced holidays with the feed's current list. Returns how many were stored. */
async function syncHolidays() {
  const FEED = feedUrl();
  if (!FEED) return 0;
  const res = await fetch(FEED, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`The holiday calendar answered ${res.status}.`);
  const events = parseIcs(await res.text());
  if (!events.length) throw new Error('The holiday calendar came back empty.');
  // De-duplicate (the feed occasionally lists the same day twice).
  const seen = new Set();
  const rows = events.filter((e) => {
    const k = `${e.date}|${e.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((e) => ({ date: e.date, name: e.name, kind: e.kind, source: 'google', tentative: e.tentative, created_at: nowSql() }));
  await db.transaction(async (trx) => {
    await trx('holidays').where({ source: 'google' }).del();
    for (let i = 0; i < rows.length; i += 200) await trx('holidays').insert(rows.slice(i, i + 200));
  });
  await setSettings({ holidays_synced_at: nowSql() });
  return rows.length;
}

/** Syncs when the copy is more than a day old (or missing). Never throws. */
async function syncIfStale() {
  try {
    const s = await getSettings();
    const last = s.holidays_synced_at ? new Date(`${s.holidays_synced_at.replace(' ', 'T')}Z`).getTime() : 0;
    if (Date.now() - last < DAY_MS) return 0;
    return await syncHolidays();
  } catch (err) {
    console.error('[holidays]', err.message);
    return 0;
  }
}

/** Holidays between two dates (inclusive). Observances only when asked for. */
function between(from, to, { observances = false } = {}) {
  const q = db('holidays').whereBetween('date', [from, to]).orderBy('date').orderByRaw("CASE kind WHEN 'company' THEN 0 WHEN 'public' THEN 1 ELSE 2 END");
  if (!observances) q.whereNot('kind', 'observance');
  return q;
}

module.exports = { feedUrl, parseIcs, syncHolidays, syncIfStale, between };
