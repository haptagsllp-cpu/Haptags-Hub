'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { getSettings } = require('../../lib/settings');
const { computeTotals } = require('../../lib/money');
const { replaceItems, getItems, defaultTaxMode } = require('../../lib/billing');
const { logActivity, getActivities } = require('../../lib/activity');
const { intervalMonths } = require('../../lib/automation');
const { nowSql, todayIST, addMonths, int, isDate } = require('../../lib/util');
const { clientOptions, idParam } = require('./_helpers');
const { parseDocForm, formState } = require('./_docs');

const router = express.Router();

/** Monthly-equivalent value of a retainer's pre-tax amount. */
const monthly = (r) => Math.round(Number(r.subtotal) / intervalMonths(r.interval));

router.get('/', async (req, res) => {
  const rows = await db('retainers as r').join('clients as c', 'c.id', 'r.client_id').select('r.*', 'c.name as client_name')
    .orderByRaw("CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END").orderBy('r.next_invoice_date');
  const mrr = rows.filter((r) => r.status === 'active').reduce((s, r) => s + monthly(r), 0);
  // Completed projects with no active retainer: the easiest recurring revenue to add.
  const opportunities = await db('projects as p').join('clients as c', 'c.id', 'p.client_id')
    .where('p.status', 'completed').where('c.status', 'active')
    .whereNotExists(db('retainers as r').whereRaw('r.client_id = p.client_id').where('r.status', 'active'))
    .select('p.id', 'p.name', 'p.service', 'p.client_id', 'c.name as client_name').orderBy('p.updated_at', 'desc').limit(10);
  res.render('admin/retainers/index', { title: 'Retainers', rows: rows.map((r) => ({ ...r, monthly: monthly(r) })), mrr, opportunities });
});

router.get('/new', async (req, res) => {
  const s = await getSettings();
  const client = await db('clients').where({ id: int(req.query.client_id, 0) }).first();
  const firstOfNext = addMonths(`${todayIST().slice(0, 7)}-01`, 1);
  res.render('admin/retainers/form', {
    title: 'New retainer',
    doc: {
      client_id: client ? client.id : '',
      project_id: int(req.query.project_id, 0) || '',
      title: req.query.title || 'Monthly retainer',
      interval: 'monthly',
      next_invoice_date: firstOfNext,
      due_days: s.default_due_days,
      auto_send: true,
      tax_mode: defaultTaxMode(client, s),
      gst_rate: s.default_gst_rate,
      items: [{ description: req.query.item || '', sac: s.default_sac, quantity: 1, rate: 0 }],
    },
    errors: {},
    clients: await clientOptions(),
  });
});

function retainerFields(body, data) {
  const errors = {};
  const fields = {
    interval: C.RETAINER_INTERVALS.some((i) => i[0] === body.interval) ? body.interval : 'monthly',
    next_invoice_date: isDate(body.next_invoice_date) ? body.next_invoice_date : null,
    end_date: isDate(body.end_date) ? body.end_date : null,
    due_days: Math.min(90, Math.max(0, int(body.due_days, 7))),
    auto_send: Boolean(body.auto_send),
  };
  if (!fields.next_invoice_date) errors.next_invoice_date = 'Pick the date of the first invoice.';
  if (!data.title) errors.title = 'Give the retainer a name, e.g. “SEO & social media — monthly”.';
  return { fields, errors };
}

router.post('/', async (req, res) => {
  const { data, items, errors } = parseDocForm(req.body);
  const { fields, errors: e2 } = retainerFields(req.body, data);
  Object.assign(errors, e2);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/retainers/form', { title: 'New retainer', doc: formState(req.body, data, items), errors, clients: await clientOptions() });
  }
  const totals = computeTotals(items, { taxMode: data.tax_mode, gstRate: data.gst_rate });
  const id = await db.transaction(async (trx) => {
    const [rid] = await trx('retainers').insert({
      client_id: data.client_id, project_id: data.project_id, title: data.title, ...fields,
      tax_mode: data.tax_mode, gst_rate: data.gst_rate, subtotal: totals.subtotal, notes: data.notes, status: 'active',
      created_at: nowSql(), updated_at: nowSql(),
    });
    await replaceItems(trx, 'retainer', rid, totals.lines);
    await logActivity('retainer', rid, req.user.id, 'system', 'Retainer created', trx);
    return rid;
  });
  req.flash('success', 'Retainer set up. Invoices will be generated automatically on schedule.');
  res.redirect(`/admin/retainers/${id}`);
});

router.get('/:id', async (req, res, next) => {
  const r = await db('retainers').where({ id: idParam(req) }).first();
  if (!r) return next();
  const [client, items, invoices, activities] = await Promise.all([
    db('clients').where({ id: r.client_id }).first(),
    getItems('retainer', r.id),
    db('invoices').where({ retainer_id: r.id }).orderBy('id', 'desc'),
    getActivities('retainer', r.id),
  ]);
  res.render('admin/retainers/show', { title: r.title, r: { ...r, monthly: monthly(r) }, client, items, invoices, activities });
});

router.get('/:id/edit', async (req, res, next) => {
  const r = await db('retainers').where({ id: idParam(req) }).first();
  if (!r) return next();
  res.render('admin/retainers/form', { title: `Edit ${r.title}`, doc: { ...r, items: await getItems('retainer', r.id) }, errors: {}, clients: await clientOptions() });
});

router.post('/:id', async (req, res, next) => {
  const r = await db('retainers').where({ id: idParam(req) }).first();
  if (!r) return next();
  const { data, items, errors } = parseDocForm(req.body);
  const { fields, errors: e2 } = retainerFields(req.body, data);
  Object.assign(errors, e2);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/retainers/form', { title: `Edit ${r.title}`, doc: { ...formState(req.body, data, items), id: r.id }, errors, clients: await clientOptions() });
  }
  const totals = computeTotals(items, { taxMode: data.tax_mode, gstRate: data.gst_rate });
  await db.transaction(async (trx) => {
    await trx('retainers').where({ id: r.id }).update({
      client_id: data.client_id, project_id: data.project_id, title: data.title, ...fields,
      tax_mode: data.tax_mode, gst_rate: data.gst_rate, subtotal: totals.subtotal, notes: data.notes, updated_at: nowSql(),
    });
    await replaceItems(trx, 'retainer', r.id, totals.lines);
    await logActivity('retainer', r.id, req.user.id, 'system', 'Retainer edited', trx);
  });
  req.flash('success', 'Retainer updated. Future invoices will use the new amounts.');
  res.redirect(`/admin/retainers/${r.id}`);
});

router.post('/:id/status', async (req, res, next) => {
  const r = await db('retainers').where({ id: idParam(req) }).first();
  if (!r) return next();
  const status = ['active', 'paused', 'ended'].includes(req.body.status) ? req.body.status : r.status;
  const patch = { status, updated_at: nowSql() };
  // Resuming shouldn't back-bill the paused months.
  if (status === 'active' && r.status === 'paused' && r.next_invoice_date < todayIST()) patch.next_invoice_date = todayIST();
  await db('retainers').where({ id: r.id }).update(patch);
  await logActivity('retainer', r.id, req.user.id, 'status', `Retainer ${status === 'active' ? 'resumed' : status}`);
  res.redirect(`/admin/retainers/${r.id}`);
});

module.exports = router;
module.exports.monthly = monthly;
