'use strict';

const express = require('express');
const { db } = require('../../db');
const M = require('../../lib/meetings');
const C = require('../../lib/constants');
const H = require('../../lib/holidays');
const { requireAdmin } = require('../../lib/auth');
const { todayIST, istToUtc, utcToIst, addDays, addMonths, parseDate, str, int, isDate, nowSql } = require('../../lib/util');
const { idParam } = require('./_helpers');

const router = express.Router();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Month view (India time): your meetings, plus project deadlines and lead follow-ups for the team.
router.get('/', async (req, res) => {
  const today = todayIST();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const first = `${month}-01`;
  // Weeks start on Monday.
  const lead = (parseDate(first).getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -lead);
  const nextMonth = addMonths(first, 1);
  const weeks = Math.ceil((lead + (parseDate(nextMonth) - parseDate(first)) / 86400000) / 7);
  const gridEnd = addDays(gridStart, weeks * 7);
  const mine = req.query.scope !== 'team';
  const observances = req.query.obs === '1';

  // Indian holidays: fetch them the first time, then refresh in the background once a day.
  if (!(await db('holidays').first())) await H.syncIfStale();
  else H.syncIfStale();

  const meetingQuery = mine
    ? M.meetingsFor(req.user.id, { from: istToUtc(gridStart, '00:00'), to: istToUtc(gridEnd, '00:00') })
    : db('meetings as m').where('m.status', 'scheduled').where('m.starts_at', '>=', istToUtc(gridStart, '00:00'))
      .where('m.starts_at', '<', istToUtc(gridEnd, '00:00')).orderBy('m.starts_at').select('m.*');
  const [meetings, projects, followUps, holidays] = await Promise.all([
    meetingQuery,
    db('projects as p').join('clients as c', 'c.id', 'p.client_id').whereIn('p.status', ['planning', 'in_progress', 'review'])
      .whereBetween('p.due_date', [gridStart, gridEnd]).select('p.id', 'p.name', 'p.due_date', 'c.name as client_name'),
    db('leads').whereIn('status', C.LEAD_OPEN).whereBetween('next_follow_up', [gridStart, gridEnd])
      .modify((q) => { if (mine) q.where((w) => w.where('assigned_to', req.user.id).orWhereNull('assigned_to')); })
      .select('id', 'name', 'company', 'next_follow_up'),
    H.between(gridStart, gridEnd, { observances }),
  ]);

  const days = {};
  const add = (date, item) => { (days[date] = days[date] || []).push(item); };
  for (const m of meetings) {
    const t = utcToIst(m.starts_at);
    add(t.date, { kind: 'meeting', time: t.time, title: m.title, href: `/admin/meetings/${m.id}` });
  }
  for (const p of projects) add(String(p.due_date).slice(0, 10), { kind: 'project', title: `Due: ${p.name}`, href: `/admin/projects/${p.id}` });
  for (const l of followUps) add(String(l.next_follow_up).slice(0, 10), { kind: 'lead', title: `Follow up: ${l.company || l.name}`, href: `/admin/leads/${l.id}` });
  for (const list of Object.values(days)) list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const holidaysByDay = {};
  for (const hd of holidays) (holidaysByDay[String(hd.date).slice(0, 10)] = holidaysByDay[String(hd.date).slice(0, 10)] || []).push(hd);

  const grid = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const date = addDays(gridStart, i);
    const hs = holidaysByDay[date] || [];
    grid.push({
      date, day: Number(date.slice(8)), inMonth: date.slice(0, 7) === month, today: date === today, items: days[date] || [],
      holidays: hs, off: hs.some((x) => x.kind !== 'observance'),
    });
  }
  const [y, mm] = month.split('-').map(Number);
  res.render('admin/calendar', {
    title: 'Calendar', grid, mine, today, observances,
    monthHolidays: holidays.filter((x) => String(x.date).slice(0, 7) === month),
    label: `${MONTHS[mm - 1]} ${y}`, month,
    prev: addMonths(first, -1).slice(0, 7), next: nextMonth.slice(0, 7),
    agenda: (days[today] || []),
  });
});

// ---------------- Holidays ----------------
router.get('/holidays', async (req, res) => {
  if (!(await db('holidays').first())) await H.syncIfStale();
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : todayIST().slice(0, 4);
  const observances = req.query.obs === '1';
  const rows = await H.between(`${year}-01-01`, `${year}-12-31`, { observances });
  const s = res.locals.settings;
  res.render('admin/holidays', {
    title: `Holidays ${year}`, year: Number(year), rows, observances, today: todayIST(), syncedAt: s.holidays_synced_at, feed: Boolean(H.feedUrl()),
  });
});

router.post('/holidays', requireAdmin, async (req, res) => {
  const name = str(req.body.name, 190);
  const date = isDate(req.body.date) ? req.body.date : null;
  const back = `/admin/calendar/holidays?year=${(date || todayIST()).slice(0, 4)}`;
  if (!name || !date) {
    req.flash('error', 'Give the holiday a date and a name.');
    return res.redirect(back);
  }
  if (await db('holidays').where({ date, name, source: 'company' }).first()) {
    req.flash('error', 'That holiday is already on the list.');
    return res.redirect(back);
  }
  await db('holidays').insert({ date, name, kind: 'company', source: 'company', note: str(req.body.note, 255), created_by: req.user.id, created_at: nowSql() });
  req.flash('success', `${name} added for the whole team.`);
  res.redirect(back);
});

router.post('/holidays/sync', requireAdmin, async (req, res) => {
  try {
    const n = await H.syncHolidays();
    req.flash('success', `Indian holidays updated (${n} dates).`);
  } catch (err) {
    req.flash('error', `Couldn’t update the holiday list: ${err.message}`);
  }
  res.redirect('/admin/calendar/holidays');
});

router.post('/holidays/:id/delete', requireAdmin, async (req, res) => {
  const hd = await db('holidays').where({ id: idParam(req), source: 'company' }).first();
  if (hd) {
    await db('holidays').where({ id: hd.id }).del();
    req.flash('success', `${hd.name} removed.`);
  }
  res.redirect(`/admin/calendar/holidays?year=${hd ? String(hd.date).slice(0, 4) : todayIST().slice(0, 4)}`);
});

module.exports = router;
