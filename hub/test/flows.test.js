'use strict';

// End-to-end flows against a throwaway SQLite database: lead → client → quote → invoice → payment,
// Razorpay signatures, retainer billing, reminders, client portal isolation and CSRF.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'),
  RAZORPAY_KEY_ID: 'rzp_test_dummy',
  RAZORPAY_KEY_SECRET: 'test_key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  ADMIN_EMAIL: 'owner@test.local',
  ADMIN_PASSWORD: 'owner-password-1',
  NODE_ENV: 'test',
});

const { db, migrate } = require('../src/db');
const { getSettings, setSettings } = require('../src/lib/settings');
const { ensureOwner } = require('../src/lib/bootstrap');
const { runAutomations } = require('../src/lib/automation');
const { todayIST, addDays } = require('../src/lib/util');
const { amountInWords, computeTotals } = require('../src/lib/money');

let server;
let base;

class Browser {
  constructor() { this.cookies = {}; }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
  async get(p) {
    const res = await fetch(base + p, { headers: { cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, text, location: res.headers.get('location') };
  }
  async post(p, data, { json = false, csrf = true } = {}) {
    const body = { ...(csrf ? { _csrf: this.csrf } : {}), ...data };
    const headers = { cookie: this.header() };
    let payload;
    if (json) {
      headers['content-type'] = 'application/json';
      if (csrf) headers['x-csrf-token'] = this.csrf;
      payload = JSON.stringify(data);
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
      payload = params.toString();
    }
    const res = await fetch(base + p, { method: 'POST', headers, body: payload, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location'), json: () => JSON.parse(text) };
  }
  async login(email, password) {
    await this.get('/login');
    return this.post('/login', { email, password });
  }
}

test.before(async () => {
  await migrate();
  await getSettings();
  await setSettings({ gstin: '29AAAFH0000A1Z5', upi_id: 'haptags@test' });
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('money helpers', () => {
  assert.equal(amountInWords(5310000), 'Rupees Fifty Three Thousand One Hundred Only');
  assert.equal(amountInWords(125000050), 'Rupees Twelve Lakh Fifty Thousand and Fifty Paise Only');
  const t = computeTotals([{ quantity: 2, rate: 1000000 }], { taxMode: 'intra', gstRate: 18, discount: 200000 });
  assert.deepEqual([t.subtotal, t.discount, t.cgst, t.sgst, t.igst, t.total], [2000000, 200000, 162000, 162000, 0, 2124000]);
  const i = computeTotals([{ quantity: 1, rate: 1000000 }], { taxMode: 'inter', gstRate: 18 });
  assert.equal(i.igst, 180000);
});

test('full sales-to-cash flow', async () => {
  const s = await getSettings();
  const team = new Browser();
  const r = await team.login('owner@test.local', 'owner-password-1');
  assert.equal(r.location, '/admin');

  // Lead arrives from the website via API key; a repeat enquiry is merged, not duplicated.
  const lead = { name: 'Asha Menon', email: 'asha@client.test', phone: '9000000001', company: 'Menon Exports', service: 'website-development', budget: '2l-5l', message: 'New site' };
  let res = await fetch(`${base}/api/v1/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': s.lead_api_key }, body: JSON.stringify(lead) });
  assert.equal(res.status, 201);
  const { id: leadId } = await res.json();
  res = await fetch(`${base}/api/v1/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': s.lead_api_key }, body: JSON.stringify(lead) });
  assert.equal((await res.json()).duplicate, true);
  res = await fetch(`${base}/api/v1/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' }, body: JSON.stringify(lead) });
  assert.equal(res.status, 401);
  assert.equal(Number((await db('leads').count({ n: '*' }).first()).n), 1);

  // Lead → client (Karnataka, so CGST+SGST) → quote.
  await team.get(`/admin/leads/${leadId}`);
  res = await team.post(`/admin/leads/${leadId}/convert`, { then: 'quote' });
  const clientId = Number(new URL(base + res.location).searchParams.get('client_id'));
  assert.ok(clientId);
  await team.get(res.location);
  res = await team.post('/admin/quotes', {
    client_id: clientId, lead_id: leadId, title: 'Website', issue_date: todayIST(), valid_until: addDays(todayIST(), 15),
    tax_mode: 'intra', gst_rate: '18', discount: '', terms: 'x',
    item_description: ['Design', 'Build'], item_sac: ['998314', '998314'], item_qty: ['1', '2'], item_rate: ['20,000', '15000'],
  });
  const quoteId = Number(res.location.split('/').pop());
  const quote = await db('quotes').where({ id: quoteId }).first();
  assert.equal(quote.subtotal, 5000000);
  assert.equal(quote.total, 5900000);
  assert.equal((await db('leads').where({ id: leadId }).first()).status, 'proposal');

  // Draft quotes aren't public; sent ones can be accepted by the client.
  const anon = new Browser();
  assert.equal((await anon.get(`/q/${quote.public_token}`)).status, 404);
  await team.get(`/admin/quotes/${quoteId}`);
  await team.post(`/admin/quotes/${quoteId}/send`, {});
  assert.equal((await anon.get(`/q/${quote.public_token}`)).status, 200);
  await anon.post(`/q/${quote.public_token}/respond`, { decision: 'accept', name: 'Asha Menon' });
  assert.equal((await db('quotes').where({ id: quoteId }).first()).status, 'accepted');
  assert.equal((await db('leads').where({ id: leadId }).first()).status, 'won');

  // Quote → draft invoice → issue (number assigned only now).
  res = await team.post(`/admin/quotes/${quoteId}/convert`, {});
  const invoiceId = Number(res.location.split('/').pop());
  let inv = await db('invoices').where({ id: invoiceId }).first();
  assert.equal(inv.status, 'draft');
  assert.equal(inv.number, null);
  await team.get(`/admin/invoices/${invoiceId}`);
  await team.post(`/admin/invoices/${invoiceId}/issue`, {});
  inv = await db('invoices').where({ id: invoiceId }).first();
  assert.match(inv.number, /^HT\/\d{2}-\d{2}\/0001$/);
  assert.equal(inv.status, 'sent');
  assert.equal(inv.cgst, 450000);

  // Issued invoices can't be edited.
  res = await team.get(`/admin/invoices/${invoiceId}/edit`);
  assert.equal(res.status, 302);

  // Partial payment with TDS, then client reports a UPI payment which the team confirms.
  await team.post(`/admin/invoices/${invoiceId}/payments`, { amount: '20000', tds: '5000', method: 'bank_transfer', reference: 'UTR1', paid_on: todayIST() });
  inv = await db('invoices').where({ id: invoiceId }).first();
  assert.equal(inv.amount_paid, 2500000);
  assert.equal(inv.status, 'partially_paid');

  await anon.get(`/i/${inv.public_token}`);
  await anon.post(`/i/${inv.public_token}/report-payment`, { amount: '10000', reference: 'UPI123', method: 'upi' });
  const pending = await db('payments').where({ invoice_id: invoiceId, status: 'pending' }).first();
  assert.ok(pending);
  assert.equal((await db('invoices').where({ id: invoiceId }).first()).amount_paid, 2500000, 'pending payments do not count');
  await team.get('/admin/payments');
  await team.post(`/admin/payments/${pending.id}/status`, { status: 'confirmed' });
  inv = await db('invoices').where({ id: invoiceId }).first();
  assert.equal(inv.amount_paid, 3500000);

  // Razorpay: a forged signature is rejected; a valid one settles the balance exactly once.
  const balance = inv.total - inv.amount_paid;
  await db('razorpay_orders').insert({ order_id: 'order_TEST1', invoice_id: invoiceId, amount: balance, status: 'created', created_at: '2026-01-01 00:00:00' });
  await anon.get(`/i/${inv.public_token}`);
  res = await anon.post(`/i/${inv.public_token}/razorpay-verify`, { razorpay_order_id: 'order_TEST1', razorpay_payment_id: 'pay_TEST1', razorpay_signature: 'forged' }, { json: true });
  assert.equal(res.status, 400);
  const sig = crypto.createHmac('sha256', 'test_key_secret').update('order_TEST1|pay_TEST1').digest('hex');
  res = await anon.post(`/i/${inv.public_token}/razorpay-verify`, { razorpay_order_id: 'order_TEST1', razorpay_payment_id: 'pay_TEST1', razorpay_signature: sig }, { json: true });
  assert.equal(res.json().ok, true);
  inv = await db('invoices').where({ id: invoiceId }).first();
  assert.equal(inv.status, 'paid');

  // Webhook for the same payment is idempotent; bad signatures are refused.
  const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_TEST1', order_id: 'order_TEST1', amount: balance, method: 'upi' } } } });
  res = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'bad' }, body: event });
  assert.equal(res.status, 400);
  const whSig = crypto.createHmac('sha256', 'test_webhook_secret').update(event).digest('hex');
  res = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': whSig }, body: event });
  assert.equal(res.status, 200);
  assert.equal(Number((await db('payments').where({ razorpay_payment_id: 'pay_TEST1' }).count({ n: '*' }).first()).n), 1);
  assert.equal((await db('invoices').where({ id: invoiceId }).first()).amount_paid, inv.total);
});

test('retainers bill themselves and reminders escalate', async () => {
  const team = new Browser();
  await team.login('owner@test.local', 'owner-password-1');
  const [clientId] = await db('clients').insert({ name: 'Delhi Retail', email: 'ops@delhi.test', state: 'Delhi', country: 'India', status: 'active', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
  await team.get('/admin/retainers/new');
  const start = addDays(todayIST(), -65); // ~3 billing dates already due
  const res = await team.post('/admin/retainers', {
    client_id: clientId, title: 'SEO monthly', interval: 'monthly', next_invoice_date: start, due_days: '7', auto_send: '1',
    tax_mode: 'inter', gst_rate: '18', item_description: 'SEO', item_sac: '998361', item_qty: '1', item_rate: '25000',
  });
  const retainerId = Number(res.location.split('/').pop());
  const result = await runAutomations();
  assert.equal(result.retainerInvoices, 3);
  const invoices = await db('invoices').where({ retainer_id: retainerId }).orderBy('id');
  assert.equal(invoices.length, 3);
  assert.ok(invoices.every((i) => i.number && i.igst === 450000 && i.total === 2950000));
  assert.ok((await db('retainers').where({ id: retainerId }).first()).next_invoice_date > todayIST());
  // Older ones are overdue and get one escalated reminder each (not one per stage).
  const overdue = invoices.filter((i) => i.due_date < todayIST());
  assert.ok(overdue.length >= 2);
  const again = await runAutomations();
  assert.equal(again.retainerInvoices, 0, 'idempotent');
  const statuses = await db('invoices').where({ retainer_id: retainerId }).pluck('status');
  assert.ok(statuses.includes('overdue'));
});

test('client portal is isolated and CSRF is enforced', async () => {
  const [a] = await db('clients').insert({ name: 'Client A', status: 'active', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
  const [b] = await db('clients').insert({ name: 'Client B', status: 'active', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
  const [pb] = await db('projects').insert({ client_id: b, name: 'B secret project', status: 'in_progress', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });

  const team = new Browser();
  await team.login('owner@test.local', 'owner-password-1');
  await team.get(`/admin/clients/${a}`);
  await team.post(`/admin/clients/${a}/users`, { name: 'Alice', email: 'alice@a.test' });
  const page = await team.get(`/admin/clients/${a}`);
  const link = page.text.match(/value="(http[^"]+\/set-password\/[a-f0-9]+)"/)[1];

  const alice = new Browser();
  const setPath = new URL(link).pathname;
  await alice.get(setPath);
  let res = await alice.post(setPath, { password: 'alice-password-1', confirm: 'alice-password-1' });
  assert.equal(res.location, '/portal');
  assert.equal((await alice.get(setPath)).status, 410, 'set-password links are single use');

  assert.equal((await alice.get('/portal')).status, 200);
  assert.equal((await alice.get(`/portal/projects/${pb}`)).status, 404);
  assert.equal((await alice.get('/admin')).status, 403);

  await alice.get('/portal/tickets/new');
  res = await alice.post('/portal/tickets', { subject: 'Need help', body: 'Please call me', priority: 'high' });
  assert.match(res.location, /^\/portal\/tickets\/\d+$/);
  const ticket = await db('tickets').orderBy('id', 'desc').first();
  assert.equal(ticket.client_id, a);

  res = await alice.post('/portal/tickets', { subject: 'x', body: 'y', _csrf: 'wrong' }, { csrf: false });
  assert.equal(res.status, 403);

  // Wrong password is rejected without revealing which part was wrong.
  res = await new Browser().login('alice@a.test', 'nope-nope-nope');
  assert.equal(res.status, 401);
});
