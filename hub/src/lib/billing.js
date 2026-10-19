'use strict';

const config = require('../config');
const { db } = require('../db');
const { getSettings } = require('./settings');
const { computeTotals, formatINR, toPaise } = require('./money');
const { nowSql, todayIST, addDays, financialYear, randomToken, formatDate, str } = require('./util');
const { logActivity } = require('./activity');
const { sendMail } = require('./mailer');
const { methodLabel } = require('./constants');

async function nextSequence(trx, name) {
  const updated = await trx('sequences').where({ name }).increment('value', 1);
  if (!updated) {
    await trx('sequences').insert({ name, value: 1 });
    return 1;
  }
  const row = await trx('sequences').where({ name }).first();
  return row.value;
}

const formatNumber = (prefix, fy, seq) => `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;

/**
 * Next automatic number in a series. Numbers typed in by hand can sit anywhere in the series,
 * so any that are already taken are skipped rather than duplicated.
 */
async function nextNumber(trx, prefix, dateYmd, table = 'invoices') {
  const fy = financialYear(dateYmd);
  for (let i = 0; i < 1000; i += 1) {
    const number = formatNumber(prefix, fy, await nextSequence(trx, `${prefix}:${fy}`));
    if (!(await trx(table).where({ number }).first())) return number;
  }
  throw new Error('Could not find a free number in this series.');
}

/** What the next automatic number will be, without using it up. */
async function previewNumber(prefix, dateYmd, trx = db) {
  const fy = financialYear(dateYmd);
  const row = await trx('sequences').where({ name: `${prefix}:${fy}` }).first();
  let seq = (row ? Number(row.value) : 0) + 1;
  while (await trx('invoices').where({ number: formatNumber(prefix, fy, seq) }).first()) seq += 1;
  return formatNumber(prefix, fy, seq);
}

/** Sets where a series continues from this financial year (e.g. after last year's paper invoices). */
async function setNextSequence(prefix, dateYmd, next) {
  const name = `${prefix}:${financialYear(dateYmd)}`;
  const value = Math.max(0, Math.floor(next) - 1);
  const updated = await db('sequences').where({ name }).update({ value });
  if (!updated) await db('sequences').insert({ name, value });
}

/** A typed-in invoice number: letters, digits and / - _ . only. Returns null if it isn't usable. */
function cleanNumber(value) {
  const v = String(value || '').trim().replace(/\s+/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,29}$/.test(v) ? v : null;
}

async function numberTaken(number, exceptId = 0, trx = db) {
  return Boolean(await trx('invoices').where({ number }).whereNot('id', exceptId || 0).first());
}

/**
 * Permanently deletes invoices with their line items, history and payments. Bank lines that
 * were matched to those payments are unlinked; quotes they came from go back to "accepted".
 * Returns { invoices, payments } counts.
 */
async function deleteInvoices(trx, ids) {
  if (!ids.length) return { invoices: 0, payments: 0 };
  const paymentIds = await trx('payments').whereIn('invoice_id', ids).pluck('id');
  if (paymentIds.length) await trx('bank_txns').whereIn('payment_id', paymentIds).update({ payment_id: null });
  await trx('razorpay_orders').whereIn('invoice_id', ids).del();
  await trx('payments').whereIn('invoice_id', ids).del();
  await trx('line_items').where({ doc_type: 'invoice' }).whereIn('doc_id', ids).del();
  await trx('activities').where({ entity_type: 'invoice' }).whereIn('entity_id', ids).del();
  await trx('quotes').whereIn('invoice_id', ids).update({ invoice_id: null, status: 'accepted', updated_at: nowSql() });
  const invoices = await trx('invoices').whereIn('id', ids).del();
  return { invoices, payments: paymentIds.length };
}

const prefixFor = (segment, s) => (segment === 'student' ? s.edu_invoice_prefix : s.invoice_prefix);

/**
 * GST treatment: no GSTIN on our side means we can't charge GST; same state as us is
 * CGST+SGST; another Indian state is IGST; outside India is an export (no GST charged here).
 */
function defaultTaxMode(client, settings) {
  if (!settings.gstin) return 'none';
  if (client && client.country && client.country.toLowerCase() !== 'india') return 'none';
  if (client && client.state && settings.state && client.state.toLowerCase() !== settings.state.toLowerCase()) return 'inter';
  return 'intra';
}

const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Reads repeated item_* form fields into line items (rates in paise). Blank rows are dropped. */
function itemsFromForm(body) {
  const desc = toArray(body.item_description);
  const sac = toArray(body.item_sac);
  const qty = toArray(body.item_qty);
  const rate = toArray(body.item_rate);
  const items = [];
  for (let i = 0; i < desc.length; i += 1) {
    const description = str(desc[i], 500);
    if (!description) continue;
    items.push({
      description,
      sac: str(sac[i], 12),
      quantity: Math.max(0, Number(qty[i]) || 0) || 1,
      rate: toPaise(rate[i]),
    });
  }
  return items;
}

async function getItems(docType, docId, trx = db) {
  const rows = await trx('line_items').where({ doc_type: docType, doc_id: docId }).orderBy('sort');
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity), rate: Number(r.rate), amount: Number(r.amount) }));
}

async function replaceItems(trx, docType, docId, lines) {
  await trx('line_items').where({ doc_type: docType, doc_id: docId }).del();
  if (!lines.length) return;
  await trx('line_items').insert(lines.map((l, i) => ({
    doc_type: docType,
    doc_id: docId,
    description: l.description,
    sac: l.sac || null,
    quantity: l.quantity,
    rate: l.rate,
    amount: l.amount,
    sort: i,
  })));
}

function deriveInvoiceStatus(inv, today = todayIST()) {
  if (inv.status === 'draft' || inv.status === 'void') return inv.status;
  const balance = Number(inv.total) - Number(inv.amount_paid);
  if (balance <= 0) return 'paid';
  if (inv.due_date < today) return 'overdue';
  if (Number(inv.amount_paid) > 0) return 'partially_paid';
  return 'sent';
}

/** Recomputes amount_paid from confirmed payments (cash + TDS) and refreshes status. */
async function refreshInvoice(trx, invoiceId) {
  const inv = await trx('invoices').where({ id: invoiceId }).first();
  if (!inv) return null;
  const sum = await trx('payments').where({ invoice_id: invoiceId, status: 'confirmed' })
    .sum({ amount: 'amount', tds: 'tds' }).first();
  const amountPaid = Number(sum.amount || 0) + Number(sum.tds || 0);
  const next = { ...inv, amount_paid: amountPaid };
  next.status = deriveInvoiceStatus(next);
  const patch = { amount_paid: amountPaid, status: next.status, updated_at: nowSql() };
  if (next.status === 'paid' && !inv.paid_at) patch.paid_at = nowSql();
  if (next.status !== 'paid') patch.paid_at = null;
  await trx('invoices').where({ id: invoiceId }).update(patch);
  return { ...inv, ...patch };
}

/** Assigns the GST serial number (once) and moves a draft to its live status. */
async function issueInvoice(trx, invoiceId) {
  const inv = await trx('invoices').where({ id: invoiceId }).first();
  if (!inv || inv.status === 'void') return inv;
  const s = await getSettings();
  const patch = { updated_at: nowSql() };
  if (!inv.number) patch.number = await nextNumber(trx, prefixFor(inv.segment, s), inv.issue_date);
  if (inv.status === 'draft') patch.status = 'sent';
  await trx('invoices').where({ id: invoiceId }).update(patch);
  return refreshInvoice(trx, invoiceId);
}

async function createInvoice(trx, data, items) {
  const totals = computeTotals(items, { taxMode: data.tax_mode, gstRate: data.gst_rate, discount: data.discount });
  const client = await trx('clients').where({ id: data.client_id }).first();
  const [id] = await trx('invoices').insert({
    client_id: data.client_id,
    segment: client && client.segment === 'student' ? 'student' : 'business',
    number: data.number || null, // typed in by hand; otherwise assigned when issued
    project_id: data.project_id || null,
    quote_id: data.quote_id || null,
    retainer_id: data.retainer_id || null,
    title: data.title || null,
    issue_date: data.issue_date,
    due_date: data.due_date,
    status: 'draft',
    tax_mode: data.tax_mode,
    gst_rate: data.gst_rate,
    place_of_supply: data.place_of_supply || null,
    subtotal: totals.subtotal,
    discount: totals.discount,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    total: totals.total,
    amount_paid: 0,
    notes: data.notes || null,
    terms: data.terms || null,
    public_token: randomToken(24),
    created_at: nowSql(),
    updated_at: nowSql(),
  });
  await replaceItems(trx, 'invoice', id, totals.lines);
  return id;
}

async function invoiceFromQuote(quoteId, userId) {
  const s = await getSettings();
  return db.transaction(async (trx) => {
    const q = await trx('quotes').where({ id: quoteId }).first();
    if (!q) throw new Error('Quote not found');
    if (q.invoice_id) return q.invoice_id;
    const client = await trx('clients').where({ id: q.client_id }).first();
    const items = await getItems('quote', q.id, trx);
    const today = todayIST();
    const id = await createInvoice(trx, {
      client_id: q.client_id,
      quote_id: q.id,
      title: q.title,
      issue_date: today,
      due_date: addDays(today, Number(s.default_due_days) || 7),
      tax_mode: q.tax_mode,
      gst_rate: Number(q.gst_rate),
      place_of_supply: client.state,
      discount: Number(q.discount),
      notes: q.notes,
      terms: s.invoice_terms,
    }, items);
    await trx('quotes').where({ id: q.id }).update({ invoice_id: id, status: 'invoiced', updated_at: nowSql() });
    await logActivity('quote', q.id, userId, 'system', 'Converted to a draft invoice', trx);
    return id;
  });
}

async function invoiceFromRetainer(trx, retainer, issueDate) {
  const s = await getSettings();
  const client = await trx('clients').where({ id: retainer.client_id }).first();
  const items = await getItems('retainer', retainer.id, trx);
  const id = await createInvoice(trx, {
    client_id: retainer.client_id,
    project_id: retainer.project_id,
    retainer_id: retainer.id,
    title: `${retainer.title} — ${formatDate(issueDate)}`,
    issue_date: issueDate,
    due_date: addDays(issueDate, Number(retainer.due_days) || 7),
    tax_mode: retainer.tax_mode,
    gst_rate: Number(retainer.gst_rate),
    place_of_supply: client.state,
    notes: retainer.notes,
    terms: s.invoice_terms,
  }, items);
  await issueInvoice(trx, id);
  return id;
}

function invoiceUrl(inv) {
  return `${config.baseUrl}/i/${inv.public_token}`;
}

async function sendInvoiceEmail(invoiceId, userId, { reminder = false } = {}) {
  const inv = await db('invoices').where({ id: invoiceId }).first();
  const client = await db('clients').where({ id: inv.client_id }).first();
  if (!client || !client.email) return { ok: false, reason: 'Client has no email address' };
  const s = await getSettings();
  const balance = Number(inv.total) - Number(inv.amount_paid);
  const overdue = inv.status === 'overdue';
  const subject = reminder
    ? `${overdue ? 'Overdue' : 'Reminder'}: invoice ${inv.number} — ${formatINR(balance)} ${overdue ? 'was due' : 'due'} ${formatDate(inv.due_date)}`
    : `Invoice ${inv.number} from ${s.legal_name} — ${formatINR(inv.total)}`;
  const ok = await sendMail({
    to: client.email,
    replyTo: s.email,
    subject,
    related: ['invoice', inv.id],
    heading: reminder ? (overdue ? 'Your invoice is overdue' : 'Friendly payment reminder') : 'Your invoice is ready',
    lines: [
      `Hi ${client.contact_name || client.name},`,
      reminder
        ? `This is a reminder that invoice ${inv.number} has a balance of ${formatINR(balance)}${overdue ? `, which was due on ${formatDate(inv.due_date)}` : `, due on ${formatDate(inv.due_date)}`}.`
        : `Please find invoice ${inv.number}${inv.title ? ` for ${inv.title}` : ''}. You can view, download and pay it online.`,
      reminder ? 'If you have already paid, please ignore this email or reply with the payment reference.' : 'Thank you for working with us.',
    ],
    rows: [
      ['Invoice', inv.number],
      ['Amount', formatINR(inv.total)],
      ...(Number(inv.amount_paid) > 0 ? [['Balance due', formatINR(balance)]] : []),
      ['Due date', formatDate(inv.due_date)],
    ],
    button: { label: balance > 0 ? 'View & pay invoice' : 'View invoice', url: invoiceUrl(inv) },
  });
  const patch = { updated_at: nowSql() };
  if (!reminder && !inv.sent_at) patch.sent_at = nowSql();
  if (reminder) patch.last_reminder_at = nowSql();
  await db('invoices').where({ id: inv.id }).update(patch);
  await logActivity('invoice', inv.id, userId, 'email', `${reminder ? 'Reminder' : 'Invoice'} emailed to ${client.email}${ok ? '' : ' (not delivered — check email settings)'}`);
  return { ok, reason: ok ? null : 'Email could not be delivered (check SMTP settings). The invoice link still works.' };
}

/**
 * Records a payment against an invoice. Razorpay payments are idempotent on payment id, so a
 * checkout callback and a webhook for the same payment record it once.
 */
async function recordPayment(data, { notify = true } = {}) {
  const result = await db.transaction(async (trx) => {
    if (data.razorpay_payment_id) {
      const dup = await trx('payments').where({ razorpay_payment_id: data.razorpay_payment_id }).first();
      if (dup) return { id: dup.id, duplicate: true };
    }
    const inv = await trx('invoices').where({ id: data.invoice_id }).first();
    if (!inv) throw new Error('Invoice not found');
    const [id] = await trx('payments').insert({
      invoice_id: inv.id,
      client_id: inv.client_id,
      amount: Math.max(0, Math.round(data.amount)),
      tds: Math.max(0, Math.round(data.tds || 0)),
      method: data.method,
      reference: data.reference || null,
      status: data.status || 'confirmed',
      razorpay_payment_id: data.razorpay_payment_id || null,
      razorpay_order_id: data.razorpay_order_id || null,
      paid_on: data.paid_on || todayIST(),
      notes: data.notes || null,
      recorded_by: data.recorded_by || null,
      created_at: nowSql(),
    });
    const updated = await refreshInvoice(trx, inv.id);
    const verb = (data.status || 'confirmed') === 'pending' ? 'Payment reported by client (to verify)' : 'Payment recorded';
    await logActivity('invoice', inv.id, data.recorded_by, 'system',
      `${verb}: ${formatINR(data.amount)}${data.tds ? ` + TDS ${formatINR(data.tds)}` : ''} via ${methodLabel(data.method)}${data.reference ? ` (ref ${data.reference})` : ''}`, trx);
    return { id, invoice: updated };
  });
  if (!result.duplicate && notify && (data.status || 'confirmed') === 'confirmed') {
    await sendReceipt(result.id).catch((e) => console.error('[receipt]', e.message));
  }
  return result;
}

async function sendReceipt(paymentId) {
  const p = await db('payments').where({ id: paymentId }).first();
  const inv = await db('invoices').where({ id: p.invoice_id }).first();
  const client = await db('clients').where({ id: p.client_id }).first();
  const s = await getSettings();
  const balance = Number(inv.total) - Number(inv.amount_paid);
  if (client && client.email) {
    await sendMail({
      to: client.email,
      replyTo: s.email,
      subject: `Payment received — ${formatINR(p.amount)} for invoice ${inv.number}`,
      related: ['invoice', inv.id],
      heading: 'Payment received. Thank you!',
      lines: [`Hi ${client.contact_name || client.name},`, `We have received your payment for invoice ${inv.number}.`],
      rows: [
        ['Amount received', formatINR(p.amount)],
        ...(Number(p.tds) ? [['TDS deducted', formatINR(p.tds)]] : []),
        ['Method', methodLabel(p.method)],
        ...(p.reference ? [['Reference', p.reference]] : []),
        ['Balance due', formatINR(Math.max(0, balance))],
      ],
      button: { label: 'View invoice', url: invoiceUrl(inv) },
    });
  }
  await sendMail({
    to: config.notifyEmail,
    subject: `💰 ${formatINR(p.amount)} received from ${client ? client.name : 'client'} (${inv.number})`,
    related: ['invoice', inv.id],
    heading: 'Payment received',
    lines: [`${client ? client.name : 'A client'} paid ${formatINR(p.amount)} via ${methodLabel(p.method)}.`],
    rows: [['Invoice', inv.number], ['Invoice total', formatINR(inv.total)], ['Balance', formatINR(Math.max(0, balance))]],
    button: { label: 'Open invoice', url: `${config.baseUrl}/admin/invoices/${inv.id}` },
  });
}

module.exports = {
  nextNumber, previewNumber, setNextSequence, cleanNumber, numberTaken, prefixFor, deleteInvoices, defaultTaxMode, itemsFromForm, getItems, replaceItems, deriveInvoiceStatus, refreshInvoice,
  issueInvoice, createInvoice, invoiceFromQuote, invoiceFromRetainer, sendInvoiceEmail, recordPayment, invoiceUrl,
};
