'use strict';

// End-to-end flows against a throwaway SQLite database: lead → client → quote → invoice → payment,
// Razorpay signatures, retainer billing, reminders, client portal isolation and CSRF, plus the
// workspace: chat privacy, live delivery, meeting lobby/signalling and announcements.

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
  LMS_KEY_SHA256: crypto.createHash('sha256').update('test-lms-key').digest('hex'),
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
  server.closeAllConnections();
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

async function staffUser(name, email, role = 'staff') {
  const { hashPassword } = require('../src/lib/auth');
  const [id] = await db('users').insert({
    name, email, role, password_hash: await hashPassword('staff-password-1'), is_active: true, token_version: 1,
    created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  });
  const b = new Browser();
  await b.login(email, 'staff-password-1');
  return { id, b };
}

test('chat: channels, private DMs, files and live delivery', async () => {
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  const ravi = await staffUser('Ravi Kumar', 'ravi@test.local');
  const meena = await staffUser('Meena Rao', 'meena@test.local');

  // First visit creates #general and lands there.
  let res = await owner.get('/admin/chat');
  assert.match(res.location, /^\/admin\/chat\/\d+$/);
  const general = Number(res.location.split('/').pop());
  await owner.get(res.location);
  res = await owner.post(`/admin/chat/${general}/messages`, { body: 'Hello team @ravi' }, { json: true });
  assert.equal(res.status, 201);

  await ravi.b.get('/admin/chat');
  const page = await ravi.b.get(`/admin/chat/${general}`);
  assert.match(page.text, /Hello team @ravi/, 'messages are embedded for the page script');

  // Live delivery: Ravi's tab is long-polling when Meena posts.
  await ravi.b.get('/admin');
  const conn = (await ravi.b.post('/api/rt/connect', {}, { json: true })).json();
  const waiting = ravi.b.post('/api/rt/poll', { cid: conn.cid, key: conn.key, after: conn.seq }, { json: true });
  await meena.b.get(`/admin/chat/${general}`);
  await meena.b.post(`/admin/chat/${general}/messages`, { body: 'Standup at 10' }, { json: true });
  const polled = (await waiting).json();
  const ev = polled.events.find((e) => e.type === 'chat.message');
  assert.equal(ev.data.message.body, 'Standup at 10');
  assert.ok(polled.online.includes(ravi.id));
  // Someone else's connection key doesn't work.
  assert.equal((await meena.b.post('/api/rt/poll', { cid: conn.cid, key: 'nope', after: 0 }, { json: true })).status, 401);

  // A 1:1 chat is private to its two members, and asking again reuses it.
  res = await owner.post('/admin/chat/new', { user_ids: [String(ravi.id)] });
  const dm = Number(res.location.split('/').pop());
  assert.equal((await owner.post('/admin/chat/new', { user_ids: [String(ravi.id)] })).location, `/admin/chat/${dm}`);
  await owner.get(`/admin/chat/${dm}`);
  await owner.post(`/admin/chat/${dm}/messages`, { body: 'Salary slips are ready' }, { json: true });
  assert.equal((await meena.b.get(`/admin/chat/${dm}`)).status, 404);
  assert.equal((await meena.b.post(`/admin/chat/${dm}/messages`, { body: 'x' }, { json: true })).status, 404);
  assert.match((await ravi.b.get('/admin')).text, /data-count="chat">2</, 'one unread in #general, one in the DM');

  // Files: stored in the database, served only to members.
  const up = await fetch(`${base}/admin/chat/${dm}/files`, {
    method: 'POST', body: Buffer.from('%PDF-1.4 test'),
    headers: { cookie: owner.header(), 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Q3 report.pdf'), 'x-csrf-token': owner.csrf },
  });
  assert.equal(up.status, 201);
  const fileId = (await up.json()).message.file.id;
  const dl = await fetch(`${base}/admin/chat/files/${fileId}`, { headers: { cookie: ravi.b.header() } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(await dl.text(), '%PDF-1.4 test');
  assert.equal((await meena.b.get(`/admin/chat/files/${fileId}`)).status, 404);

  // Only the author can edit or delete a message.
  const msg = await db('messages').where({ channel_id: dm, body: 'Salary slips are ready' }).first();
  assert.equal((await ravi.b.post(`/admin/chat/messages/${msg.id}/delete`, {}, { json: true })).status, 404);
  res = await owner.post(`/admin/chat/messages/${msg.id}/edit`, { body: 'Salary slips are out' }, { json: true });
  assert.equal(res.json().message.edited, true);

  // Starting a call from chat creates a team-only meeting and posts a Join card.
  res = await owner.post(`/admin/chat/${dm}/call`, {});
  assert.match(res.location, /^\/meet\/[a-f0-9]{32}$/);
  const call = await db('messages').where({ channel_id: dm, kind: 'call' }).first();
  assert.ok(call.meeting_id);
});

test('meetings: invites, lobby, admission and signalling', async () => {
  const { istToUtc, utcToIst } = require('../src/lib/util');
  assert.equal(istToUtc('2026-10-15', '10:00'), '2026-10-15 04:30:00');
  assert.deepEqual(utcToIst('2026-10-15 20:00:00'), { date: '2026-10-16', time: '01:30' });

  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  await owner.get('/admin/meetings/new');
  const form = {
    title: 'Kickoff with Acme', date: '2026-10-20', time: '15:00', duration_min: '45', agenda: 'Scope\nTimeline',
    emails: 'cto@acme.test, bad-address', allow_guests: '1', send_invites: '1',
  };
  let res = await owner.post('/admin/meetings', form);
  assert.equal(res.status, 422, 'invalid guest emails are caught');
  res = await owner.post('/admin/meetings', { ...form, emails: 'cto@acme.test' });
  const id = Number(res.location.split('/').pop());
  const meeting = await db('meetings').where({ id }).first();
  assert.equal(meeting.starts_at, '2026-10-20 09:30:00');
  const mail = await db('email_log').where({ to_email: 'cto@acme.test' }).first();
  assert.match(mail.subject, /invited: Kickoff with Acme/);
  const ics = (await owner.get(`/admin/meetings/${id}/invite.ics`)).text;
  assert.match(ics, /DTSTART:20261020T093000Z/);
  assert.match(ics, /DTEND:20261020T101500Z/);
  assert.match(ics, new RegExp(`/meet/${meeting.room_token}`));

  // A guest opens the link, joins and waits in the lobby.
  const guest = new Browser();
  assert.equal((await guest.get(`/meet/${meeting.room_token}`)).status, 200);
  const g = (await guest.post(`/meet/${meeting.room_token}/join`, { name: 'Acme CTO', mic: true, cam: true }, { json: true })).json();
  assert.equal(g.state, 'waiting');
  assert.equal((await guest.post(`/meet/${meeting.room_token}/signal`, { cid: g.cid, key: g.key, to: 'x', data: {} }, { json: true })).status, 409);

  // The host joins, sees the lobby and admits the guest.
  await owner.get(`/meet/${meeting.room_token}`);
  const h = (await owner.post(`/meet/${meeting.room_token}/join`, { mic: true, cam: false }, { json: true })).json();
  assert.equal(h.state, 'in');
  assert.equal(h.waiting[0].name, 'Acme CTO');
  const guestPoll = guest.post('/api/rt/poll', { cid: g.cid, key: g.key, after: g.seq }, { json: true });
  res = await owner.post(`/meet/${meeting.room_token}/action`, { cid: h.cid, key: h.key, action: 'admit', target: g.cid }, { json: true });
  assert.equal(res.status, 204);
  const gp = (await guestPoll).json();
  const admitted = gp.events.find((e) => e.type === 'room.admitted');
  assert.equal(admitted.data.peers[0].cid, h.cid);

  // Offers/answers are relayed between participants only.
  res = await guest.post(`/meet/${meeting.room_token}/signal`, { cid: g.cid, key: g.key, to: h.cid, data: { description: { type: 'offer', sdp: 'v=0' } } }, { json: true });
  assert.equal(res.status, 204);
  const hostEvents = (await owner.post('/api/rt/poll', { cid: h.cid, key: h.key, after: h.seq }, { json: true })).json().events;
  assert.ok(hostEvents.some((e) => e.type === 'room.joined' && e.data.peer.cid === g.cid));
  const sig = hostEvents.find((e) => e.type === 'signal');
  assert.equal(sig.data.from, g.cid);
  assert.equal(sig.data.data.description.type, 'offer');

  // Guests can't use host controls; the meeting page shows it as live.
  assert.equal((await guest.post(`/meet/${meeting.room_token}/action`, { cid: g.cid, key: g.key, action: 'remove', target: h.cid }, { json: true })).status, 409);
  assert.match((await owner.get(`/admin/meetings/${id}`)).text, /Live · 2 in call/);

  // Team-only meetings turn guests away; cancelled ones are closed.
  await db('meetings').where({ id }).update({ allow_guests: false });
  assert.equal((await new Browser().get(`/meet/${meeting.room_token}`)).status, 403);
  await owner.get(`/admin/meetings/${id}`);
  await owner.post(`/admin/meetings/${id}/cancel`, { notify: '1' });
  assert.equal((await new Browser().get(`/meet/${meeting.room_token}`)).status, 410);
  assert.ok(await db('email_log').where({ to_email: 'cto@acme.test' }).where('subject', 'like', 'Cancelled%').first());
});

test('announcements: admins post, everyone reads', async () => {
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  const priya = await staffUser('Priya S', 'priya@test.local');

  await owner.get('/admin/announcements');
  await owner.post('/admin/announcements', { title: 'Office closed Friday', body: 'Diwali holiday.', important: '1', pinned: '1' });
  await priya.b.get('/admin/announcements');
  assert.equal((await priya.b.post('/admin/announcements', { title: 'x', body: 'y' })).status, 403, 'staff cannot post');

  await db('announcement_reads').where({ user_id: priya.id }).del();
  let page = await priya.b.get('/admin');
  assert.match(page.text, /Office closed Friday/, 'shown on the dashboard until read');
  assert.match(page.text, /data-count="announcements">1</);
  await priya.b.get('/admin/announcements');
  page = await priya.b.get('/admin');
  assert.doesNotMatch(page.text, /class="news-banner/);
  assert.match((await owner.get('/admin/announcements')).text, /Seen by 2 of/);

  // The calendar renders the month with meetings and deadlines.
  assert.equal((await owner.get('/admin/calendar?month=2026-10')).status, 200);
});

test('LMS daily doubt session: one meeting per course per day, students invited once', async () => {
  const post = (body, key = 'test-lms-key') => fetch(`${base}/api/v1/lms/doubt-session`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body),
  });
  let res = await post({ course_slug: 'java-internship-training', course_title: 'Java Internship Training' }, 'wrong');
  assert.equal(res.status, 401);
  res = await post({ course_slug: '', course_title: 'x' });
  assert.equal(res.status, 422);

  const body = { course_slug: 'java-internship-training', course_title: 'Java Internship Training', student_email: 'Stu1@Example.test', student_name: 'Stu One' };
  res = await post(body);
  assert.equal(res.status, 200);
  const first = await res.json();
  assert.match(first.join_url, /\/meet\/[a-f0-9]{32}$/);
  assert.match(first.starts_at, /T13:30:00Z$/); // 19:00 IST
  assert.equal(first.duration_min, 60);
  const again = await (await post(body)).json();
  assert.equal(again.join_url, first.join_url, 'same course + day reuses the meeting');
  const other = await (await post({ ...body, student_email: 'stu2@example.test' })).json();
  assert.equal(other.join_url, first.join_url);
  const diff = await (await post({ ...body, course_slug: 'sql-internship-training', course_title: 'SQL' })).json();
  assert.notEqual(diff.join_url, first.join_url, 'each course has its own session');

  const token = first.join_url.split('/').pop();
  const meeting = await db('meetings').where({ room_token: token }).first();
  assert.ok(meeting.allow_guests, 'students join as guests');
  assert.ok(meeting.title.includes('Java Internship Training'));
  const invitees = await db('meeting_invitees').where({ meeting_id: meeting.id }).pluck('email');
  assert.deepEqual(invitees.sort(), ['stu1@example.test', 'stu2@example.test']);
  assert.equal(Number((await db('lms_sessions').count({ n: '*' }).first()).n), 2);
  const room = await fetch(`${base}/meet/${token}`);
  assert.equal(room.status, 200, 'students can open the room as guests');
});

test('education: programs, enrolment with instalments, student invoices and their own series', async () => {
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  await owner.get('/admin/education/programs');
  await owner.post('/admin/education/programs', { name: 'Web dev internship', kind: 'internship', fee: '11800', fee_includes_gst: '1', duration: '8 weeks' });
  const program = await db('programs').where({ name: 'Web dev internship' }).first();
  assert.equal(Number(program.fee), 1180000);

  await owner.get('/admin/education/students/new');
  let res = await owner.post('/admin/education/students', { name: 'Kiran Rao', phone: '9876543210', fee: '11800' });
  assert.equal(res.status, 302);
  res = await owner.post('/admin/education/students', { name: '', fee: '' });
  assert.equal(res.status, 422, 'name and fee are required');
  res = await owner.post('/admin/education/students', {
    name: 'Divya N', phone: '9876500000', email: 'divya@college.test', college: 'RVCE', course: 'B.E. CSE 3rd year',
    program_id: String(program.id), batch: 'Jan 2027', fee: '11800', installments: '2', paid_now: '7000', method: 'upi', reference: 'UPI123',
    state: 'Karnataka',
  });
  const studentId = Number(res.location.split('/').pop());
  const student = await db('clients').where({ id: studentId }).first();
  assert.equal(student.segment, 'student');
  const invoices = await db('invoices').where({ client_id: studentId }).orderBy('due_date');
  assert.equal(invoices.length, 2);
  assert.ok(invoices.every((i) => i.segment === 'student' && /^HTE\/\d\d-\d\d\/\d{4}$/.test(i.number)), 'student invoices use the HTE series');
  assert.equal(invoices.reduce((s, i) => s + Number(i.total), 0), 1180000, 'GST-inclusive fee: totals add back to the fee');
  assert.equal(Number(invoices[0].cgst), 45000, '₹5,900 incl. 18% = ₹5,000 + ₹450 CGST + ₹450 SGST');
  // ₹7,000 paid now: clears instalment 1 (₹5,900) and ₹1,100 of instalment 2.
  assert.equal(invoices[0].status, 'paid');
  assert.equal(Number(invoices[1].amount_paid), 110000);
  assert.equal(invoices[1].due_date > invoices[0].due_date, true);

  // Students stay out of the business client list but show under Education.
  assert.match((await owner.get(`/admin/education/students/${studentId}`)).text, /instalment 2 of 2/);
  assert.doesNotMatch((await owner.get('/admin/clients')).text, /Divya N/);
  assert.equal((await owner.get(`/admin/clients/${studentId}`)).location, `/admin/education/students/${studentId}`);
  const list = await owner.get('/admin/education/students?status=due');
  assert.match(list.text, /Divya N/);
  const overview = await owner.get('/admin/education?period=all');
  assert.equal(overview.status, 200);
  assert.match(overview.text, /Web dev internship/);
  assert.match((await owner.get('/admin/education/students.csv')).text, /Divya N/);
});

test('finance: bank statement import, dedupe, categories, matching and the CEO view', async () => {
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  // A student payment already recorded in the Hub, to be matched from the statement.
  const pay = await db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').where('i.segment', 'student').select('p.*').first();
  const d = pay.paid_on;
  const dmy = `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
  const csv = [
    'HDFC BANK Ltd.,,,,,,',
    'Statement From : 01/04/26 To : 30/04/26,,,,,,',
    ',,,,,,',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    `01/04/26,OPENING CREDIT FROM PARTNER CAPITAL,,01/04/26,,"1,00,000.00","1,00,000.00"`,
    `02/04/26,UPI-RAVI KUMAR-ravi@okaxis-SALARY APR,0000412345,02/04/26,"25,000.00",,"75,000.00"`,
    `03/04/26,POS 4123 HOSTINGER INDIA,1234,03/04/26,"2,499.00",,"72,501.00"`,
    `04/04/26,ACH D- GOOGLE ADS INDIA,99,04/04/26,"5,000.00",,"67,501.00"`,
    `05/04/26,GST CHARGES ON SMS ALERT,,05/04/26,17.70,,"67,483.30"`,
    `${dmy},UPI-DIVYA N-divya@oksbi-FEES,8812,${dmy},,"${(Number(pay.amount) / 100).toFixed(2)}","${(67483.30 + Number(pay.amount) / 100).toFixed(2)}"`,
    `28/04/26,NEFT CR-ICIC0000001-ACME CORP-MISC,N123,28/04/26,,"20,000.00","${(87483.30 + Number(pay.amount) / 100).toFixed(2)}"`,
    ',,,,Total,,',
  ].join('\r\n');
  await owner.get('/admin/finance');
  const upload = (body) => fetch(`${base}/admin/finance/import`, {
    method: 'POST', body, redirect: 'manual',
    headers: { cookie: owner.header(), 'content-type': 'text/csv', accept: 'application/json', 'x-csrf-token': owner.csrf, 'x-account': 'HDFC Current', 'x-file-name': 'apr.csv' },
  });
  let r = await upload(csv);
  let j = await r.json();
  assert.equal(r.status, 200, j.error);
  assert.equal(j.added, 7);
  assert.equal(j.matched, 1, 'the student fee credit matches the recorded payment');
  r = await upload(csv);
  j = await r.json();
  assert.equal(j.added, 0);
  assert.equal(j.duplicates, 7, 're-uploading the same statement adds nothing');

  const cat = async (like) => (await db('bank_txns').where('description', 'like', `%${like}%`).first()).category;
  assert.equal(await cat('SALARY'), 'salaries');
  assert.equal(await cat('HOSTINGER'), 'hosting');
  assert.equal(await cat('GOOGLE ADS'), 'marketing');
  assert.equal(await cat('SMS ALERT'), 'bank_charges');
  assert.equal(await cat('DIVYA'), 'student_fees');
  assert.equal(await cat('ACME'), 'uncategorized');

  // Teach it: Acme is a client; the partner capital isn't revenue.
  const acme = await db('bank_txns').where('description', 'like', '%ACME%').first();
  await owner.post(`/admin/finance/transactions/${acme.id}`, { category: 'client_payments' });
  assert.equal(await cat('ACME'), 'client_payments');
  await owner.post('/admin/finance/rules', { pattern: 'PARTNER CAPITAL', direction: 'in', category: 'capital_in' });
  assert.equal(await cat('PARTNER CAPITAL'), 'capital_in');

  const { analyse } = require('../src/lib/finance');
  const a = await analyse('2026-04-01', '2026-04-30');
  assert.equal(a.opening, 0);
  assert.equal(a.capital, 10000000, 'capital is not revenue');
  assert.equal(a.opex, 2500000 + 249900 + 500000 + 1770);
  assert.equal(a.costs[0].id, 'salaries');
  assert.ok(a.ratios.opexToRevenue > 0);

  const page = await owner.get('/admin/finance?from=2026-04-01&to=2026-04-30');
  assert.equal(page.status, 200);
  assert.match(page.text, /Salaries &amp; stipends/);
  assert.match((await owner.get('/admin/finance/transactions?period=all')).text, /Ravi Kumar/);
  assert.match((await owner.get('/admin/finance/export.csv?period=all')).text, /Hosting, domains & cloud/);

  // Finance is for owners and admins only.
  const staff = await staffUser('Sam Staff', 'sam@test.local');
  assert.equal((await staff.b.get('/admin/finance')).status, 403);
  assert.equal((await staff.b.get('/admin/education')).status, 200, 'the team can still enrol students');
});

test('partners: revenue credited to the partner who brought each client in', async () => {
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  const partners = await db('partners').orderBy('id');
  assert.deepEqual(partners.map((p) => p.dpin), ['11342035', '11342034', '11379873']);
  assert.equal(partners.find((p) => p.dpin === '11379873').status, 'resigned');
  const harsha = partners[0];

  // A client with a paid invoice, credited from the client page.
  const [cid] = await db('clients').insert({ name: 'Partner Test Client', status: 'active', state: 'Karnataka', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
  const { todayIST } = require('../src/lib/util');
  await owner.get('/admin/invoices/new');
  const res = await owner.post('/admin/invoices', {
    client_id: String(cid), issue_date: todayIST(), tax_mode: 'none', gst_rate: '0', item_description: 'Site', item_qty: '1', item_rate: '20000', action: 'issue',
  });
  const invId = Number(res.location.split('/').pop());
  await owner.post(`/admin/invoices/${invId}/payments`, { amount: '20000', method: 'upi', paid_on: todayIST() });
  await owner.get(`/admin/clients/${cid}`);
  await owner.post(`/admin/partners/credit/${cid}`, { partner_id: String(harsha.id) });
  assert.equal((await db('clients').where({ id: cid }).first()).partner_id, harsha.id);

  const page = await owner.get('/admin/partners?period=all');
  assert.equal(page.status, 200);
  assert.match(page.text, /Partner contribution statement/);
  assert.match(page.text, /Bhavesh Reddy Pagireddy[\s\S]*Resigned/);
  assert.match((await owner.get(`/admin/partners/${harsha.id}`)).text, /Partner Test Client/);

  // Bulk credit everyone not yet credited.
  await owner.post('/admin/partners/assign', { partner_id: String(harsha.id), segment: '' });
  assert.equal(Number((await db('clients').whereNull('partner_id').count({ n: '*' }).first()).n), 0);

  // Staff without a partner link can't see it; a linked partner can view but not edit.
  const plain = await staffUser('Plain Staff', 'plain@test.local');
  assert.equal((await plain.b.get('/admin/partners')).status, 403);
  const linked = await staffUser('Abhay A', 'abhay@test.local');
  await db('partners').where({ dpin: '11342034' }).update({ user_id: linked.id });
  assert.equal((await linked.b.get('/admin/partners')).status, 200);
  assert.equal((await linked.b.post('/admin/partners/assign', { partner_id: String(harsha.id) })).status, 403);
});

// Runs last: it ends by deleting every invoice.
test('invoice numbers: typed by hand, automatic continues past them, and an owner-only reset', async () => {
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  const { financialYear, todayIST } = require('../src/lib/util');
  const fy = financialYear(todayIST());
  const [clientId] = await db('clients').insert({ name: 'Numbering Co', status: 'active', state: 'Karnataka', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
  const form = (extra) => ({
    client_id: String(clientId), title: 'Old work', issue_date: todayIST(), tax_mode: 'intra', gst_rate: '18',
    item_description: 'Website', item_sac: '998314', item_qty: '1', item_rate: '1000', action: 'issue', ...extra,
  });

  await owner.get('/admin/invoices/new');
  let res = await owner.post('/admin/invoices', form({ number: `HT/${fy}/0037` }));
  const id = Number(res.location.split('/').pop());
  assert.equal((await db('invoices').where({ id }).first()).number, `HT/${fy}/0037`, 'the typed number is kept when issued');

  res = await owner.post('/admin/invoices', form({ number: `HT/${fy}/0037` }));
  assert.equal(res.status, 422, 'a number can only be used once');
  res = await owner.post('/admin/invoices', form({ number: 'bad number!' }));
  assert.equal(res.status, 422);

  // Continue the series at 37: 37 is taken, so the next automatic number is 38.
  await owner.get('/admin/settings?tab=billing');
  await owner.post('/admin/settings/numbering', { business_next: '37' });
  res = await owner.post('/admin/invoices', form({ number: '' }));
  const auto = await db('invoices').where({ id: Number(res.location.split('/').pop()) }).first();
  assert.equal(auto.number, `HT/${fy}/0038`);

  // Fix a number on an issued invoice.
  await owner.post(`/admin/invoices/${auto.id}/number`, { number: 'HAP-2025-112' });
  assert.equal((await db('invoices').where({ id: auto.id }).first()).number, 'HAP-2025-112');

  assert.match((await owner.get('/admin/settings/invoices-backup.csv')).text, /HAP-2025-112/);

  // Deleting single invoices: staff only drafts; owners and admins anything, payments included.
  const issued = await db('invoices').where({ number: `HT/${fy}/0037` }).first();
  await owner.post(`/admin/invoices/${issued.id}/payments`, { amount: '500', method: 'upi', paid_on: todayIST() });
  const staffer = await staffUser('Stu Staff', 'stu@test.local');
  await staffer.b.get(`/admin/invoices/${issued.id}`);
  await staffer.b.post(`/admin/invoices/${issued.id}/delete`, {});
  assert.ok(await db('invoices').where({ id: issued.id }).first(), 'staff cannot delete an issued invoice');
  await owner.get(`/admin/invoices/${issued.id}`);
  res = await owner.post(`/admin/invoices/${issued.id}/delete`, {});
  assert.equal(await db('invoices').where({ id: issued.id }).first(), undefined);
  assert.equal(Number((await db('payments').where({ invoice_id: issued.id }).count({ n: '*' }).first()).n), 0);

  // Bulk delete from the list.
  const a1 = Number((await owner.post('/admin/invoices', form({ number: 'BULK-1' }))).location.split('/').pop());
  const a2 = Number((await owner.post('/admin/invoices', form({ number: 'BULK-2' }))).location.split('/').pop());
  await owner.get('/admin/invoices');
  await owner.post('/admin/invoices/bulk-delete', { ids: [String(a1), String(a2)] });
  assert.equal(Number((await db('invoices').whereIn('id', [a1, a2]).count({ n: '*' }).first()).n), 0);
  assert.equal((await staffer.b.post('/admin/invoices/bulk-delete', { ids: [String(auto.id)] })).status, 403);

  // Reset: admins who aren't the owner can't; the owner must type the confirmation.
  const admin = await staffUser('Ada Admin', 'ada@test.local', 'admin');
  await admin.b.get('/admin/settings?tab=billing');
  await admin.b.post('/admin/settings/delete-invoices', { confirm: 'DELETE ALL INVOICES' });
  assert.ok(Number((await db('invoices').count({ n: '*' }).first()).n) > 0, 'an admin cannot wipe invoices');
  await owner.post('/admin/settings/delete-invoices', { confirm: 'delete' });
  assert.ok(Number((await db('invoices').count({ n: '*' }).first()).n) > 0, 'a wrong confirmation deletes nothing');
  const studentsBefore = Number((await db('clients').where({ segment: 'student' }).count({ n: '*' }).first()).n);
  await owner.post('/admin/settings/delete-invoices', { confirm: 'DELETE ALL INVOICES' });
  assert.equal(Number((await db('invoices').count({ n: '*' }).first()).n), 0);
  assert.equal(Number((await db('payments').count({ n: '*' }).first()).n), 0);
  assert.equal(Number((await db('bank_txns').whereNotNull('payment_id').count({ n: '*' }).first()).n), 0);
  assert.equal(Number((await db('clients').where({ segment: 'student' }).count({ n: '*' }).first()).n), studentsBefore, 'students are kept');
  res = await owner.post('/admin/invoices', form({ number: '' }));
  assert.equal((await db('invoices').where({ id: Number(res.location.split('/').pop()) }).first()).number, `HT/${fy}/0001`, 'numbering restarts');
});
