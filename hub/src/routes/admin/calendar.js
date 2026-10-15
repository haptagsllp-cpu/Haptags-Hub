'use strict';

const express = require('express');
const { db } = require('../../db');
const M = require('../../lib/meetings');
const C = require('../../lib/constants');
const { todayIST, istToUtc, utcToIst, addDays, addMonths, parseDate } = require('../../lib/util');

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

  const meetingQuery = mine
    ? M.meetingsFor(req.user.id, { from: istToUtc(gridStart, '00:00'), to: istToUtc(gridEnd, '00:00') })
    : db('meetings as m').where('m.status', 'scheduled').where('m.starts_at', '>=', istToUtc(gridStart, '00:00'))
      .where('m.starts_at', '<', istToUtc(gridEnd, '00:00')).orderBy('m.starts_at').select('m.*');
  const [meetings, projects, followUps] = await Promise.all([
    meetingQuery,
    db('projects as p').join('clients as c', 'c.id', 'p.client_id').whereIn('p.status', ['planning', 'in_progress', 'review'])
      .whereBetween('p.due_date', [gridStart, gridEnd]).select('p.id', 'p.name', 'p.due_date', 'c.name as client_name'),
    db('leads').whereIn('status', C.LEAD_OPEN).whereBetween('next_follow_up', [gridStart, gridEnd])
      .modify((q) => { if (mine) q.where((w) => w.where('assigned_to', req.user.id).orWhereNull('assigned_to')); })
      .select('id', 'name', 'company', 'next_follow_up'),
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

  const grid = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const date = addDays(gridStart, i);
    grid.push({ date, day: Number(date.slice(8)), inMonth: date.slice(0, 7) === month, today: date === today, items: days[date] || [] });
  }
  const [y, mm] = month.split('-').map(Number);
  res.render('admin/calendar', {
    title: 'Calendar', grid, mine, today,
    label: `${MONTHS[mm - 1]} ${y}`, month,
    prev: addMonths(first, -1).slice(0, 7), next: nextMonth.slice(0, 7),
    agenda: (days[today] || []),
  });
});

module.exports = router;
