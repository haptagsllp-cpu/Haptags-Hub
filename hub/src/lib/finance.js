'use strict';

// Bank statement import and cost analysis. Statements from HDFC, ICICI, SBI, Axis, Kotak and
// most other Indian banks export as CSV with a few lines of preamble, then a header row. We find
// that header, map its columns, and store each line once (re-uploading overlapping statements
// is safe). Lines are categorised by the team's own rules first, then by built-in keywords.

const crypto = require('crypto');
const { db } = require('../db');
const { nowSql, addDays } = require('./util');

const CATEGORIES = [
  // Money in
  { id: 'client_payments', label: 'Client payments', type: 'income' },
  { id: 'student_fees', label: 'Student & internship fees', type: 'income' },
  { id: 'interest', label: 'Interest', type: 'income' },
  { id: 'refunds_in', label: 'Refunds received', type: 'income' },
  { id: 'other_income', label: 'Other income', type: 'income' },
  { id: 'capital_in', label: 'Capital & loans received', type: 'capital' },
  // Operating costs
  { id: 'salaries', label: 'Salaries & stipends', type: 'expense' },
  { id: 'contractors', label: 'Contractors & freelancers', type: 'expense' },
  { id: 'program_costs', label: 'Program delivery (trainers, certificates)', type: 'expense' },
  { id: 'rent', label: 'Rent & office', type: 'expense' },
  { id: 'software', label: 'Software & subscriptions', type: 'expense' },
  { id: 'hosting', label: 'Hosting, domains & cloud', type: 'expense' },
  { id: 'marketing', label: 'Marketing & ads', type: 'expense' },
  { id: 'travel', label: 'Travel & conveyance', type: 'expense' },
  { id: 'food', label: 'Food & meals', type: 'expense' },
  { id: 'utilities', label: 'Phone, internet & utilities', type: 'expense' },
  { id: 'professional', label: 'Professional fees (CA, legal)', type: 'expense' },
  { id: 'equipment', label: 'Equipment & supplies', type: 'expense' },
  { id: 'bank_charges', label: 'Bank charges', type: 'expense' },
  { id: 'refunds_out', label: 'Refunds paid', type: 'expense' },
  { id: 'other_expense', label: 'Other expenses', type: 'expense' },
  // Taxes
  { id: 'gst', label: 'GST paid', type: 'tax' },
  { id: 'tds', label: 'TDS paid', type: 'tax' },
  { id: 'income_tax', label: 'Income tax', type: 'tax' },
  // Not profit or loss
  { id: 'owner', label: 'Owner / partner drawings', type: 'transfer' },
  { id: 'transfer', label: 'Own-account transfers', type: 'transfer' },
  { id: 'loan_repay', label: 'Loan repayments', type: 'transfer' },
  { id: 'uncategorized', label: 'Uncategorized', type: 'none' },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// Built-in hints: [regex, category, direction]. Checked after the team's own rules.
const HINTS = [
  [/\b(salary|salaries|sal\s|payroll|stipend)\b/i, 'salaries', 'out'],
  [/\b(rent|lease|coworking|co-working|wework|awfis|91springboard)\b/i, 'rent', 'out'],
  [/(google\s*ads|googleads|adwords|facebook|fb\s*ads|meta\s*platforms|metaplatforms|instagram|linkedin|justdial|indiamart)/i, 'marketing', 'out'],
  [/(hostinger|godaddy|namecheap|bigrock|amazon\s*web|aws|digitalocean|linode|vercel|netlify|cloudflare|heroku|azure|google\s*cloud|gcp|firebase|hetzner|vultr)/i, 'hosting', 'out'],
  [/(google\s*workspace|gsuite|g\s*suite|microsoft|office\s*365|zoom|canva|figma|adobe|notion|slack|github|openai|chatgpt|anthropic|claude\.ai|atlassian|jira|freshworks|zoho|hubspot|grammarly|apple\.com|play\s*store|google\s*play|youtube\s*premium|spotify|netflix)/i, 'software', 'out'],
  [/(swiggy|zomato|eatsure|dominos|starbucks|restaurant|cafe|hotel\s*food|blinkit|zepto|bigbasket|instamart)/i, 'food', 'out'],
  [/(uber|ola\s|olacabs|rapido|irctc|makemytrip|goibibo|indigo|air\s*india|vistara|akasa|redbus|petrol|fuel|hpcl|bpcl|iocl|indian\s*oil|fastag|metro)/i, 'travel', 'out'],
  [/(airtel|jio|vodafone|vi\s|bsnl|act\s*fibernet|hathway|electricity|bescom|tneb|msedcl|water\s*bill|broadband)/i, 'utilities', 'out'],
  [/(amazon|flipkart|croma|reliance\s*digital|vijay\s*sales|stationery|printer)/i, 'equipment', 'out'],
  [/(\bca\b|chartered|legal|advocate|audit|registrar|mca\s|roc\s|vakilsearch|indiafilings|cleartax)/i, 'professional', 'out'],
  // Bank charges before taxes: their narrations often mention the GST levied on them.
  [/(charges|chrgs|chgs|\bchg\b|sms\s*alert|annual\s*fee|amb\s|min\s*bal|commission|imps\s*fee|neft\s*fee|debit\s*card\s*fee|gst\s*on\s*charges|service\s*charge)/i, 'bank_charges', 'out'],
  [/(\bgst\b|cbic|gstn|cgst|sgst|igst|gst\s*pmt|gstpmt)/i, 'gst', 'out'],
  [/(\btds\b|tin-?nsdl|itns\s*281|challan\s*281|oltas)/i, 'tds', 'out'],
  [/(income\s*tax|itns\s*280|advance\s*tax|self\s*assessment)/i, 'income_tax', 'out'],
  [/(\bemi\b|loan\s*repay|loan\s*a\/c|loan\s*instal)/i, 'loan_repay', 'out'],
  [/(refund|reversal|chargeback)/i, 'refunds_in', 'in'],
  [/(\bfees?\b|tuition|internship|\bcourse\b|workshop|bootcamp|training|enrol)/i, 'student_fees', 'in'],
  [/(int\.?\s*pd|interest|int\s*cr|int\.?\s*credit|sb\s*int|fd\s*int)/i, 'interest', 'in'],
  [/(capital|partner\s*contribution|loan\s*disb|disbursal)/i, 'capital_in', 'in'],
  [/(self\s*transfer|own\s*account|to\s*self|by\s*self|sweep)/i, 'transfer', 'any'],
];

// ---------------- CSV ----------------

/** Parses CSV text (comma, semicolon or tab separated; quoted fields; CRLF) into rows of strings. */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLines = src.split(/\r?\n/).slice(0, 30).join('\n');
  const counts = { ',': (firstLines.match(/,/g) || []).length, ';': (firstLines.match(/;/g) || []).length, '\t': (firstLines.match(/\t/g) || []).length };
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Finds the header row and which column holds what. Returns null if it doesn't look like a statement. */
function detectColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const h = rows[i].map(norm);
    const find = (re, not) => h.findIndex((c) => re.test(c) && !(not && not.test(c)));
    const map = {
      date: find(/^(txn |tran |transaction |posting )?date$|^date$|^txn dt|^tran date|^transaction date/),
      valueDate: find(/value date|value dt/),
      description: find(/narration|description|particulars|remarks|details|transaction details/),
      reference: find(/ref|chq|cheque|utr|instrument/),
      debit: find(/withdrawal|debit|dr amount|^dr$|amount dr|paid out|^out$/),
      credit: find(/deposit|credit|cr amount|^cr$|amount cr|paid in|^in$/),
      amount: find(/^amount|^txn amount|^transaction amount/, /dr|cr|debit|credit/),
      type: find(/^(dr cr|cr dr|type|debit credit|txn type)$|dr cr/),
      balance: find(/balance/),
    };
    if (map.date === -1) map.date = map.valueDate;
    const hasMoney = (map.debit !== -1 && map.credit !== -1) || (map.amount !== -1);
    if (map.date !== -1 && map.description !== -1 && hasMoney) return { headerIndex: i, map };
  }
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Indian statements write dates day-first: 05/04/26, 05-04-2026, 05 Apr 2026, 05-Apr-26, 2026-04-05. */
function parseBankDate(value) {
  const v = String(value || '').trim();
  let y; let m; let d;
  let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v);
  if (r) { [, y, m, d] = r.map(Number); }
  else if ((r = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/.exec(v))) { d = Number(r[1]); m = Number(r[2]); y = Number(r[3]); }
  else if ((r = /^(\d{1,2})[-/. ]([A-Za-z]{3,4})[a-z]*[-/., ]+(\d{2,4})/.exec(v))) { d = Number(r[1]); m = MONTHS[r[2].toLowerCase()]; y = Number(r[3]); }
  else return null;
  if (y < 100) y += 2000;
  if (!m || m > 12 || !d || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** '1,23,456.78', '1234.5 Cr', '(500.00)', '-' -> paise (always positive) plus a sign hint. */
function parseAmount(value) {
  const v = String(value || '').trim();
  if (!v || v === '-' || v === '--') return { paise: 0, hint: null };
  const hint = /\bcr\b|cr$/i.test(v) ? 'cr' : /\bdr\b|dr$/i.test(v) ? 'dr' : null;
  const negative = /^\(.*\)$/.test(v) || /^-/.test(v);
  const n = Number(v.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return { paise: 0, hint };
  return { paise: Math.round(n * 100), hint, negative };
}

/** Best-guess payee/payer from a narration, e.g. "UPI/412345678/RAVI KUMAR/okaxis/..." -> "Ravi Kumar". */
function counterparty(description) {
  const skip = /^(upi|neft|imps|rtgs|ach|nach|ecs|mmt|inb|ib|bil|onl|pos|atm|cash|chq|clg|trf|transfer|to|by|from|cr|dr|p2a|p2m|p2p|payment|pymt|ref|txn|ift|bank|okaxis|oksbi|okicici|okhdfcbank|ybl|paytm|ibl|axl|inr|rs|d|c|mb|net|nb)$/i;
  for (const part of String(description || '').split(/[/\-:|*@]+/)) {
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(part.trim())) continue; // IFSC code
    // Drop reference numbers and channel words (UPI, NEFT, CR…); what's left is usually the name.
    const name = part.split(/\s+/).filter((w) => w && !/\d/.test(w) && !skip.test(w)).join(' ');
    if (!/[a-z]{3}/i.test(name)) continue;
    return name.slice(0, 60).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
}

/** Turns parsed CSV rows into transactions, oldest first. Throws a readable error if it can't. */
function readStatement(text) {
  const rows = parseCsv(text);
  const found = detectColumns(rows);
  if (!found) {
    throw new Error('Couldn’t find the transaction table. The CSV needs a header row with a date, a narration/description, and either withdrawal & deposit columns or an amount column.');
  }
  const { headerIndex, map } = found;
  const txns = [];
  for (const r of rows.slice(headerIndex + 1)) {
    const date = parseBankDate(r[map.date]);
    if (!date) continue; // totals, page footers, blank lines
    let debit = 0;
    let credit = 0;
    if (map.debit !== -1 && map.credit !== -1) {
      debit = parseAmount(r[map.debit]).paise;
      credit = parseAmount(r[map.credit]).paise;
    } else {
      // One amount column: the direction comes from a Dr/Cr column, a Dr/Cr suffix, or the sign.
      const a = parseAmount(r[map.amount]);
      const type = map.type !== -1 ? norm(r[map.type]) : '';
      if (/^c|credit|deposit/.test(type) || a.hint === 'cr') credit = a.paise;
      else if (/^d|debit|withdraw/.test(type) || a.hint === 'dr' || a.negative) debit = a.paise;
      else if (!type) credit = a.paise;
      else continue;
    }
    if (!debit && !credit) continue;
    const balCell = map.balance !== -1 ? String(r[map.balance] || '').trim() : '';
    const bal = /\d/.test(balCell) ? parseAmount(balCell) : null;
    const description = (r[map.description] || '').replace(/\s+/g, ' ').slice(0, 500);
    txns.push({
      date, description, debit, credit,
      reference: map.reference !== -1 ? (r[map.reference] || '').slice(0, 120) || null : null,
      balance: bal ? (bal.hint === 'dr' || bal.negative ? -bal.paise : bal.paise) : null,
    });
  }
  if (!txns.length) throw new Error('Found the header row but no transactions under it. Check the file is the full statement.');
  // Some banks list newest first; store oldest first so balances read correctly.
  if (txns.length > 1 && txns[0].date > txns[txns.length - 1].date) txns.reverse();
  return txns;
}

// ---------------- Categorising ----------------

/**
 * Order: the team's rules, then money in from a known client or student (their name in the
 * narration), then built-in keywords.
 */
function categorize(txn, rules, payers = []) {
  const dir = txn.credit > 0 ? 'in' : 'out';
  const text = `${txn.description} ${txn.reference || ''}`.toLowerCase();
  for (const r of rules) {
    if ((r.direction === 'any' || r.direction === dir) && text.includes(r.pattern.toLowerCase())) return { category: r.category, by: 'rule' };
  }
  if (dir === 'in') {
    const squashed = text.replace(/\s+/g, ' ');
    const who = payers.find((p) => squashed.includes(p.name));
    if (who) return { category: who.segment === 'student' ? 'student_fees' : 'client_payments', by: 'auto' };
  }
  for (const [re, cat, d] of HINTS) {
    if ((d === 'any' || d === dir) && re.test(text)) return { category: cat, by: 'auto' };
  }
  return { category: 'uncategorized', by: 'auto' };
}

const rulesList = () => db('bank_rules').orderBy('id', 'desc');

/**
 * Client and student names worth matching (long enough not to match by accident). Banks often
 * drop "Pvt Ltd" and the like, so each name is also tried without them.
 */
async function payerNames() {
  const rows = await db('clients').select('name', 'segment');
  const out = [];
  for (const r of rows) {
    const full = String(r.name || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    const short = full.replace(/\b(private|pvt|limited|ltd|llp|inc|opc|co|company|india|and|&)\b/g, ' ').replace(/\s+/g, ' ').trim();
    for (const name of new Set([full, short])) if (name.length >= 6) out.push({ name, segment: r.segment });
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

/**
 * Links money in to payments already recorded in the Hub (same amount, within 4 days), which
 * also tells us whether it was a client or a student. Returns how many were matched.
 */
async function matchPayments(fromDate, toDate) {
  const credits = await db('bank_txns').where('credit', '>', 0).whereNull('payment_id')
    .whereBetween('txn_date', [fromDate, toDate]).whereNot('categorized_by', 'user');
  if (!credits.length) return 0;
  const taken = new Set(await db('bank_txns').whereNotNull('payment_id').pluck('payment_id'));
  const payments = await db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').where('p.status', 'confirmed')
    .whereBetween('p.paid_on', [addDays(fromDate, -4), addDays(toDate, 4)]).select('p.id', 'p.amount', 'p.paid_on', 'p.method', 'i.segment');
  let matched = 0;
  for (const t of credits) {
    const p = payments.find((x) => !taken.has(x.id) && Number(x.amount) === Number(t.credit)
      && Math.abs(new Date(x.paid_on) - new Date(t.txn_date)) <= 4 * 86400000);
    if (!p) continue;
    taken.add(p.id);
    await db('bank_txns').where({ id: t.id }).update({
      payment_id: p.id, category: p.segment === 'student' ? 'student_fees' : 'client_payments', categorized_by: 'match',
    });
    matched += 1;
  }
  return matched;
}

/** Imports a statement. Duplicates (already imported lines) are skipped. */
async function importStatement({ text, account, filename, userId }) {
  const txns = readStatement(text);
  const [rules, payers] = await Promise.all([rulesList(), payerNames()]);
  const seen = {};
  const rows = txns.map((t, i) => {
    const key = [account.toLowerCase(), t.date, t.debit, t.credit, t.balance === null ? '' : t.balance, norm(t.description)].join('|');
    seen[key] = (seen[key] || 0) + 1; // identical lines on the same day stay distinct
    const { category, by } = categorize(t, rules, payers);
    return {
      account, txn_date: t.date, description: t.description, reference: t.reference, counterparty: counterparty(t.description),
      debit: t.debit, credit: t.credit, balance: t.balance, has_balance: t.balance !== null, seq: i,
      category, categorized_by: by, hash: crypto.createHash('sha256').update(`${key}#${seen[key]}`).digest('hex'), created_at: nowSql(),
    };
  });
  const dates = rows.map((r) => r.txn_date).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  const existing = new Set(await db('bank_txns').whereIn('hash', rows.map((r) => r.hash)).pluck('hash'));
  const fresh = rows.filter((r) => !existing.has(r.hash));
  const [importId] = await db('bank_imports').insert({
    account, filename, rows_read: rows.length, rows_added: fresh.length, rows_duplicate: rows.length - fresh.length,
    from_date: from, to_date: to, uploaded_by: userId, created_at: nowSql(),
  });
  for (let i = 0; i < fresh.length; i += 200) {
    await db('bank_txns').insert(fresh.slice(i, i + 200).map((r) => ({ ...r, import_id: importId })));
  }
  const matched = fresh.length ? await matchPayments(from, to) : 0;
  return { importId, read: rows.length, added: fresh.length, duplicates: rows.length - fresh.length, matched, from, to };
}

/** Re-applies rules to lines nobody has categorised by hand. */
async function recategorize() {
  const [rules, payers] = await Promise.all([rulesList(), payerNames()]);
  const txns = await db('bank_txns').whereIn('categorized_by', ['auto', 'rule']).select('id', 'description', 'reference', 'debit', 'credit', 'category');
  let changed = 0;
  for (const t of txns) {
    const { category, by } = categorize({ ...t, debit: Number(t.debit), credit: Number(t.credit) }, rules, payers);
    if (category !== t.category) {
      await db('bank_txns').where({ id: t.id }).update({ category, categorized_by: by });
      changed += 1;
    }
  }
  return changed;
}

// ---------------- Analysis ----------------

const typeOf = (category) => (CAT[category] || CAT.uncategorized).type;

/**
 * The CEO view for a date range: money in and out by category, cost ratios against revenue,
 * monthly trend, balances, burn and runway, plus billing and collections from the Hub.
 */
async function analyse(from, to) {
  const txns = await db('bank_txns').whereBetween('txn_date', [from, to]).orderBy('txn_date').orderBy('import_id').orderBy('seq')
    .select('id', 'account', 'txn_date', 'debit', 'credit', 'balance', 'has_balance', 'category', 'counterparty');
  const byCat = {};
  const months = {};
  const payees = {};
  const payers = {};
  let revenue = 0; let opex = 0; let taxes = 0; let capital = 0; let transfersOut = 0; let transfersIn = 0;
  let uncategorizedIn = 0; let uncategorizedOut = 0; let uncategorizedCount = 0;
  for (const t of txns) {
    const debit = Number(t.debit); const credit = Number(t.credit);
    const type = typeOf(t.category);
    const m = t.txn_date.slice(0, 7);
    months[m] = months[m] || { income: 0, expense: 0 };
    byCat[t.category] = byCat[t.category] || { in: 0, out: 0, n: 0 };
    byCat[t.category].in += credit; byCat[t.category].out += debit; byCat[t.category].n += 1;
    if (t.category === 'uncategorized') {
      uncategorizedCount += 1; uncategorizedIn += credit; uncategorizedOut += debit;
      // Unreviewed money still moved: count it, and flag it, rather than hide it.
      revenue += credit; opex += debit; months[m].income += credit; months[m].expense += debit;
    } else if (type === 'income' || type === 'expense') {
      // A refund on an expense category nets against it, and the reverse.
      const net = type === 'income' ? credit - debit : debit - credit;
      if (type === 'income') { revenue += net; months[m].income += net; } else { opex += net; months[m].expense += net; }
    } else if (type === 'tax') { taxes += debit - credit; months[m].expense += debit - credit; }
    else if (type === 'capital') capital += credit - debit;
    else if (type === 'transfer') { transfersOut += debit; transfersIn += credit; }
    if (debit && t.counterparty && type !== 'transfer') payees[t.counterparty] = (payees[t.counterparty] || 0) + debit;
    if (credit && t.counterparty && type !== 'transfer' && type !== 'capital') payers[t.counterparty] = (payers[t.counterparty] || 0) + credit;
  }

  // Opening and closing balances per account, from the statement's running balance.
  const accounts = {};
  for (const t of txns) {
    if (!t.has_balance) continue;
    const a = accounts[t.account] || (accounts[t.account] = {});
    if (a.opening === undefined) a.opening = Number(t.balance) - Number(t.credit) + Number(t.debit);
    a.closing = Number(t.balance);
  }
  const accountList = Object.entries(accounts).map(([name, a]) => ({ name, ...a }));
  const opening = accountList.reduce((s, a) => s + a.opening, 0);
  const closing = accountList.reduce((s, a) => s + a.closing, 0);

  const monthKeys = Object.keys(months).sort();
  const monthCount = Math.max(1, monthKeys.length);
  const spend = opex + taxes;
  const net = revenue - spend;
  const avgSpend = Math.round(spend / monthCount);
  const avgNet = Math.round(net / monthCount);
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

  const costs = CATEGORIES.filter((c) => c.type === 'expense' || c.type === 'tax' || c.id === 'uncategorized')
    .map((c) => {
      const row = byCat[c.id] || { in: 0, out: 0, n: 0 };
      const amount = c.id === 'uncategorized' ? row.out : row.out - row.in;
      return { ...c, amount, n: row.n, ofSpend: pct(amount, spend), ofRevenue: pct(amount, revenue), monthly: Math.round(amount / monthCount) };
    })
    .filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
  const income = CATEGORIES.filter((c) => c.type === 'income' || c.id === 'uncategorized')
    .map((c) => {
      const row = byCat[c.id] || { in: 0, out: 0 };
      const amount = c.id === 'uncategorized' ? row.in : row.in - row.out;
      return { ...c, label: c.id === 'uncategorized' ? 'Uncategorized money in' : c.label, amount, share: pct(amount, revenue) };
    })
    .filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);

  // Billing and collections from the Hub itself, for the same period.
  const [billedRows, collectedRows, outstandingRows, gstRows] = await Promise.all([
    db('invoices').whereNotIn('status', ['draft', 'void']).whereBetween('issue_date', [from, to]).select('segment').sum({ v: 'total' }).count({ n: '*' }).groupBy('segment'),
    db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').where('p.status', 'confirmed').whereBetween('p.paid_on', [from, to])
      .select('i.segment').sum({ v: 'p.amount', tds: 'p.tds' }).groupBy('i.segment'),
    db('invoices').whereIn('status', ['sent', 'partially_paid', 'overdue']).select('segment').sum({ total: 'total', paid: 'amount_paid' }).groupBy('segment'),
    db('invoices').whereNotIn('status', ['draft', 'void']).whereBetween('issue_date', [from, to]).sum({ c: 'cgst', s: 'sgst', i: 'igst' }).first(),
  ]);
  const seg = (rows, fn) => Object.fromEntries(['business', 'student'].map((sgm) => [sgm, fn(rows.find((r) => r.segment === sgm) || {})]));
  const billed = seg(billedRows, (r) => ({ amount: Number(r.v || 0), n: Number(r.n || 0) }));
  const collected = seg(collectedRows, (r) => Number(r.v || 0) + Number(r.tds || 0));
  const outstanding = seg(outstandingRows, (r) => Number(r.total || 0) - Number(r.paid || 0));
  const billedTotal = billed.business.amount + billed.student.amount;
  const collectedTotal = collected.business + collected.student;

  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, amount]) => ({ name, amount }));
  return {
    from, to, count: txns.length,
    revenue, opex, taxes, spend, net, capital, transfersIn, transfersOut,
    uncategorized: { count: uncategorizedCount, in: uncategorizedIn, out: uncategorizedOut },
    opening: accountList.length ? opening : null, closing: accountList.length ? closing : null, accounts: accountList,
    avgSpend, avgNet,
    runway: closing > 0 && avgNet < 0 ? Math.round((closing / -avgNet) * 10) / 10 : null,
    ratios: { opexToRevenue: pct(opex, revenue), spendToRevenue: pct(spend, revenue), netMargin: revenue > 0 ? Math.round((net / revenue) * 1000) / 10 : null },
    costs, income,
    months: monthKeys.map((k) => ({ key: k, ...months[k] })),
    payees: top(payees), payers: top(payers),
    billing: {
      billed, collected, outstanding, billedTotal, collectedTotal,
      outstandingTotal: outstanding.business + outstanding.student,
      efficiency: pct(collectedTotal, billedTotal),
      gstCharged: Number(gstRows.c || 0) + Number(gstRows.s || 0) + Number(gstRows.i || 0),
      gstPaid: costs.find((c) => c.id === 'gst') ? costs.find((c) => c.id === 'gst').amount : 0,
    },
  };
}

/** First and last dates we have bank data for ("company start to now"). */
async function dataRange() {
  const r = await db('bank_txns').min({ a: 'txn_date' }).max({ b: 'txn_date' }).first();
  return r && r.a ? { from: String(r.a).slice(0, 10), to: String(r.b).slice(0, 10) } : null;
}

module.exports = {
  CATEGORIES, CAT, typeOf, parseCsv, detectColumns, parseBankDate, parseAmount, counterparty, readStatement,
  categorize, importStatement, matchPayments, recategorize, analyse, dataRange,
};
