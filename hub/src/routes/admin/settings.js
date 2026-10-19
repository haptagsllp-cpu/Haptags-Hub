'use strict';

const express = require('express');
const config = require('../../config');
const { db } = require('../../db');
const { getSettings, setSettings, DEFAULTS } = require('../../lib/settings');
const {
  requireAdmin, createPasswordLink, INVITE_DAYS, verifyPassword, hashPassword, passwordProblem, signIn,
} = require('../../lib/auth');
const { mailEnabled, sendMail } = require('../../lib/mailer');
const { runAutomations } = require('../../lib/automation');
const { nowSql, str, isEmail, randomToken, int, todayIST, financialYear } = require('../../lib/util');
const { previewNumber, setNextSequence } = require('../../lib/billing');
const { idParam } = require('./_helpers');

const router = express.Router();

const GROUPS = {
  company: ['company_name', 'legal_name', 'tagline', 'address', 'city', 'state', 'pincode', 'gstin', 'pan', 'llpin', 'udyam', 'email', 'phone', 'website', 'whatsapp'],
  billing: ['invoice_prefix', 'quote_prefix', 'default_due_days', 'quote_valid_days', 'default_gst_rate', 'default_sac', 'invoice_terms', 'quote_terms',
    'edu_invoice_prefix', 'edu_sac', 'edu_gst_rate', 'edu_due_days', 'edu_terms'],
  payments: ['upi_id', 'upi_name', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'bank_branch'],
  automation: ['auto_reminders', 'lead_auto_reply'],
};
const CHECKBOXES = ['auto_reminders', 'lead_auto_reply'];

router.get('/settings', requireAdmin, async (req, res) => {
  const tab = GROUPS[req.query.tab] || req.query.tab === 'integrations' ? req.query.tab : 'company';
  const s = await getSettings();
  const today = todayIST();
  res.render('admin/settings/index', {
    title: 'Settings', tab, s,
    numbering: {
      fy: financialYear(today),
      business: await previewNumber(s.invoice_prefix, today),
      student: await previewNumber(s.edu_invoice_prefix, today),
      invoiceCount: Number((await db('invoices').count({ n: '*' }).first()).n),
      paymentCount: Number((await db('payments').count({ n: '*' }).first()).n),
    },
    status: {
      mail: mailEnabled, razorpay: config.razorpay.enabled, webhook: Boolean(config.razorpay.webhookSecret),
      db: config.db.client, notifyEmail: config.notifyEmail, mailFrom: config.mailFrom,
    },
  });
});

router.post('/settings', requireAdmin, async (req, res) => {
  const group = GROUPS[req.body.group] ? req.body.group : null;
  if (!group) return res.redirect('/admin/settings');
  const values = {};
  for (const key of GROUPS[group]) {
    if (CHECKBOXES.includes(key)) values[key] = req.body[key] ? '1' : '0';
    else if (key in req.body) values[key] = str(req.body[key], 5000) || '';
  }
  if (values.gstin) values.gstin = values.gstin.toUpperCase();
  if (values.invoice_prefix) values.invoice_prefix = values.invoice_prefix.replace(/[^A-Za-z0-9-]/g, '').slice(0, 6) || DEFAULTS.invoice_prefix;
  if (values.edu_invoice_prefix) values.edu_invoice_prefix = values.edu_invoice_prefix.replace(/[^A-Za-z0-9-]/g, '').slice(0, 6) || DEFAULTS.edu_invoice_prefix;
  if (values.edu_invoice_prefix && values.edu_invoice_prefix === (values.invoice_prefix || '')) values.edu_invoice_prefix = `${values.edu_invoice_prefix}E`.slice(0, 6);
  if (values.quote_prefix) values.quote_prefix = values.quote_prefix.replace(/[^A-Za-z0-9-]/g, '').slice(0, 6) || DEFAULTS.quote_prefix;
  if (values.whatsapp) values.whatsapp = values.whatsapp.replace(/\D/g, '');
  await setSettings(values);
  req.flash('success', 'Settings saved.');
  res.redirect(`/admin/settings?tab=${group}`);
});

// Where automatic numbering continues this financial year (e.g. after last year's invoices).
router.post('/settings/numbering', requireAdmin, async (req, res) => {
  const s = await getSettings();
  const today = todayIST();
  const set = [];
  for (const [field, prefix] of [['business_next', s.invoice_prefix], ['student_next', s.edu_invoice_prefix]]) {
    const n = int(req.body[field], 0);
    if (n >= 1 && n <= 99999) {
      await setNextSequence(prefix, today, n);
      set.push(await previewNumber(prefix, today));
    }
  }
  req.flash('success', set.length ? `Next automatic numbers: ${set.join(' and ')}.` : 'Nothing changed.');
  res.redirect('/admin/settings?tab=billing');
});

// Everything invoiced so far, as a CSV, so nothing is lost before a reset.
router.get('/settings/invoices-backup.csv', requireAdmin, async (req, res) => {
  const rows = await db('invoices as i').join('clients as c', 'c.id', 'i.client_id').orderBy('i.id')
    .select('i.*', 'c.name as client_name');
  const pays = await db('payments').orderBy('id');
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const money = (p) => (Number(p) / 100).toFixed(2);
  const lines = [['Invoice', 'Type', 'Client / student', 'Title', 'Date', 'Due', 'Status', 'Taxable', 'GST', 'Total', 'Paid', 'Payments'].map(cell).join(',')];
  for (const r of rows) {
    const p = pays.filter((x) => x.invoice_id === r.id)
      .map((x) => `${x.paid_on} ${money(x.amount)} ${x.method}${x.reference ? ` ${x.reference}` : ''} (${x.status})`).join('; ');
    lines.push([r.number || `Draft #${r.id}`, r.segment, r.client_name, r.title, r.issue_date, r.due_date, r.status,
      money(Number(r.subtotal) - Number(r.discount)), money(Number(r.cgst) + Number(r.sgst) + Number(r.igst)), money(r.total), money(r.amount_paid), p]
      .map(cell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="haptags-invoices-backup-${todayIST()}.csv"` });
  res.send(`\uFEFF${lines.join('\r\n')}`);
});

// Start over: deletes every invoice and the payments recorded against them. Owner only, typed confirmation.
router.post('/settings/delete-invoices', requireAdmin, async (req, res) => {
  if (req.user.role !== 'owner') {
    req.flash('error', 'Only the owner can delete all invoices.');
    return res.redirect('/admin/settings?tab=billing');
  }
  if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE ALL INVOICES') {
    req.flash('error', 'Type DELETE ALL INVOICES to confirm. Nothing was deleted.');
    return res.redirect('/admin/settings?tab=billing');
  }
  const s = await getSettings();
  const counts = await db.transaction(async (trx) => {
    const invoices = Number((await trx('invoices').count({ n: '*' }).first()).n);
    const payments = Number((await trx('payments').count({ n: '*' }).first()).n);
    await trx('bank_txns').whereNotNull('payment_id').update({ payment_id: null });
    await trx('razorpay_orders').del();
    await trx('payments').del();
    await trx('line_items').where({ doc_type: 'invoice' }).del();
    await trx('activities').where({ entity_type: 'invoice' }).del();
    await trx('quotes').whereNotNull('invoice_id').update({ invoice_id: null, status: 'accepted', updated_at: nowSql() });
    await trx('invoices').del();
    // Automatic numbering starts again at 0001 in each series.
    for (const prefix of [s.invoice_prefix, s.edu_invoice_prefix]) await trx('sequences').where('name', 'like', `${prefix}:%`).del();
    return { invoices, payments };
  });
  console.log(`[settings] ${req.user.email} deleted all invoices (${counts.invoices}) and payments (${counts.payments})`);
  req.flash('success', `Deleted ${counts.invoices} invoice${counts.invoices === 1 ? '' : 's'} and ${counts.payments} payment${counts.payments === 1 ? '' : 's'}. Numbering starts fresh; set where it continues below.`);
  res.redirect('/admin/settings?tab=billing');
});

router.post('/settings/regenerate-key', requireAdmin, async (req, res) => {
  await setSettings({ lead_api_key: `hl_${randomToken(20)}` });
  req.flash('success', 'New lead API key generated. Update it wherever the old key was used.');
  res.redirect('/admin/settings?tab=integrations');
});

router.post('/settings/test-email', requireAdmin, async (req, res) => {
  const ok = await sendMail({
    to: req.user.email, subject: 'Haptags Hub test email', heading: 'Email is working',
    lines: ['If you can read this, Haptags Hub can send invoices, reminders and receipts.'],
  });
  req.flash(ok ? 'success' : 'error', ok ? `Test email sent to ${req.user.email}.` : 'Email failed. Check SMTP_* settings on the server and the email log.');
  res.redirect('/admin/settings?tab=integrations');
});

router.post('/automation/run', async (req, res) => {
  const r = await runAutomations();
  if (r.skipped) req.flash('info', 'Automations are already running.');
  else req.flash('success', `Automations ran: ${r.retainerInvoices} retainer invoice(s), ${r.reminders} reminder(s), ${r.overdue} marked overdue, ${r.quotesExpired} quote(s) expired.`);
  res.redirect(req.get('referer') && req.get('referer').includes('/admin') ? new URL(req.get('referer')).pathname : '/admin');
});

// ---- Team ------------------------------------------------------------------------------
router.get('/team', requireAdmin, async (req, res) => {
  const users = await db('users').whereIn('role', ['owner', 'admin', 'staff']).orderBy('name');
  const inviteLink = req.session.inviteLink || null;
  req.session.inviteLink = null;
  res.render('admin/settings/team', { title: 'Team', users, inviteLink });
});

router.post('/team', requireAdmin, async (req, res) => {
  const name = str(req.body.name, 190);
  const email = (str(req.body.email, 190) || '').toLowerCase();
  const role = ['admin', 'staff'].includes(req.body.role) ? req.body.role : 'staff';
  if (!name || !isEmail(email)) {
    req.flash('error', 'Enter a name and valid email.');
    return res.redirect('/admin/team');
  }
  if (await db('users').where({ email }).first()) {
    req.flash('error', 'That email already has an account.');
    return res.redirect('/admin/team');
  }
  const [uid] = await db('users').insert({ name, email, role, is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });
  const link = await createPasswordLink(uid);
  const sent = await sendMail({
    to: email, subject: 'You’ve been added to Haptags Hub', heading: 'Welcome to Haptags Hub',
    lines: [`Hi ${name},`, `${req.user.name} added you to Haptags Hub as ${role}. Set your password to get started (the link works for ${INVITE_DAYS} days).`],
    button: { label: 'Set my password', url: link },
  });
  req.session.inviteLink = { name, link, sent };
  res.redirect('/admin/team');
});

router.post('/team/:id', requireAdmin, async (req, res, next) => {
  const user = await db('users').where({ id: idParam(req) }).whereIn('role', ['owner', 'admin', 'staff']).first();
  if (!user) return next();
  if (user.role === 'owner' || user.id === req.user.id) {
    req.flash('error', 'You can’t change the owner account or your own access here.');
    return res.redirect('/admin/team');
  }
  if (req.body.action === 'toggle') {
    await db('users').where({ id: user.id }).update({ is_active: !user.is_active, token_version: user.token_version + 1, updated_at: nowSql() });
  } else if (req.body.action === 'role' && ['admin', 'staff'].includes(req.body.role)) {
    await db('users').where({ id: user.id }).update({ role: req.body.role, updated_at: nowSql() });
  } else if (req.body.action === 'resend') {
    const link = await createPasswordLink(user.id);
    const sent = await sendMail({
      to: user.email, subject: 'Set your Haptags Hub password', heading: 'Set your password',
      lines: [`Hi ${user.name},`, `Use this link to set your password (works for ${INVITE_DAYS} days).`], button: { label: 'Set my password', url: link },
    });
    req.session.inviteLink = { name: user.name, link, sent };
  }
  res.redirect('/admin/team');
});

router.get('/emails', requireAdmin, async (req, res) => {
  const rows = await db('email_log').orderBy('id', 'desc').limit(200);
  res.render('admin/settings/emails', { title: 'Email log', rows, mailEnabled });
});

// ---- Account (any staff) -----------------------------------------------------------------
router.get('/account', (req, res) => res.render('admin/settings/account', { title: 'My account', error: null }));

router.post('/account', async (req, res) => {
  const ok = await verifyPassword(req.body.current || '', req.user.password_hash);
  const problem = !ok ? 'Your current password is incorrect.' : passwordProblem(req.body.password) || (req.body.password !== req.body.confirm ? 'The new passwords don’t match.' : null);
  if (problem) return res.status(422).render('admin/settings/account', { title: 'My account', error: problem });
  const v = req.user.token_version + 1;
  await db('users').where({ id: req.user.id }).update({ password_hash: await hashPassword(req.body.password), token_version: v, updated_at: nowSql() });
  signIn(req, { ...req.user, token_version: v });
  req.flash('success', 'Password changed. Other devices have been signed out.');
  res.redirect('/admin/account');
});

// ---- Global search -----------------------------------------------------------------------
router.get('/search', async (req, res) => {
  const q = str(req.query.q, 100);
  let results = { leads: [], clients: [], invoices: [], quotes: [], projects: [] };
  if (q) {
    const like = `%${q}%`;
    const [leads, clients, invoices, quotes, projects] = await Promise.all([
      db('leads').where((w) => w.where('name', 'like', like).orWhere('email', 'like', like).orWhere('phone', 'like', like).orWhere('company', 'like', like)).orderBy('id', 'desc').limit(10),
      db('clients').where((w) => w.where('name', 'like', like).orWhere('contact_name', 'like', like).orWhere('email', 'like', like).orWhere('phone', 'like', like).orWhere('gstin', 'like', like)).limit(10),
      db('invoices as i').join('clients as c', 'c.id', 'i.client_id').where((w) => w.where('i.number', 'like', like).orWhere('i.title', 'like', like)).select('i.*', 'c.name as client_name').orderBy('i.id', 'desc').limit(10),
      db('quotes as q').join('clients as c', 'c.id', 'q.client_id').where((w) => w.where('q.number', 'like', like).orWhere('q.title', 'like', like)).select('q.*', 'c.name as client_name').orderBy('q.id', 'desc').limit(10),
      db('projects as p').join('clients as c', 'c.id', 'p.client_id').where('p.name', 'like', like).select('p.*', 'c.name as client_name').limit(10),
    ]);
    results = { leads, clients, invoices, quotes, projects };
  }
  res.render('admin/search', { title: 'Search', q, results });
});

module.exports = router;
