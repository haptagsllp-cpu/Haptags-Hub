'use strict';

const express = require('express');
const { db } = require('../../db');
const { refreshInvoice } = require('../../lib/billing');
const { logActivity } = require('../../lib/activity');
const { formatINR } = require('../../lib/money');
const { todayIST, str } = require('../../lib/util');
const { sendMail } = require('../../lib/mailer');
const { paginate, idParam, back } = require('./_helpers');
const { ADMIN_ROLES } = require('../../lib/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : '';
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : '';
  const query = db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').join('clients as c', 'c.id', 'p.client_id')
    .select('p.*', 'i.number as invoice_number', 'c.name as client_name')
    .orderByRaw("CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END").orderBy('p.paid_on', 'desc').orderBy('p.id', 'desc');
  if (status) query.where('p.status', status);
  if (month) query.where('p.paid_on', '>=', `${month}-01`).where('p.paid_on', '<=', `${month}-31`);
  const page = await paginate(query, req, 50);
  const monthStart = `${todayIST().slice(0, 7)}-01`;
  const [thisMonth, pending] = await Promise.all([
    db('payments').where({ status: 'confirmed' }).where('paid_on', '>=', monthStart).sum({ a: 'amount', t: 'tds' }).first(),
    db('payments').where({ status: 'pending' }).sum({ a: 'amount' }).count({ n: '*' }).first(),
  ]);
  res.render('admin/payments/index', {
    title: 'Payments', ...page, status, month,
    thisMonth: Number(thisMonth.a || 0), thisMonthTds: Number(thisMonth.t || 0),
    pendingAmount: Number(pending.a || 0), pendingCount: Number(pending.n),
  });
});

/** Confirm or reject a payment the client reported (UPI/bank) — or reverse a recorded one. */
router.post('/:id/status', async (req, res, next) => {
  const p = await db('payments').where({ id: idParam(req) }).first();
  if (!p) return next();
  const to = ['confirmed', 'rejected'].includes(req.body.status) ? req.body.status : null;
  if (!to || to === p.status) return res.redirect(back(req, '/admin/payments'));
  if (p.status === 'confirmed' && !ADMIN_ROLES.includes(req.user.role)) {
    req.flash('error', 'Only an admin can reverse a confirmed payment.');
    return res.redirect(back(req, '/admin/payments'));
  }
  await db.transaction(async (trx) => {
    await trx('payments').where({ id: p.id }).update({ status: to, recorded_by: req.user.id });
    await refreshInvoice(trx, p.invoice_id);
    await logActivity('invoice', p.invoice_id, req.user.id, 'system', `Payment of ${formatINR(p.amount)} ${to === 'confirmed' ? 'confirmed' : 'rejected'}${req.body.reason ? `: ${str(req.body.reason, 255)}` : ''}`, trx);
  });
  if (to === 'confirmed') {
    const inv = await db('invoices').where({ id: p.invoice_id }).first();
    const client = await db('clients').where({ id: p.client_id }).first();
    if (client.email) {
      await sendMail({
        to: client.email,
        subject: `Payment received — ${formatINR(p.amount)} for invoice ${inv.number}`,
        related: ['invoice', inv.id],
        heading: 'Payment confirmed. Thank you!',
        lines: [`Hi ${client.contact_name || client.name},`, `We’ve confirmed your payment of ${formatINR(p.amount)} for invoice ${inv.number}.`],
        rows: [['Reference', p.reference || '—'], ['Balance due', formatINR(Math.max(0, Number(inv.total) - Number(inv.amount_paid)))]],
      });
    }
  }
  req.flash('success', to === 'confirmed' ? 'Payment confirmed and receipt sent.' : 'Payment rejected.');
  res.redirect(back(req, '/admin/payments'));
});

module.exports = router;
