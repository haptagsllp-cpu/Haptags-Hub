'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { getSettings } = require('../../lib/settings');
const { columnChart } = require('../../lib/charts');
const { todayIST, addDays, addMonths, nowSql, istToUtc } = require('../../lib/util');
const { monthly } = require('./retainers');
const { runIfStale } = require('../../lib/automation');
const { unreadTotal } = require('../../lib/chat');
const { meetingsFor, timing } = require('../../lib/meetings');
const { unreadFor } = require('./announcements');

const router = express.Router();

// Sidebar badges: things waiting on the team.
router.use(async (req, res, next) => {
  const [newLeads, pendingPay, openTickets, chatUnread, news] = await Promise.all([
    db('leads').where({ status: 'new' }).count({ n: '*' }).first(),
    db('payments').where({ status: 'pending' }).count({ n: '*' }).first(),
    db('tickets').where({ status: 'open' }).count({ n: '*' }).first(),
    unreadTotal(req.user.id),
    unreadFor(req.user.id).clearSelect().clearOrder().count({ n: '*' }).first(),
  ]);
  res.locals.counts = {
    leads: Number(newLeads.n), payments: Number(pendingPay.n), tickets: Number(openTickets.n), chat: chatUnread, announcements: Number(news.n),
  };
  runIfStale().catch(() => {});
  next();
});

const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

router.get('/', async (req, res) => {
  const today = todayIST();
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevStart = addMonths(monthStart, -1);
  const prevSameDay = addDays(prevStart, Number(today.slice(8, 10)) - 1);
  const yearStart = addMonths(monthStart, -11);
  const s = await getSettings();
  const [todaysMeetings, news] = await Promise.all([
    meetingsFor(req.user.id, { from: istToUtc(today, '00:00'), to: istToUtc(addDays(today, 1), '00:00') }),
    unreadFor(req.user.id).limit(3),
  ]);

  const [
    payments12, outstandingRows, retainers, pipelineRows, leadsThisMonth, decided, invoicedMonth,
    actionLeads, overdue, pendingPayments, openTickets, dueSoon, opportunities,
  ] = await Promise.all([
    db('payments').where({ status: 'confirmed' }).where('paid_on', '>=', yearStart).select('paid_on', 'amount'),
    db('invoices').whereIn('status', ['sent', 'partially_paid', 'overdue']).select('status', 'total', 'amount_paid'),
    db('retainers').where({ status: 'active' }).select('subtotal', 'interval'),
    db('leads').whereIn('status', C.LEAD_OPEN).select('status').count({ n: '*' }).sum({ v: 'value_estimate' }).groupBy('status'),
    db('leads').where('created_at', '>=', `${monthStart} 00:00:00`).count({ n: '*' }).first(),
    db('leads').whereIn('status', ['won', 'lost']).where('updated_at', '>=', `${addDays(today, -90)} 00:00:00`).select('status').count({ n: '*' }).groupBy('status'),
    db('invoices').whereNotIn('status', ['draft', 'void']).where('issue_date', '>=', monthStart).sum({ v: 'total' }).first(),
    db('leads').whereIn('status', C.LEAD_OPEN)
      .where((w) => w.where('status', 'new').orWhere('next_follow_up', '<=', today))
      .orderByRaw("CASE WHEN status = 'new' THEN 0 ELSE 1 END").orderBy('next_follow_up').orderBy('id', 'desc').limit(8),
    db('invoices as i').join('clients as c', 'c.id', 'i.client_id').where('i.status', 'overdue').orderBy('i.due_date').limit(8)
      .select('i.id', 'i.number', 'i.due_date', 'i.total', 'i.amount_paid', 'c.name as client_name', 'c.phone as client_phone', 'i.public_token'),
    db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').join('clients as c', 'c.id', 'p.client_id').where('p.status', 'pending')
      .orderBy('p.id').limit(8).select('p.*', 'i.number as invoice_number', 'c.name as client_name'),
    db('tickets as t').join('clients as c', 'c.id', 't.client_id').where('t.status', 'open')
      .orderByRaw("CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END").orderBy('t.last_reply_at').limit(6)
      .select('t.*', 'c.name as client_name'),
    db('projects as p').join('clients as c', 'c.id', 'p.client_id').whereIn('p.status', ['planning', 'in_progress', 'review'])
      .whereNotNull('p.due_date').where('p.due_date', '<=', addDays(today, 7)).orderBy('p.due_date').limit(6)
      .select('p.*', 'c.name as client_name'),
    db('projects as p').join('clients as c', 'c.id', 'p.client_id').where('p.status', 'completed').where('c.status', 'active')
      .whereNotExists(db('retainers as r').whereRaw('r.client_id = p.client_id').where('r.status', 'active'))
      .orderBy('p.updated_at', 'desc').limit(5).select('p.id', 'p.name', 'p.service', 'p.client_id', 'c.name as client_name'),
  ]);

  // Collections by month (IST dates), oldest → newest.
  const byMonth = {};
  for (const p of payments12) byMonth[p.paid_on.slice(0, 7)] = (byMonth[p.paid_on.slice(0, 7)] || 0) + Number(p.amount);
  const series = [];
  for (let i = 0; i < 12; i += 1) {
    const m = addMonths(yearStart, i).slice(0, 7);
    const [y, mm] = m.split('-').map(Number);
    series.push({ key: m, label: MONTHS[mm - 1], tip: `${MONTHS[mm - 1]} ${y}`, value: byMonth[m] || 0 });
  }
  const collectedMonth = series[11].value;
  const collectedPrevToDate = payments12.filter((p) => p.paid_on >= prevStart && p.paid_on <= prevSameDay).reduce((a, p) => a + Number(p.amount), 0);
  const collectedYear = series.reduce((a, p) => a + p.value, 0);

  const outstanding = outstandingRows.reduce((a, r) => a + Number(r.total) - Number(r.amount_paid), 0);
  const overdueAmt = outstandingRows.filter((r) => r.status === 'overdue').reduce((a, r) => a + Number(r.total) - Number(r.amount_paid), 0);
  const mrr = retainers.reduce((a, r) => a + monthly(r), 0);
  const stages = C.LEAD_OPEN.map((st) => {
    const row = pipelineRows.find((r) => r.status === st) || {};
    return { status: st, n: Number(row.n || 0), value: Number(row.v || 0) };
  });
  const won = Number((decided.find((d) => d.status === 'won') || {}).n || 0);
  const lost = Number((decided.find((d) => d.status === 'lost') || {}).n || 0);

  res.render('admin/dashboard', {
    title: 'Dashboard',
    kpi: {
      collectedMonth,
      collectedPrevToDate,
      collectedYear,
      outstanding,
      overdueAmt,
      mrr,
      pipelineValue: sum(stages, 'value'),
      pipelineCount: sum(stages, 'n'),
      leadsThisMonth: Number(leadsThisMonth.n),
      winRate: won + lost ? Math.round((won / (won + lost)) * 100) : null,
      decided: won + lost,
      invoicedMonth: Number(invoicedMonth.v || 0),
    },
    chart: columnChart(series, { label: 'Money collected per month, last 12 months' }),
    series,
    stages,
    actionLeads,
    overdue,
    pendingPayments,
    openTickets,
    dueSoon,
    opportunities,
    today,
    lastRun: s.automation_last_run,
    hour: Number(new Date(Date.now() + 5.5 * 3600000).toISOString().slice(11, 13)),
    nowSql: nowSql(),
    todaysMeetings: todaysMeetings.map((m) => ({ ...m, ...timing(m) })),
    news,
  });
});

router.use('/chat', require('./chat'));
router.use('/meetings', require('./meetings'));
router.use('/calendar', require('./calendar'));
router.use('/announcements', require('./announcements'));
router.use('/leads', require('./leads'));
router.use('/clients', require('./clients'));
router.use('/projects', require('./projects'));
router.use('/quotes', require('./quotes'));
router.use('/invoices', require('./invoices'));
router.use('/payments', require('./payments'));
router.use('/retainers', require('./retainers'));
router.use('/tickets', require('./tickets'));
router.use('/', require('./settings'));

module.exports = router;
