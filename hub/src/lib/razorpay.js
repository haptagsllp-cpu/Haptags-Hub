'use strict';

const crypto = require('crypto');
const config = require('../config');
const { safeEqual } = require('./util');

const API = 'https://api.razorpay.com/v1';

/** Creates a Razorpay order. `amount` is in paise. */
async function createOrder({ amount, receipt, notes }) {
  if (!config.razorpay.enabled) throw new Error('Razorpay is not configured');
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency: 'INR', receipt: String(receipt).slice(0, 40), notes }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body && body.error ? body.error.description : `HTTP ${res.status}`;
    throw new Error(`Razorpay order failed: ${msg}`);
  }
  return body;
}

/** Checkout success callback signature: HMAC_SHA256(order_id + '|' + payment_id, key_secret). */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!config.razorpay.keySecret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook secret). */
function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

module.exports = { createOrder, verifyPaymentSignature, verifyWebhookSignature };
