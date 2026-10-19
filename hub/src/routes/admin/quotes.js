'use strict';

const express = require('express');
const config = require('../../config');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { getSettings } = require('../../lib/settings');
const { computeTotals, formatINR } = require('../../lib/money');
const { nextNumber, replaceItems, getItems, defaultTaxMode, invoiceFromQuote } = require('../../lib/billing');
const { logActivity, getActivities } = require('../../lib/activity');
const { sendMail } = require('../../lib/mailer');
const { nowSql, todayIST, addDays, randomToken, int, formatDate, humanize } = require('../../lib/util');
const { paginate, clientOptions, idParam } = require('./_helpers');
const { parseDocForm, formState } = require('./_docs');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = req.query.status || '';
  const query = db('quotes as q').join('clients as c', 'c.id', 'q.client_id').select('q.*', 'c.name as client_name').orderBy('q.id', 'desc');
  if (C.QUOTE_STATUSES.includes(status)) query.where('q.status', status);
  const page = await paginate(query, req);
  const open = await db('quotes').where({ status: 'sent' }).sum({ v: 'total' }).count({ n: '*' }).first();
  res.render('admin/quotes/index', { title: 'Quotations', ...page, status, openValue: Number(open.v || 0), openCount: Number(open.n) });
});

router.get('/new', async (req, res) => {
  const s = await getSettings();
  const client = await db('clients').where({ id: int(req.query.client_id, 0) }).first();
  const lead = await db('leads').where({ id: int(req.query.lead_id, 0) }).first();
  const today = todayIST();
  res.render('admin/quotes/form', {
    title: 'New quotation',
    doc: {
      client_id: client ? client.id : '',
      lead_id: lead ? lead.id : '',
      title: lead && lead.service ? `${C.serviceLabel(lead.service)} — ${client ? client.name : lead.company || lead.name}` : '',
      issue_date: today,
      valid_until: addDays(today, Number(s.quote_valid_days) || 15),
      tax_mode: defaultTaxMode(client, s),
      gst_rate: s.default_gst_rate,
      terms: s.quote_terms,
      items: [{ description: lead && lead.service ? C.serviceLabel(lead.service) : '', sac: s.default_sac, quantity: 1, rate: 0 }],
    },
    errors: {},
    clients: await clientOptions(),
  });
});

router.post('/', async (req, res) => {
  const { data, items, errors } = parseDocForm(req.body);
  if (!data.issue_date) data.issue_date = todayIST();
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/quotes/form', { title: 'New quotation', doc: formState(req.body, data, items), errors, clients: await clientOptions() });
  }
  const s = await getSettings();
  const totals = computeTotals(items, { taxMode: data.tax_mode, gstRate: data.gst_rate, discount: data.discount });
  const id = await db.transaction(async (trx) => {
    const number = await nextNumber(trx, s.quote_prefix, data.issue_date, 'quotes');
    const [qid] = await trx('quotes').insert({
      number,
      client_id: data.client_id,
      lead_id: int(req.body.lead_id, 0) || null,
      title: data.title || 'Quotation',
      issue_date: data.issue_date,
      valid_until: data.valid_until,
      status: 'draft',
      tax_mode: data.tax_mode,
      gst_rate: data.gst_rate,
      subtotal: totals.subtotal, discount: totals.discount, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, total: totals.total,
      notes: data.notes, terms: data.terms,
      public_token: randomToken(24),
      created_at: nowSql(), updated_at: nowSql(),
    });
    await replaceItems(trx, 'quote', qid, totals.lines);
    await logActivity('quote', qid, req.user.id, 'system', `Quotation ${number} created`, trx);
    return qid;
  });
  const leadId = int(req.body.lead_id, 0);
  if (leadId) await db('leads').where({ id: leadId }).whereIn('status', ['new', 'contacted', 'qualified']).update({ status: 'proposal', value_estimate: totals.total, updated_at: nowSql() });
  req.flash('success', 'Quotation saved as draft. Review it, then send it to the client.');
  res.redirect(`/admin/quotes/${id}`);
});

async function load(req) {
  return db('quotes').where({ id: idParam(req) }).first();
}

router.get('/:id', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  const [client, items, activities] = await Promise.all([
    db('clients').where({ id: quote.client_id }).first(),
    getItems('quote', quote.id),
    getActivities('quote', quote.id),
  ]);
  res.render('admin/quotes/show', { title: `Quotation ${quote.number}`, doc: quote, client, items, activities, link: `${config.baseUrl}/q/${quote.public_token}` });
});

router.get('/:id/edit', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  if (!['draft', 'sent'].includes(quote.status)) {
    req.flash('error', `A ${humanize(quote.status).toLowerCase()} quotation can’t be edited.`);
    return res.redirect(`/admin/quotes/${quote.id}`);
  }
  res.render('admin/quotes/form', {
    title: `Edit ${quote.number}`, doc: { ...quote, items: await getItems('quote', quote.id) }, errors: {}, clients: await clientOptions(),
  });
});

router.post('/:id', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  if (!['draft', 'sent'].includes(quote.status)) return res.redirect(`/admin/quotes/${quote.id}`);
  const { data, items, errors } = parseDocForm(req.body);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/quotes/form', { title: `Edit ${quote.number}`, doc: { ...formState(req.body, data, items), id: quote.id, number: quote.number }, errors, clients: await clientOptions() });
  }
  const totals = computeTotals(items, { taxMode: data.tax_mode, gstRate: data.gst_rate, discount: data.discount });
  await db.transaction(async (trx) => {
    await trx('quotes').where({ id: quote.id }).update({
      client_id: data.client_id, title: data.title || quote.title, issue_date: data.issue_date || quote.issue_date, valid_until: data.valid_until,
      tax_mode: data.tax_mode, gst_rate: data.gst_rate,
      subtotal: totals.subtotal, discount: totals.discount, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, total: totals.total,
      notes: data.notes, terms: data.terms, updated_at: nowSql(),
    });
    await replaceItems(trx, 'quote', quote.id, totals.lines);
    await logActivity('quote', quote.id, req.user.id, 'system', 'Quotation edited', trx);
  });
  req.flash('success', 'Quotation updated.');
  res.redirect(`/admin/quotes/${quote.id}`);
});

router.post('/:id/send', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  if (!['draft', 'sent'].includes(quote.status)) return res.redirect(`/admin/quotes/${quote.id}`);
  const client = await db('clients').where({ id: quote.client_id }).first();
  const s = await getSettings();
  await db('quotes').where({ id: quote.id }).update({ status: 'sent', sent_at: quote.sent_at || nowSql(), updated_at: nowSql() });
  const link = `${config.baseUrl}/q/${quote.public_token}`;
  let ok = false;
  if (client.email) {
    ok = await sendMail({
      to: client.email,
      replyTo: s.email,
      subject: `Quotation ${quote.number} from ${s.legal_name}: ${quote.title}`,
      related: ['quote', quote.id],
      heading: 'Your quotation is ready',
      lines: [
        `Hi ${client.contact_name || client.name},`,
        `Thank you for the opportunity. Please review our quotation for ${quote.title}. You can accept it online in one click.`,
      ],
      rows: [['Quotation', quote.number], ['Total', formatINR(quote.total)], ...(quote.valid_until ? [['Valid until', formatDate(quote.valid_until)]] : [])],
      button: { label: 'Review & accept', url: link },
    });
  }
  await logActivity('quote', quote.id, req.user.id, 'email', client.email ? `Sent to ${client.email}${ok ? '' : ' (email not delivered — share the link)'}` : 'Marked as sent (no client email — share the link)');
  req.flash(ok ? 'success' : 'info', ok ? `Quotation emailed to ${client.email}.` : 'Quotation marked as sent. Email wasn’t delivered, so share the link with the client (WhatsApp button below).');
  res.redirect(`/admin/quotes/${quote.id}`);
});

router.post('/:id/status', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  const status = ['accepted', 'declined', 'sent', 'draft'].includes(req.body.status) ? req.body.status : null;
  if (status && quote.status !== 'invoiced') {
    await db('quotes').where({ id: quote.id }).update({ status, responded_at: ['accepted', 'declined'].includes(status) ? nowSql() : null, responded_by: ['accepted', 'declined'].includes(status) ? `${req.user.name} (recorded by team)` : null, updated_at: nowSql() });
    if (status === 'accepted' && quote.lead_id) await db('leads').where({ id: quote.lead_id }).update({ status: 'won', updated_at: nowSql() });
    await logActivity('quote', quote.id, req.user.id, 'status', `Marked ${humanize(status).toLowerCase()}`);
  }
  res.redirect(`/admin/quotes/${quote.id}`);
});

router.post('/:id/convert', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  const invoiceId = await invoiceFromQuote(quote.id, req.user.id);
  req.flash('success', 'Draft invoice created from the quotation. Adjust it (e.g. bill a 50% advance) and issue it.');
  res.redirect(`/admin/invoices/${invoiceId}`);
});

router.post('/:id/delete', async (req, res, next) => {
  const quote = await load(req);
  if (!quote) return next();
  if (quote.status !== 'draft') {
    req.flash('error', 'Only draft quotations can be deleted.');
    return res.redirect(`/admin/quotes/${quote.id}`);
  }
  await db.transaction(async (trx) => {
    await trx('line_items').where({ doc_type: 'quote', doc_id: quote.id }).del();
    await trx('activities').where({ entity_type: 'quote', entity_id: quote.id }).del();
    await trx('quotes').where({ id: quote.id }).del();
  });
  req.flash('success', 'Draft quotation deleted.');
  res.redirect('/admin/quotes');
});

module.exports = router;
