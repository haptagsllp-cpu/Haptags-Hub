'use strict';

// Local demo data so every screen has something to show. Refuses to run against MySQL/production.
// Usage: npm run seed-demo   (then sign in as demo@haptags.local / demo-password-123)

const config = require('../src/config');
const { db, migrate } = require('../src/db');
const { hashPassword } = require('../src/lib/auth');
const { getSettings, setSettings } = require('../src/lib/settings');
const { createInvoice, issueInvoice, recordPayment, replaceItems, nextNumber } = require('../src/lib/billing');
const { computeTotals } = require('../src/lib/money');
const { createLead } = require('../src/lib/leads');
const { nowSql, todayIST, addDays, addMonths, randomToken, istToUtc, addMinutesSql } = require('../src/lib/util');
const chat = require('../src/lib/chat');
const { createMeeting } = require('../src/lib/meetings');

if (config.isProd || config.db.client !== 'better-sqlite3') {
  console.error('seed-demo only runs against the local SQLite database.');
  process.exit(1);
}

async function main() {
  await migrate();
  if (await db('clients').first()) {
    console.log('Database already has data — skipping. Delete data/hub.sqlite to reseed.');
    return;
  }
  await setSettings({ gstin: '29AAAFH0000A1Z5', upi_id: 'haptags@demo', bank_account_number: '000000000000', bank_ifsc: 'DEMO0000001', bank_name: 'Demo Bank' });
  const s = await getSettings();
  const today = todayIST();
  const pw = await hashPassword('demo-password-123');
  const [ownerId] = await db('users').insert({ name: 'Demo Owner', email: 'demo@haptags.local', role: 'owner', password_hash: pw, is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });

  const clients = [
    { name: 'Sunrise Interiors', contact_name: 'Priya Rao', email: 'priya@sunrise.example', phone: '9876500001', state: 'Karnataka', city: 'Bengaluru', gstin: '29ABCDE1234F1Z5' },
    { name: 'Kaveri Foods Pvt Ltd', contact_name: 'Arjun Mehta', email: 'arjun@kaveri.example', phone: '9876500002', state: 'Telangana', city: 'Hyderabad', gstin: '36ABCDE1234F1Z5' },
    { name: 'Green Leaf Clinic', contact_name: 'Dr. Meera Nair', email: 'meera@greenleaf.example', phone: '9876500003', state: 'Karnataka', city: 'Mysuru' },
  ];
  const ids = [];
  for (const c of clients) {
    const [id] = await db('clients').insert({ ...c, country: 'India', status: 'active', created_at: nowSql(), updated_at: nowSql() });
    ids.push(id);
  }
  await db('users').insert({ name: 'Priya Rao', email: 'client@haptags.local', role: 'client', client_id: ids[0], password_hash: pw, is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });

  const [p1] = await db('projects').insert({ client_id: ids[0], name: 'Website redesign', service: 'website-development', status: 'in_progress', progress: 60, start_date: addDays(today, -30), due_date: addDays(today, 5), budget: 18000000, created_at: nowSql(), updated_at: nowSql() });
  await db('projects').insert({ client_id: ids[1], name: 'Ordering app', service: 'mobile-app-development', status: 'completed', progress: 100, start_date: addDays(today, -120), due_date: addDays(today, -20), budget: 65000000, created_at: nowSql(), updated_at: nowSql() });
  for (const [t, st] of [['Kick-off & requirements', 'done'], ['Design', 'done'], ['Build', 'doing'], ['Review & feedback', 'todo'], ['Launch', 'todo']]) {
    await db('milestones').insert({ project_id: p1, title: t, status: st, client_visible: true, completed_at: st === 'done' ? nowSql() : null, created_at: nowSql() });
  }
  await db('project_updates').insert({ project_id: p1, user_id: ownerId, client_visible: true, body: 'Homepage and services pages are live on staging for your review.', created_at: nowSql() });

  // Invoices across the last months so the revenue chart has a shape.
  const amounts = [42000, 65000, 38000, 90000, 72000, 120000, 85000, 54000, 98000, 110000, 76000];
  for (let i = 0; i < amounts.length; i += 1) {
    const issue = addDays(addMonths(today, -(amounts.length - i)), 2);
    const items = [{ description: 'Development & support services', sac: s.default_sac, quantity: 1, rate: amounts[i] * 100 }];
    const id = await db.transaction(async (trx) => {
      const iid = await createInvoice(trx, { client_id: ids[i % 2], issue_date: issue, due_date: addDays(issue, 7), tax_mode: i % 2 ? 'inter' : 'intra', gst_rate: 18, place_of_supply: clients[i % 2].state, terms: s.invoice_terms }, items);
      await issueInvoice(trx, iid);
      return iid;
    });
    const inv = await db('invoices').where({ id }).first();
    await recordPayment({ invoice_id: id, amount: Number(inv.total), method: i % 3 ? 'upi' : 'bank_transfer', reference: `DEMO${1000 + i}`, paid_on: addDays(issue, 5) }, { notify: false });
  }
  // One overdue, one open, one this month with a client-reported UPI payment.
  for (const [cid, issue, due, amt] of [[ids[0], addDays(today, -25), addDays(today, -10), 45000], [ids[2], addDays(today, -3), addDays(today, 4), 30000], [ids[1], addDays(today, -1), addDays(today, 6), 52000]]) {
    const id = await db.transaction(async (trx) => {
      const iid = await createInvoice(trx, { client_id: cid, project_id: cid === ids[0] ? p1 : null, title: 'Milestone billing', issue_date: issue, due_date: due, tax_mode: cid === ids[1] ? 'inter' : 'intra', gst_rate: 18, terms: s.invoice_terms }, [{ description: 'Milestone 2 — design & build', sac: s.default_sac, quantity: 1, rate: amt * 100 }]);
      await issueInvoice(trx, iid);
      return iid;
    });
    if (cid === ids[1]) await recordPayment({ invoice_id: id, amount: 2000000, method: 'upi', reference: '4281992100', status: 'pending' }, { notify: false });
  }
  await recordPayment({ invoice_id: (await db('invoices').orderBy('id', 'desc').first()).id - 2, amount: 1000000, method: 'upi', reference: 'THISMONTH1', paid_on: today }, { notify: false });

  // Quote
  const qItems = computeTotals([{ description: 'SEO & social media — 3 months', sac: '998361', quantity: 3, rate: 2500000 }], { taxMode: 'intra', gstRate: 18 });
  await db.transaction(async (trx) => {
    const number = await nextNumber(trx, s.quote_prefix, today);
    const [qid] = await trx('quotes').insert({ number, client_id: ids[2], title: 'Digital marketing retainer', issue_date: today, valid_until: addDays(today, 15), status: 'sent', tax_mode: 'intra', gst_rate: 18, subtotal: qItems.subtotal, discount: 0, cgst: qItems.cgst, sgst: qItems.sgst, igst: 0, total: qItems.total, terms: s.quote_terms, public_token: randomToken(24), sent_at: nowSql(), created_at: nowSql(), updated_at: nowSql() });
    await replaceItems(trx, 'quote', qid, qItems.lines);
  });

  // Retainer
  const rItems = computeTotals([{ description: 'Website maintenance, hosting & support', sac: '998315', quantity: 1, rate: 1500000 }], { taxMode: 'inter', gstRate: 18 });
  await db.transaction(async (trx) => {
    const [rid] = await trx('retainers').insert({ client_id: ids[1], title: 'App maintenance & hosting', interval: 'monthly', next_invoice_date: addMonths(`${today.slice(0, 7)}-01`, 1), due_days: 7, auto_send: true, tax_mode: 'inter', gst_rate: 18, subtotal: rItems.subtotal, status: 'active', created_at: nowSql(), updated_at: nowSql() });
    await replaceItems(trx, 'retainer', rid, rItems.lines);
  });

  // Leads
  const leads = [
    { name: 'Rahul Verma', email: 'rahul@verma.example', phone: '9876511111', company: 'Verma Realty', service: 'real-estate-technology', budget: '5l-15l', timeline: '2-4-months', message: 'Need a property listing portal with lead capture and CRM.' },
    { name: 'Sneha Kulkarni', email: 'sneha@bloom.example', phone: '9876522222', company: 'Bloom Bakery', service: 'ecommerce-development', budget: '50k-2l', timeline: '1-2-months', message: 'Online ordering website with WhatsApp notifications.' },
    { name: 'Imran Shaikh', email: 'imran@edu.example', phone: '9876533333', company: 'BrightPath Academy', service: 'lms-development', budget: '2l-5l', timeline: '2-4-months', message: 'LMS for 2,000 students with video and quizzes.' },
    { name: 'Kavya Iyer', email: 'kavya@studio.example', phone: '9876544444', service: 'ai-automation', budget: 'not-sure', message: 'WhatsApp bot to qualify leads for our clinic chain.' },
  ];
  for (const [i, l] of leads.entries()) {
    const { id } = await createLead(l, { source: ['website', 'whatsapp', 'referral', 'instagram'][i], notify: false });
    if (i === 1) await db('leads').where({ id }).update({ status: 'contacted', next_follow_up: today });
    if (i === 2) await db('leads').where({ id }).update({ status: 'proposal' });
  }
  await db('leads').insert({ name: 'Old Won Lead', status: 'won', source: 'referral', value_estimate: 9000000, created_at: nowSql(), updated_at: nowSql() });
  await db('leads').insert({ name: 'Old Lost Lead', status: 'lost', source: 'website', value_estimate: 4000000, lost_reason: 'Budget', created_at: nowSql(), updated_at: nowSql() });

  // Ticket
  const clientUser = await db('users').where({ email: 'client@haptags.local' }).first();
  const [tid] = await db('tickets').insert({ client_id: ids[0], project_id: p1, subject: 'Change hero image on homepage', status: 'open', priority: 'normal', created_by: clientUser.id, last_reply_at: nowSql(), last_reply_by: 'client', created_at: nowSql(), updated_at: nowSql() });
  await db('ticket_messages').insert({ ticket_id: tid, user_id: clientUser.id, body: 'Can we use the new showroom photo on the homepage banner?', internal: false, created_at: nowSql() });

  // Workspace: a teammate, some chat, today's meetings and an announcement.
  const [staffId] = await db('users').insert({ name: 'Arjun Shetty', email: 'staff@haptags.local', role: 'staff', password_hash: pw, is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });
  await chat.ensureMemberships(ownerId);
  await chat.ensureMemberships(staffId);
  const general = await db('channels').where({ name: 'general' }).first();
  await chat.postMessage({ channelId: general.id, userId: ownerId, body: 'Morning team! Standup at 10:30 today. Please update your project milestones before then.' });
  await chat.postMessage({ channelId: general.id, userId: staffId, body: 'Done. The Menon Exports homepage draft is ready for review: https://www.haptags.com' });
  const dm = await chat.directChannel(ownerId, staffId);
  await chat.postMessage({ channelId: dm, userId: staffId, body: 'Can we move the client call to 4pm?' });
  const now = nowSql();
  await createMeeting({ title: 'Daily standup', agenda: 'Yesterday, today, blockers', startsAt: istToUtc(today, '10:30'), duration: 15, createdBy: ownerId, userIds: [staffId] });
  await createMeeting({
    title: 'Website review with Menon Exports', agenda: 'Walk through the homepage draft\nAgree on launch date',
    startsAt: addMinutesSql(now, 20), duration: 45, createdBy: ownerId, userIds: [staffId], emails: ['asha@menon.example'],
  });
  await db('announcements').insert({
    title: 'Diwali holidays', body: 'The office is closed on Friday and Monday. Please hand over anything urgent by Thursday evening.',
    important: true, pinned: true, created_by: ownerId, created_at: now, updated_at: now,
  });

  console.log('Demo data ready.\n  Team:   demo@haptags.local / demo-password-123 (also staff@haptags.local)\n  Client: client@haptags.local / demo-password-123');
}

main().then(() => db.destroy()).catch((err) => {
  console.error(err);
  db.destroy();
  process.exit(1);
});
