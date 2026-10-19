'use strict';

const express = require('express');
const { db } = require('../../db');
const { periodFrom, PRESETS } = require('../../lib/period');
const { nowSql, str, int, isDate } = require('../../lib/util');
const { idParam, back } = require('./_helpers');

const router = express.Router();

// Owners and admins manage this; a partner with a Hub login can view it (read-only).
router.use(async (req, res, next) => {
  const linked = await db('partners').where({ user_id: req.user.id }).first();
  if (!res.locals.isAdmin && !linked) {
    return res.status(403).render('public/message', {
      title: 'Not allowed', heading: 'This page is for the partners', body: 'Ask an owner or admin if you need access.', link: { href: '/admin', label: 'Back to dashboard' },
    });
  }
  res.locals.canEdit = res.locals.isAdmin;
  next();
});

/**
 * Revenue credited to each partner: invoices issued and payments received in the period for the
 * clients and students they brought in. Key null = not yet assigned to anyone.
 */
async function contributions(from, to) {
  const [billed, collected, outstanding, clients, added] = await Promise.all([
    db('invoices as i').join('clients as c', 'c.id', 'i.client_id').whereNotIn('i.status', ['draft', 'void'])
      .whereBetween('i.issue_date', [from, to]).select('c.partner_id', 'i.segment').sum({ v: 'i.total' }).count({ n: '*' }).groupBy('c.partner_id', 'i.segment'),
    db('payments as p').join('clients as c', 'c.id', 'p.client_id').where('p.status', 'confirmed')
      .whereBetween('p.paid_on', [from, to]).select('c.partner_id').sum({ v: 'p.amount', tds: 'p.tds' }).groupBy('c.partner_id'),
    db('invoices as i').join('clients as c', 'c.id', 'i.client_id').whereIn('i.status', ['sent', 'partially_paid', 'overdue'])
      .select('c.partner_id').sum({ t: 'i.total', p: 'i.amount_paid' }).groupBy('c.partner_id'),
    db('clients').select('partner_id', 'segment').count({ n: '*' }).groupBy('partner_id', 'segment'),
    db('clients').whereBetween('created_at', [`${from} 00:00:00`, `${to} 23:59:59`]).select('partner_id').count({ n: '*' }).groupBy('partner_id'),
  ]);
  const by = {};
  const row = (id) => {
    const k = id || 'none';
    by[k] = by[k] || { billed: 0, billedBusiness: 0, billedStudent: 0, invoices: 0, collected: 0, outstanding: 0, clients: 0, students: 0, added: 0 };
    return by[k];
  };
  for (const r of billed) {
    const x = row(r.partner_id);
    x.billed += Number(r.v || 0); x.invoices += Number(r.n || 0);
    if (r.segment === 'student') x.billedStudent += Number(r.v || 0); else x.billedBusiness += Number(r.v || 0);
  }
  for (const r of collected) row(r.partner_id).collected += Number(r.v || 0) + Number(r.tds || 0);
  for (const r of outstanding) row(r.partner_id).outstanding += Number(r.t || 0) - Number(r.p || 0);
  for (const r of clients) { const x = row(r.partner_id); if (r.segment === 'student') x.students += Number(r.n); else x.clients += Number(r.n); }
  for (const r of added) row(r.partner_id).added += Number(r.n);
  return by;
}

const EMPTY = { billed: 0, billedBusiness: 0, billedStudent: 0, invoices: 0, collected: 0, outstanding: 0, clients: 0, students: 0, added: 0 };

router.get('/', async (req, res) => {
  const first = await db('invoices').min({ d: 'issue_date' }).first();
  const period = periodFrom(req.query, { earliest: first && first.d ? String(first.d).slice(0, 10) : null, fallback: 'all' });
  const [partners, by] = await Promise.all([
    db('partners as p').leftJoin('users as u', 'u.id', 'p.user_id').orderByRaw("CASE WHEN p.status = 'active' THEN 0 ELSE 1 END").orderBy('p.id')
      .select('p.*', 'u.name as user_name', 'u.email as user_email'),
    contributions(period.from, period.to),
  ]);
  const rows = partners.map((p) => ({ ...p, ...EMPTY, ...(by[p.id] || {}) }));
  const unassigned = { ...EMPTY, ...(by.none || {}) };
  const total = [...rows, unassigned].reduce((t, r) => ({ billed: t.billed + r.billed, collected: t.collected + r.collected, outstanding: t.outstanding + r.outstanding }), { billed: 0, collected: 0, outstanding: 0 });
  res.render('admin/partners/index', {
    title: 'Partners', period, presets: PRESETS, rows, unassigned, total,
    users: res.locals.canEdit ? await db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).orderBy('name').select('id', 'name') : [],
  });
});

function readPartner(body) {
  return {
    name: str(body.name, 190),
    dpin: str(body.dpin, 20),
    designation: str(body.designation, 60) || 'Designated Partner',
    status: body.status === 'resigned' ? 'resigned' : 'active',
    joined_on: isDate(body.joined_on) ? body.joined_on : null,
    left_on: isDate(body.left_on) ? body.left_on : null,
    user_id: int(body.user_id, 0) || null,
    notes: str(body.notes, 2000),
  };
}

const editOnly = (req, res, next) => (res.locals.canEdit ? next() : res.status(403).render('public/message', { title: 'Not allowed', heading: 'Only owners and admins can change this' }));

router.post('/', editOnly, async (req, res) => {
  const p = readPartner(req.body);
  if (!p.name) {
    req.flash('error', 'Enter the partner’s name.');
    return res.redirect('/admin/partners');
  }
  await db('partners').insert({ ...p, created_at: nowSql(), updated_at: nowSql() });
  req.flash('success', `${p.name} added.`);
  res.redirect('/admin/partners');
});

// Credit clients/students nobody is assigned to yet to one partner in one go.
router.post('/assign', editOnly, async (req, res) => {
  const partner = await db('partners').where({ id: int(req.body.partner_id, 0) }).first();
  if (!partner) {
    req.flash('error', 'Choose a partner.');
    return res.redirect('/admin/partners');
  }
  const q = db('clients').whereNull('partner_id');
  if (['business', 'student'].includes(req.body.segment)) q.where('segment', req.body.segment);
  const n = await q.update({ partner_id: partner.id, updated_at: nowSql() });
  req.flash('success', `${n} ${n === 1 ? 'record' : 'records'} credited to ${partner.name}.`);
  res.redirect('/admin/partners');
});

router.get('/:id', async (req, res, next) => {
  const partner = await db('partners').where({ id: idParam(req) }).first();
  if (!partner) return next();
  const clients = await db('clients as c').where('c.partner_id', partner.id).orderBy('c.segment').orderBy('c.name')
    .select('c.id', 'c.name', 'c.segment', 'c.college', 'c.created_at');
  const ids = clients.map((c) => c.id);
  const [billed, paid] = ids.length ? await Promise.all([
    db('invoices').whereIn('client_id', ids).whereNotIn('status', ['draft', 'void']).select('client_id').sum({ v: 'total' }).groupBy('client_id'),
    db('payments').whereIn('client_id', ids).where({ status: 'confirmed' }).select('client_id').sum({ v: 'amount', tds: 'tds' }).groupBy('client_id'),
  ]) : [[], []];
  const b = Object.fromEntries(billed.map((r) => [r.client_id, Number(r.v || 0)]));
  const p = Object.fromEntries(paid.map((r) => [r.client_id, Number(r.v || 0) + Number(r.tds || 0)]));
  res.render('admin/partners/show', {
    title: partner.name, partner, clients: clients.map((c) => ({ ...c, billed: b[c.id] || 0, paid: p[c.id] || 0 })),
    users: res.locals.canEdit ? await db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).orderBy('name').select('id', 'name') : [],
  });
});

router.post('/:id', editOnly, async (req, res, next) => {
  const partner = await db('partners').where({ id: idParam(req) }).first();
  if (!partner) return next();
  const p = readPartner(req.body);
  if (!p.name) p.name = partner.name;
  if (p.status === 'active') p.left_on = null;
  await db('partners').where({ id: partner.id }).update({ ...p, updated_at: nowSql() });
  req.flash('success', 'Partner saved.');
  res.redirect(`/admin/partners/${partner.id}`);
});

// From a client or student page: who brought them in.
router.post('/credit/:clientId', editOnly, async (req, res) => {
  const partnerId = int(req.body.partner_id, 0) || null;
  if (partnerId && !(await db('partners').where({ id: partnerId }).first())) return res.redirect(back(req, '/admin/partners'));
  await db('clients').where({ id: idParam(req, 'clientId') }).update({ partner_id: partnerId, updated_at: nowSql() });
  req.flash('success', partnerId ? 'Credited.' : 'Credit removed.');
  res.redirect(back(req, '/admin/partners'));
});

module.exports = router;
