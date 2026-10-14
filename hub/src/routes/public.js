'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db } = require('../db');
const { getSettings } = require('../lib/settings');
const { parseEnquiry, createLead } = require('../lib/leads');
const { homeFor } = require('../lib/auth');
const { upiFor, loadDoc } = require('../lib/docs');
const { recordPayment } = require('../lib/billing');
const { createOrder, verifyPaymentSignature } = require('../lib/razorpay');
const { logActivity } = require('../lib/activity');
const { sendMail } = require('../lib/mailer');
const { formatINR, toPaise } = require('../lib/money');
const { nowSql, todayIST, str, safeEqual } = require('../lib/util');
const { STAFF_ROLES } = require('../lib/auth');

const router = express.Router();

const enquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const payLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

// Bots fill hidden fields and submit instantly; people don't.
function looksLikeSpam(body) {
  if (body.website_url || body.fax) return true;
  const started = Number(body.started);
  return Boolean(started) && Date.now() - started < 2500;
}

router.get('/', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('public/home', { title: 'Haptags Hub' });
});

router.get('/start', (req, res) => {
  res.render('public/start', { title: 'Start your project', values: { service: req.query.service || '' }, errors: {}, started: Date.now() });
});

router.post('/start', enquiryLimiter, async (req, res) => {
  if (looksLikeSpam(req.body)) return res.redirect('/start/thanks');
  const parsed = parseEnquiry(req.body);
  if (parsed.fields) {
    return res.status(422).render('public/start', { title: 'Start your project', values: req.body, errors: parsed.fields, started: Date.now() });
  }
  await createLead(parsed.lead, { source: 'hub-form', sourceDetail: str(req.body.utm_source || req.get('referer'), 255) });
  res.redirect('/start/thanks');
});

router.get('/start/thanks', (req, res) => {
  res.render('public/message', {
    title: 'Thank you', heading: 'Thanks — we’ve got your enquiry',
    body: 'Our team will get back to you within one working day. For anything urgent, message us on WhatsApp.',
    link: { href: res.locals.settings.website, label: 'Back to haptags.com' },
    whatsapp: true,
  });
});

// ---- Lead intake API -------------------------------------------------------------------
// Server-to-server: send header `X-API-Key: <key from Settings>`.
// Browser: allowed from LEAD_ORIGINS (haptags.com) without a key, with spam checks.
function cors(req, res) {
  const origin = req.get('origin');
  if (origin && config.leadOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    return true;
  }
  return false;
}

router.options('/api/v1/leads', (req, res) => {
  cors(req, res);
  res.sendStatus(204);
});

router.post('/api/v1/leads', enquiryLimiter, async (req, res) => {
  const allowedOrigin = cors(req, res);
  const s = await getSettings();
  const key = req.get('x-api-key');
  const trusted = Boolean(key) && safeEqual(key, s.lead_api_key);
  if (!trusted && !allowedOrigin) return res.status(401).json({ success: false, error: 'Missing or invalid API key.' });
  if (!trusted && looksLikeSpam(req.body)) return res.json({ success: true });
  const parsed = parseEnquiry(req.body || {});
  if (parsed.fields) return res.status(422).json({ success: false, error: 'Please check the highlighted fields.', fields: parsed.fields });
  const source = trusted ? str(req.body.source, 40) || 'website' : 'website';
  const detail = str(req.body.source_detail || req.body.kind || req.body.page, 255);
  const { id, duplicate } = await createLead(parsed.lead, { source, sourceDetail: detail });
  res.status(duplicate ? 200 : 201).json({ success: true, id, duplicate });
});

// Hosting cron backstop: GET /api/v1/cron?key=<CRON_KEY>
router.get('/api/v1/cron', async (req, res) => {
  if (!config.cronKey || !safeEqual(String(req.query.key || ''), config.cronKey)) return res.status(401).json({ ok: false });
  const { runAutomations } = require('../lib/automation');
  res.json({ ok: true, result: await runAutomations() });
});

// ---- Shareable invoice ------------------------------------------------------------------
async function findInvoice(req) {
  const inv = await db('invoices').where({ public_token: req.params.token }).first();
  if (!inv) return null;
  const isStaff = req.user && STAFF_ROLES.includes(req.user.role);
  if (inv.status === 'draft' && !isStaff) return null; // drafts are visible to the team only
  return inv;
}

router.get('/i/:token', async (req, res, next) => {
  const inv = await findInvoice(req);
  if (!inv) return next();
  const data = await loadDoc('invoice', inv);
  const balance = Math.max(0, Number(inv.total) - Number(inv.amount_paid));
  const payable = balance > 0 && !['draft', 'void'].includes(inv.status);
  const payments = await db('payments').where({ invoice_id: inv.id }).whereIn('status', ['confirmed', 'pending']).orderBy('paid_on');
  res.render('public/invoice', {
    layout: 'doc',
    title: `Invoice ${inv.number || '(draft)'}`,
    ...data,
    balance,
    payable,
    payments,
    upi: payable ? await upiFor(inv, balance) : null,
    razorpay: payable && config.razorpay.enabled,
    paid: req.query.paid === '1',
  });
});

router.post('/i/:token/razorpay-order', payLimiter, async (req, res) => {
  const inv = await findInvoice(req);
  if (!inv) return res.status(404).json({ ok: false, error: 'Invoice not found' });
  const balance = Number(inv.total) - Number(inv.amount_paid);
  if (balance <= 0 || inv.status === 'void' || inv.status === 'draft') return res.status(400).json({ ok: false, error: 'Nothing to pay on this invoice.' });
  if (!config.razorpay.enabled) return res.status(400).json({ ok: false, error: 'Online payment is not available.' });
  const s = await getSettings();
  const client = await db('clients').where({ id: inv.client_id }).first();
  const order = await createOrder({ amount: balance, receipt: inv.number, notes: { invoice: inv.number, invoice_id: String(inv.id) } });
  await db('razorpay_orders').insert({ order_id: order.id, invoice_id: inv.id, amount: balance, status: 'created', created_at: nowSql() });
  res.json({
    ok: true,
    key: config.razorpay.keyId,
    order_id: order.id,
    amount: balance,
    currency: 'INR',
    name: s.legal_name,
    description: `Invoice ${inv.number}`,
    prefill: { name: client.contact_name || client.name, email: client.email || '', contact: client.phone || '' },
  });
});

router.post('/i/:token/razorpay-verify', payLimiter, async (req, res) => {
  const inv = await findInvoice(req);
  if (!inv) return res.status(404).json({ ok: false, error: 'Invoice not found' });
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
  const order = orderId && await db('razorpay_orders').where({ order_id: orderId, invoice_id: inv.id }).first();
  if (!order || !verifyPaymentSignature({ orderId, paymentId, signature })) {
    return res.status(400).json({ ok: false, error: 'We could not verify this payment. If money was debited, it will be reconciled automatically — or contact us.' });
  }
  await recordPayment({
    invoice_id: inv.id, amount: Number(order.amount), method: 'razorpay', reference: paymentId,
    razorpay_payment_id: paymentId, razorpay_order_id: orderId, paid_on: todayIST(),
  });
  await db('razorpay_orders').where({ id: order.id }).update({ status: 'paid' });
  res.json({ ok: true, redirect: `/i/${inv.public_token}?paid=1` });
});

// Client says "I paid by UPI / bank transfer": recorded as pending until the team confirms it.
router.post('/i/:token/report-payment', payLimiter, async (req, res, next) => {
  const inv = await findInvoice(req);
  if (!inv || ['draft', 'void'].includes(inv.status)) return next();
  const amount = toPaise(req.body.amount);
  const reference = str(req.body.reference, 190);
  const method = req.body.method === 'bank_transfer' ? 'bank_transfer' : 'upi';
  if (amount <= 0 || !reference) {
    req.flash('error', 'Please enter the amount you paid and the UPI/UTR reference number.');
    return res.redirect(`/i/${inv.public_token}#pay`);
  }
  await recordPayment({
    invoice_id: inv.id, amount, method, reference, status: 'pending', paid_on: todayIST(),
    notes: 'Reported by client from the invoice page',
  });
  const client = await db('clients').where({ id: inv.client_id }).first();
  await sendMail({
    to: config.notifyEmail,
    subject: `Verify payment: ${formatINR(amount)} from ${client.name} (${inv.number})`,
    related: ['invoice', inv.id],
    heading: 'A client reported a payment',
    lines: ['Check your bank/UPI statement, then confirm the payment in Haptags Hub so the invoice is marked paid.'],
    rows: [['Client', client.name], ['Invoice', inv.number], ['Amount', formatINR(amount)], ['Method', method === 'upi' ? 'UPI' : 'Bank transfer'], ['Reference', reference]],
    button: { label: 'Review payment', url: `${config.baseUrl}/admin/payments?status=pending` },
  });
  req.flash('success', 'Thank you! We’ll confirm your payment shortly and email you a receipt.');
  res.redirect(`/i/${inv.public_token}`);
});

// ---- Shareable quote --------------------------------------------------------------------
async function findQuote(req) {
  const q = await db('quotes').where({ public_token: req.params.token }).first();
  if (!q) return null;
  const isStaff = req.user && STAFF_ROLES.includes(req.user.role);
  if (q.status === 'draft' && !isStaff) return null;
  return q;
}

router.get('/q/:token', async (req, res, next) => {
  const q = await findQuote(req);
  if (!q) return next();
  const data = await loadDoc('quote', q);
  res.render('public/quote', { layout: 'doc', title: `Quotation ${q.number}`, ...data, canRespond: q.status === 'sent' });
});

router.post('/q/:token/respond', async (req, res, next) => {
  const q = await findQuote(req);
  if (!q) return next();
  if (q.status !== 'sent') {
    req.flash('error', 'This quotation can no longer be changed.');
    return res.redirect(`/q/${q.public_token}`);
  }
  const accept = req.body.decision === 'accept';
  const name = str(req.body.name, 190);
  if (!name) {
    req.flash('error', 'Please type your name to confirm.');
    return res.redirect(`/q/${q.public_token}#respond`);
  }
  const comment = str(req.body.comment, 2000);
  await db('quotes').where({ id: q.id }).update({
    status: accept ? 'accepted' : 'declined', responded_at: nowSql(), responded_by: name, client_comment: comment, updated_at: nowSql(),
  });
  await logActivity('quote', q.id, req.user ? req.user.id : null, 'status', `${accept ? 'Accepted' : 'Declined'} by ${name}${comment ? `: “${comment}”` : ''}`);
  const client = await db('clients').where({ id: q.client_id }).first();
  if (accept && q.lead_id) await db('leads').where({ id: q.lead_id }).update({ status: 'won', updated_at: nowSql() });
  await sendMail({
    to: config.notifyEmail,
    subject: `${accept ? '🎉 Quote accepted' : 'Quote declined'}: ${q.number} — ${client.name} (${formatINR(q.total)})`,
    related: ['quote', q.id],
    heading: accept ? 'Quotation accepted!' : 'Quotation declined',
    lines: [
      `${name} ${accept ? 'accepted' : 'declined'} ${q.number} for ${client.name}.`,
      comment ? `Comment: “${comment}”` : '',
      accept ? 'Next step: convert it to an invoice for the advance and kick off the project.' : 'Consider a follow-up call to understand what would change their mind.',
    ].filter(Boolean),
    rows: [['Quote', q.number], ['Title', q.title], ['Total', formatINR(q.total)]],
    button: { label: 'Open quotation', url: `${config.baseUrl}/admin/quotes/${q.id}` },
  });
  req.flash('success', accept ? 'Thank you! Your acceptance has been recorded — we’ll be in touch with next steps.' : 'Thanks for letting us know. We’ve recorded your response.');
  res.redirect(`/q/${q.public_token}`);
});

module.exports = router;
