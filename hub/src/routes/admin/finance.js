'use strict';

const express = require('express');
const { db } = require('../../db');
const F = require('../../lib/finance');
const { pairChart } = require('../../lib/charts');
const { recordPayment } = require('../../lib/billing');
const { periodFrom, monthsBetween, monthLabel, PRESETS } = require('../../lib/period');
const { nowSql, str, int } = require('../../lib/util');
const { idParam, back } = require('./_helpers');

const router = express.Router();
const MAX_CSV = 5 * 1024 * 1024;

const decode = (v) => { try { return decodeURIComponent(v || ''); } catch { return ''; } };
const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

/** Bank CSVs are usually UTF-8, but some banks still export Windows-1252. */
function bufferToText(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

async function accounts() {
  return db('bank_txns').distinct('account').orderBy('account').pluck('account');
}

// ---------------- CEO view ----------------
router.get('/', async (req, res) => {
  const range = await F.dataRange();
  const period = periodFrom(req.query, { earliest: range ? range.from : null, latest: range ? range.to : null });
  const a = await F.analyse(period.from, period.to);
  const byMonth = Object.fromEntries(a.months.map((m) => [m.key, m]));
  const keys = range ? monthsBetween(period.from, period.to) : [];
  const multiYear = keys.length > 12;
  const chart = keys.length ? pairChart(keys.map((k) => ({
    label: monthLabel(k, multiYear), tip: monthLabel(k, true), a: Math.max(0, (byMonth[k] || {}).income || 0), b: Math.max(0, (byMonth[k] || {}).expense || 0),
  })), { label: 'Money in and out per month', names: ['Money in', 'Money out'] }) : '';
  res.render('admin/finance/index', {
    title: 'Finance & costs', tab: 'overview', period, presets: PRESETS, a, range, chart,
    imports: await db('bank_imports as b').leftJoin('users as u', 'u.id', 'b.uploaded_by').orderBy('b.id', 'desc').limit(6).select('b.*', 'u.name as uploaded_by_name'),
    accounts: await accounts(),
  });
});

// ---------------- Import ----------------
router.post('/import', express.raw({ type: ['text/*', 'application/octet-stream', 'application/vnd.ms-excel'], limit: MAX_CSV }), async (req, res) => {
  const fromForm = !Buffer.isBuffer(req.body);
  const text = fromForm ? String((req.body && req.body.csv) || '') : bufferToText(req.body);
  const account = str(fromForm ? req.body.account : decode(req.get('x-account')), 80) || 'Main account';
  const filename = str(fromForm ? 'pasted.csv' : decode(req.get('x-file-name')), 255);
  if (filename && /\.(xlsx?|pdf)$/i.test(filename)) {
    const msg = 'That’s an Excel/PDF file. Open it in Excel or Google Sheets and use File → Save as / Download → CSV, then upload the CSV.';
    return wantsJson(req) ? res.status(422).json({ error: msg }) : (req.flash('error', msg), res.redirect('/admin/finance'));
  }
  try {
    const r = await F.importStatement({ text, account, filename, userId: req.user.id });
    const msg = `Imported ${r.added} new transaction${r.added === 1 ? '' : 's'} from ${account}${r.duplicates ? ` (${r.duplicates} already imported, skipped)` : ''}${r.matched ? `, ${r.matched} matched to recorded payments` : ''}.`;
    req.flash('success', msg);
    if (wantsJson(req)) return res.json({ ok: true, message: msg, ...r });
    return res.redirect('/admin/finance?period=all');
  } catch (err) {
    if (wantsJson(req)) return res.status(422).json({ error: err.message });
    req.flash('error', err.message);
    return res.redirect('/admin/finance');
  }
});

router.post('/imports/:id/delete', async (req, res) => {
  const imp = await db('bank_imports').where({ id: idParam(req) }).first();
  if (imp) {
    await db('bank_txns').where({ import_id: imp.id }).del();
    await db('bank_imports').where({ id: imp.id }).del();
    req.flash('success', `Removed the ${imp.account} upload (${imp.rows_added} transactions).`);
  }
  res.redirect(back(req, '/admin/finance'));
});

// ---------------- Transactions ----------------
router.get('/transactions', async (req, res) => {
  const range = await F.dataRange();
  const period = periodFrom(req.query, { earliest: range ? range.from : null, latest: range ? range.to : null, fallback: 'all' });
  const category = F.CAT[req.query.category] ? req.query.category : '';
  const dir = ['in', 'out'].includes(req.query.dir) ? req.query.dir : '';
  const account = str(req.query.account, 80);
  const q = str(req.query.q, 100);
  const page = Math.max(1, int(req.query.page, 1));
  const query = db('bank_txns').whereBetween('txn_date', [period.from, period.to]);
  if (category) query.where('category', category);
  if (dir === 'in') query.where('credit', '>', 0);
  if (dir === 'out') query.where('debit', '>', 0);
  if (account) query.where('account', account);
  if (q) query.where((w) => w.where('description', 'like', `%${q}%`).orWhere('counterparty', 'like', `%${q}%`).orWhere('reference', 'like', `%${q}%`));
  const totals = await query.clone().sum({ debit: 'debit', credit: 'credit' }).count({ n: '*' }).first();
  const rows = await query.orderBy('txn_date', 'desc').orderBy('import_id', 'desc').orderBy('seq', 'desc').limit(101).offset((page - 1) * 100);

  // Money in that isn't linked to a payment yet: suggest open invoices with exactly that balance.
  const open = await db('invoices as i').join('clients as c', 'c.id', 'i.client_id').whereIn('i.status', ['sent', 'partially_paid', 'overdue'])
    .select('i.id', 'i.number', 'i.total', 'i.amount_paid', 'i.segment', 'c.name as client_name');
  const byBalance = {};
  for (const inv of open) (byBalance[Number(inv.total) - Number(inv.amount_paid)] = byBalance[Number(inv.total) - Number(inv.amount_paid)] || []).push(inv);
  for (const t of rows) if (Number(t.credit) > 0 && !t.payment_id) t.suggest = (byBalance[Number(t.credit)] || []).slice(0, 3);

  res.render('admin/finance/transactions', {
    title: 'Bank transactions', tab: 'transactions', period, presets: PRESETS, rows: rows.slice(0, 100), page, hasNext: rows.length > 100, hasPrev: page > 1,
    category, dir, account, q, accounts: await accounts(), categories: F.CATEGORIES,
    totals: { debit: Number(totals.debit || 0), credit: Number(totals.credit || 0), n: Number(totals.n || 0) },
    rules: await db('bank_rules').orderBy('id', 'desc'),
    uncategorized: Number((await db('bank_txns').where({ category: 'uncategorized' }).count({ n: '*' }).first()).n),
  });
});

router.post('/transactions/:id', async (req, res) => {
  const t = await db('bank_txns').where({ id: idParam(req) }).first();
  if (!t || !F.CAT[req.body.category]) return wantsJson(req) ? res.status(404).json({ error: 'Not found' }) : res.redirect('/admin/finance/transactions');
  await db('bank_txns').where({ id: t.id }).update({ category: req.body.category, categorized_by: 'user', notes: str(req.body.notes, 1000) ?? t.notes });
  let ruled = 0;
  const keyword = str(req.body.remember, 120);
  if (keyword) {
    // "Always do this": save a rule and apply it to everything not set by hand.
    await db('bank_rules').insert({ pattern: keyword, direction: Number(t.credit) > 0 ? 'in' : 'out', category: req.body.category, created_by: req.user.id, created_at: nowSql() });
    ruled = await F.recategorize();
  }
  if (wantsJson(req)) return res.json({ ok: true, ruled });
  req.flash('success', ruled ? `Saved, and the new rule updated ${ruled} more transaction${ruled === 1 ? '' : 's'}.` : 'Saved.');
  res.redirect(back(req, '/admin/finance/transactions'));
});

// Record a bank credit as the payment for an open invoice, in one click.
router.post('/transactions/:id/record', async (req, res) => {
  const t = await db('bank_txns').where({ id: idParam(req) }).first();
  const inv = await db('invoices').where({ id: int(req.body.invoice_id, 0) }).whereIn('status', ['sent', 'partially_paid', 'overdue']).first();
  if (!t || !inv || Number(t.credit) <= 0 || t.payment_id) {
    req.flash('error', 'That can’t be recorded (already linked, or the invoice is closed).');
    return res.redirect(back(req, '/admin/finance/transactions'));
  }
  const { id: paymentId } = await recordPayment({
    invoice_id: inv.id, amount: Number(t.credit), method: /upi/i.test(t.description) ? 'upi' : 'bank_transfer',
    reference: (t.reference || t.description || '').slice(0, 190), paid_on: t.txn_date, recorded_by: req.user.id, notes: 'Recorded from bank statement',
  });
  await db('bank_txns').where({ id: t.id }).update({ payment_id: paymentId, category: inv.segment === 'student' ? 'student_fees' : 'client_payments', categorized_by: 'match' });
  req.flash('success', `Recorded as payment for ${inv.number}. A receipt was sent if the email is on file.`);
  res.redirect(back(req, '/admin/finance/transactions'));
});

// ---------------- Rules ----------------
router.post('/rules', async (req, res) => {
  const pattern = str(req.body.pattern, 120);
  if (!pattern || !F.CAT[req.body.category]) {
    req.flash('error', 'A rule needs a keyword and a category.');
    return res.redirect(back(req, '/admin/finance/transactions'));
  }
  await db('bank_rules').insert({
    pattern, direction: ['in', 'out'].includes(req.body.direction) ? req.body.direction : 'any', category: req.body.category, created_by: req.user.id, created_at: nowSql(),
  });
  const n = await F.recategorize();
  req.flash('success', `Rule added. ${n} transaction${n === 1 ? '' : 's'} re-categorised.`);
  res.redirect(back(req, '/admin/finance/transactions'));
});

router.post('/rules/:id/delete', async (req, res) => {
  await db('bank_rules').where({ id: idParam(req) }).del();
  await F.recategorize();
  req.flash('success', 'Rule removed.');
  res.redirect(back(req, '/admin/finance/transactions'));
});

// ---------------- Export for the CA ----------------
router.get('/export.csv', async (req, res) => {
  const range = await F.dataRange();
  const period = periodFrom(req.query, { earliest: range ? range.from : null, latest: range ? range.to : null, fallback: 'all' });
  const rows = await db('bank_txns').whereBetween('txn_date', [period.from, period.to]).orderBy('txn_date').orderBy('import_id').orderBy('seq');
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Account', 'Description', 'Reference', 'Payee / payer', 'Money out (₹)', 'Money in (₹)', 'Balance (₹)', 'Category', 'Type', 'Notes'].map(cell).join(',')];
  for (const r of rows) {
    const c = F.CAT[r.category] || F.CAT.uncategorized;
    lines.push([r.txn_date, r.account, r.description, r.reference, r.counterparty, Number(r.debit) / 100 || '', Number(r.credit) / 100 || '',
      r.has_balance ? Number(r.balance) / 100 : '', c.label, c.type, r.notes].map(cell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="haptags-bank-${period.from}-to-${period.to}.csv"` });
  res.send(`﻿${lines.join('\r\n')}`);
});

module.exports = router;
