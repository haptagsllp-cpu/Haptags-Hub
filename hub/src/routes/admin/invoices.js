'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { getSettings } = require('../../lib/settings');
const { computeTotals, toPaise } = require('../../lib/money');
const {
  createInvoice, replaceItems, getItems, defaultTaxMode, issueInvoice, sendInvoiceEmail, recordPayment, invoiceUrl,
} = require('../../lib/billing');
const { logActivity, getActivities } = require('../../lib/activity');
const { nowSql, todayIST, addDays, int, str, isDate } = require('../../lib/util');
const { paginate, clientOptions, idParam } = require('./_helpers');
const { parseDocForm, formState } = require('./_docs');
const { upiFor } = require('../../lib/docs');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = req.query.status || '';
  const q = str(req.query.q, 100);
  const query = db('invoices as i').join('clients as c', 'c.id', 'i.client_id').select('i.*', 'c.name as client_name')
    .orderBy('i.issue_date', 'desc').orderBy('i.id', 'desc');
  if (status === 'unpaid') query.whereIn('i.status', ['sent', 'partially_paid', 'overdue']);
  else if (C.INVOICE_STATUSES.includes(status)) query.where('i.status', status);
  if (q) query.where((w) => w.where('i.number', 'like', `%${q}%`).orWhere('c.name', 'like', `%${q}%`).orWhere('i.title', 'like', `%${q}%`));
  const page = await paginate(query, req);
  const sums = await db('invoices').whereIn('status', ['sent', 'partially_paid', 'overdue'])
    .select('status').sum({ total: 'total', paid: 'amount_paid' }).count({ n: '*' }).groupBy('status');
  const summary = { outstanding: 0, overdue: 0, unpaidCount: 0, overdueCount: 0 };
  for (const r of sums) {
    const due = Number(r.total || 0) - Number(r.paid || 0);
    summary.outstanding += due;
    summary.unpaidCount += Number(r.n);
    if (r.status === 'overdue') { summary.overdue += due; summary.overdueCount += Number(r.n); }
  }
  res.render('admin/invoices/index', { title: 'Invoices', ...page, status, q, summary });
});

router.get('/new', async (req, res) => {
  const s = await getSettings();
  const client = await db('clients').where({ id: int(req.query.client_id, 0) }).first();
  const today = todayIST();
  res.render('admin/invoices/form', {
    title: 'New invoice',
    doc: {
      client_id: client ? client.id : '',
      project_id: int(req.query.project_id, 0) || '',
      issue_date: today,
      due_date: addDays(today, Number(s.default_due_days) || 7),
      tax_mode: defaultTaxMode(client, s),
      gst_rate: s.default_gst_rate,
      terms: s.invoice_terms,
      items: [{ description: '', sac: s.default_sac, quantity: 1, rate: 0 }],
    },
    errors: {},
    clients: await clientOptions(),
    projects: await db('projects').whereNotIn('status', ['cancelled']).orderBy('name').select('id', 'name', 'client_id'),
  });
});

async function placeOfSupply(clientId) {
  const c = await db('clients').where({ id: clientId }).first();
  return c ? c.state : null;
}

async function afterSave(req, res, id) {
  if (req.body.action === 'issue' || req.body.action === 'issue_send') {
    await db.transaction((trx) => issueInvoice(trx, id));
    await logActivity('invoice', id, req.user.id, 'status', 'Invoice issued');
    if (req.body.action === 'issue_send') {
      const r = await sendInvoiceEmail(id, req.user.id);
      req.flash(r.ok ? 'success' : 'info', r.ok ? 'Invoice issued and emailed.' : `Invoice issued. ${r.reason}`);
    } else {
      req.flash('success', 'Invoice issued.');
    }
  } else {
    req.flash('success', 'Draft saved.');
  }
  res.redirect(`/admin/invoices/${id}`);
}

router.post('/', async (req, res) => {
  const { data, items, errors } = parseDocForm(req.body);
  const s = await getSettings();
  if (!data.issue_date) data.issue_date = todayIST();
  if (!data.due_date) data.due_date = addDays(data.issue_date, Number(s.default_due_days) || 7);
  if (data.due_date < data.issue_date) errors.due_date = 'Due date can’t be before the invoice date.';
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/invoices/form', {
      title: 'New invoice', doc: formState(req.body, data, items), errors, clients: await clientOptions(),
      projects: await db('projects').orderBy('name').select('id', 'name', 'client_id'),
    });
  }
  const id = await db.transaction(async (trx) => {
    const iid = await createInvoice(trx, { ...data, place_of_supply: await placeOfSupply(data.client_id) }, items);
    await logActivity('invoice', iid, req.user.id, 'system', 'Draft created', trx);
    return iid;
  });
  return afterSave(req, res, id);
});

async function load(req) {
  return db('invoices').where({ id: idParam(req) }).first();
}

router.get('/:id', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  const balance = Math.max(0, Number(inv.total) - Number(inv.amount_paid));
  const [client, items, payments, activities, project] = await Promise.all([
    db('clients').where({ id: inv.client_id }).first(),
    getItems('invoice', inv.id),
    db('payments as p').leftJoin('users as u', 'u.id', 'p.recorded_by').where('p.invoice_id', inv.id).orderBy('p.id').select('p.*', 'u.name as recorded_by_name'),
    getActivities('invoice', inv.id),
    inv.project_id ? db('projects').where({ id: inv.project_id }).first() : null,
  ]);
  res.render('admin/invoices/show', {
    title: `Invoice ${inv.number || '(draft)'}`, doc: inv, client, items, payments, activities, project, balance,
    link: invoiceUrl(inv), upi: inv.status !== 'draft' ? await upiFor(inv, balance) : null,
  });
});

router.get('/:id/edit', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  if (inv.status !== 'draft') {
    req.flash('error', 'Issued invoices can’t be edited (GST rules). Void it and create a new one, or issue a fresh invoice for the difference.');
    return res.redirect(`/admin/invoices/${inv.id}`);
  }
  res.render('admin/invoices/form', {
    title: 'Edit draft invoice', doc: { ...inv, discount: inv.discount, items: await getItems('invoice', inv.id) }, errors: {},
    clients: await clientOptions(), projects: await db('projects').orderBy('name').select('id', 'name', 'client_id'),
  });
});

router.post('/:id', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  if (inv.status !== 'draft') return res.redirect(`/admin/invoices/${inv.id}`);
  const { data, items, errors } = parseDocForm(req.body);
  if (!data.issue_date) data.issue_date = inv.issue_date;
  if (!data.due_date) data.due_date = inv.due_date;
  if (data.due_date < data.issue_date) errors.due_date = 'Due date can’t be before the invoice date.';
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/invoices/form', {
      title: 'Edit draft invoice', doc: { ...formState(req.body, data, items), id: inv.id }, errors,
      clients: await clientOptions(), projects: await db('projects').orderBy('name').select('id', 'name', 'client_id'),
    });
  }
  const totals = computeTotals(items, { taxMode: data.tax_mode, gstRate: data.gst_rate, discount: data.discount });
  await db.transaction(async (trx) => {
    await trx('invoices').where({ id: inv.id }).update({
      client_id: data.client_id, project_id: data.project_id, title: data.title, issue_date: data.issue_date, due_date: data.due_date,
      tax_mode: data.tax_mode, gst_rate: data.gst_rate, place_of_supply: await placeOfSupply(data.client_id),
      subtotal: totals.subtotal, discount: totals.discount, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, total: totals.total,
      notes: data.notes, terms: data.terms, updated_at: nowSql(),
    });
    await replaceItems(trx, 'invoice', inv.id, totals.lines);
  });
  return afterSave(req, res, inv.id);
});

router.post('/:id/issue', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  await db.transaction((trx) => issueInvoice(trx, inv.id));
  await logActivity('invoice', inv.id, req.user.id, 'status', 'Invoice issued');
  req.flash('success', 'Invoice issued. Send it to the client by email or WhatsApp.');
  res.redirect(`/admin/invoices/${inv.id}`);
});

router.post('/:id/send', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  if (inv.status === 'draft') await db.transaction((trx) => issueInvoice(trx, inv.id));
  if (inv.status === 'void') return res.redirect(`/admin/invoices/${inv.id}`);
  const r = await sendInvoiceEmail(inv.id, req.user.id, { reminder: req.body.reminder === '1' });
  req.flash(r.ok ? 'success' : 'error', r.ok ? (req.body.reminder === '1' ? 'Reminder sent.' : 'Invoice emailed.') : r.reason);
  res.redirect(`/admin/invoices/${inv.id}`);
});

router.post('/:id/void', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  const paid = await db('payments').where({ invoice_id: inv.id, status: 'confirmed' }).first();
  if (paid) {
    req.flash('error', 'This invoice has payments recorded. Reject/remove those payments before voiding it.');
    return res.redirect(`/admin/invoices/${inv.id}`);
  }
  await db('invoices').where({ id: inv.id }).update({ status: 'void', updated_at: nowSql() });
  await logActivity('invoice', inv.id, req.user.id, 'status', `Voided${req.body.reason ? `: ${str(req.body.reason, 255)}` : ''}`);
  req.flash('success', 'Invoice voided. Its number stays reserved, as GST requires.');
  res.redirect(`/admin/invoices/${inv.id}`);
});

router.post('/:id/delete', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  if (inv.status !== 'draft' || inv.number) {
    req.flash('error', 'Only unissued drafts can be deleted. Void issued invoices instead.');
    return res.redirect(`/admin/invoices/${inv.id}`);
  }
  await db.transaction(async (trx) => {
    await trx('line_items').where({ doc_type: 'invoice', doc_id: inv.id }).del();
    await trx('activities').where({ entity_type: 'invoice', entity_id: inv.id }).del();
    await trx('quotes').where({ invoice_id: inv.id }).update({ invoice_id: null, status: 'accepted' });
    await trx('invoices').where({ id: inv.id }).del();
  });
  req.flash('success', 'Draft deleted.');
  res.redirect('/admin/invoices');
});

router.post('/:id/payments', async (req, res, next) => {
  const inv = await load(req);
  if (!inv) return next();
  if (['draft', 'void'].includes(inv.status)) {
    req.flash('error', 'Issue the invoice before recording payments.');
    return res.redirect(`/admin/invoices/${inv.id}`);
  }
  const amount = toPaise(req.body.amount);
  const tds = toPaise(req.body.tds);
  if (amount + tds <= 0) {
    req.flash('error', 'Enter the amount received.');
    return res.redirect(`/admin/invoices/${inv.id}#payments`);
  }
  const method = C.PAYMENT_METHODS.some((m) => m[0] === req.body.method) ? req.body.method : 'other';
  await recordPayment({
    invoice_id: inv.id, amount, tds, method, reference: str(req.body.reference, 190),
    paid_on: isDate(req.body.paid_on) ? req.body.paid_on : todayIST(), notes: str(req.body.notes, 1000), recorded_by: req.user.id,
  }, { notify: Boolean(req.body.send_receipt) });
  req.flash('success', 'Payment recorded.');
  res.redirect(`/admin/invoices/${inv.id}#payments`);
});

module.exports = router;
