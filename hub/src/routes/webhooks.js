'use strict';

const express = require('express');
const { db } = require('../db');
const { verifyWebhookSignature } = require('../lib/razorpay');
const { recordPayment } = require('../lib/billing');
const { todayIST } = require('../lib/util');

const router = express.Router();

// Razorpay → Settings → Webhooks: URL <BASE_URL>/webhooks/razorpay, events payment.captured.
// Backstop for payments where the customer closed the browser before our callback ran.
router.post('/razorpay', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ ok: false, error: 'invalid signature' });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid json' });
  }
  if (event.event === 'payment.captured') {
    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    if (payment && payment.order_id) {
      const order = await db('razorpay_orders').where({ order_id: payment.order_id }).first();
      if (order) {
        await recordPayment({
          invoice_id: order.invoice_id,
          amount: Number(payment.amount),
          method: 'razorpay',
          reference: payment.id,
          razorpay_payment_id: payment.id,
          razorpay_order_id: payment.order_id,
          paid_on: todayIST(),
          notes: payment.method ? `Paid by ${payment.method}` : null,
        });
        await db('razorpay_orders').where({ id: order.id }).update({ status: 'paid' });
      }
    }
  }
  res.json({ ok: true });
});

module.exports = router;
