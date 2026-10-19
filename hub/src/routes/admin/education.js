'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/constants');
const E = require('../../lib/education');
const { getSettings } = require('../../lib/settings');
const { columnChart } = require('../../lib/charts');
const { toPaise } = require('../../lib/money');
const {
  invoiceUrl, createInvoice, issueInvoice, defaultTaxMode, sendInvoiceEmail, cleanNumber, numberTaken, previewNumber, deleteInvoices,
} = require('../../lib/billing');
const { requireAdmin } = require('../../lib/auth');
const { getActivities, logActivity } = require('../../lib/activity');
const { periodFrom, monthsBetween, monthLabel, PRESETS } = require('../../lib/period');
const { nowSql, todayIST, addDays, addMonths, str, int, isEmail, isDate } = require('../../lib/util');
const { paginate, idParam } = require('./_helpers');

const router = express.Router();

const programs = (all = false) => db('programs').modify((q) => { if (!all) q.where({ is_active: true }); }).orderBy('name');

// ---------------- Overview ----------------
router.get('/', async (req, res) => {
  const firstInvoice = await db('invoices').where({ segment: 'student' }).min({ d: 'issue_date' }).first();
  const period = periodFrom(req.query, { earliest: firstInvoice && firstInvoice.d ? String(firstInvoice.d).slice(0, 10) : null });
  const { from, to } = period;
  const yearStart = addMonths(`${todayIST().slice(0, 7)}-01`, -11);
  const studentInvoices = () => db('invoices as i').join('clients as c', 'c.id', 'i.client_id').where('i.segment', 'student');

  const [billed, collected, outstanding, enrolled, byProgram, byCollege, monthly, overdue, recent, allTimeStudents] = await Promise.all([
    db('invoices').where({ segment: 'student' }).whereNotIn('status', ['draft', 'void']).whereBetween('issue_date', [from, to]).sum({ v: 'total' }).first(),
    db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').where({ 'i.segment': 'student', 'p.status': 'confirmed' })
      .whereBetween('p.paid_on', [from, to]).sum({ v: 'p.amount' }).count({ n: '*' }).first(),
    db('invoices').where({ segment: 'student' }).whereIn('status', ['sent', 'partially_paid', 'overdue']).sum({ t: 'total', p: 'amount_paid' }).first(),
    db('clients').where({ segment: 'student' }).whereBetween('created_at', [`${from} 00:00:00`, `${to} 23:59:59`]).count({ n: '*' }).first(),
    studentInvoices().leftJoin('programs as pg', 'pg.id', 'c.program_id').whereNotIn('i.status', ['draft', 'void']).whereBetween('i.issue_date', [from, to])
      .select('pg.id', 'pg.name').countDistinct({ students: 'c.id' }).sum({ billed: 'i.total', paid: 'i.amount_paid' }).groupBy('pg.id', 'pg.name'),
    studentInvoices().whereNotIn('i.status', ['draft', 'void']).whereBetween('i.issue_date', [from, to]).whereNotNull('c.college')
      .select('c.college').countDistinct({ students: 'c.id' }).sum({ billed: 'i.total' }).groupBy('c.college').orderBy('billed', 'desc').limit(8),
    db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').where({ 'i.segment': 'student', 'p.status': 'confirmed' })
      .where('p.paid_on', '>=', yearStart).select('p.paid_on', 'p.amount'),
    studentInvoices().where('i.status', 'overdue').orderBy('i.due_date').limit(8)
      .select('i.id', 'i.number', 'i.title', 'i.due_date', 'i.total', 'i.amount_paid', 'i.public_token', 'c.id as student_id', 'c.name', 'c.phone'),
    db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').join('clients as c', 'c.id', 'p.client_id')
      .where({ 'i.segment': 'student', 'p.status': 'confirmed' }).orderBy('p.paid_on', 'desc').orderBy('p.id', 'desc').limit(8)
      .select('p.amount', 'p.method', 'p.paid_on', 'c.id as student_id', 'c.name', 'i.title'),
    db('clients').where({ segment: 'student' }).count({ n: '*' }).first(),
  ]);

  const byMonth = {};
  for (const p of monthly) byMonth[String(p.paid_on).slice(0, 7)] = (byMonth[String(p.paid_on).slice(0, 7)] || 0) + Number(p.amount);
  const series = monthsBetween(yearStart, todayIST()).map((m) => ({ key: m, label: monthLabel(m), tip: monthLabel(m, true), value: byMonth[m] || 0 }));
  const billedV = Number(billed.v || 0);
  const collectedV = Number(collected.v || 0);
  const students = Number(enrolled.n || 0);

  res.render('admin/education/index', {
    title: 'Education', tab: 'overview', period, presets: PRESETS,
    kpi: {
      billed: billedV, collected: collectedV, payments: Number(collected.n || 0),
      outstanding: Number(outstanding.t || 0) - Number(outstanding.p || 0),
      enrolled: students, total: Number(allTimeStudents.n || 0),
      perStudent: students ? Math.round(billedV / students) : 0,
      collectionRate: billedV ? Math.round((collectedV / billedV) * 100) : null,
    },
    byProgram: byProgram.map((r) => ({ ...r, billed: Number(r.billed || 0), paid: Number(r.paid || 0), students: Number(r.students || 0) }))
      .sort((a, b) => b.billed - a.billed),
    byCollege: byCollege.map((r) => ({ ...r, billed: Number(r.billed || 0), students: Number(r.students || 0) })),
    chart: columnChart(series, { label: 'Student fees collected per month, last 12 months' }),
    series, overdue, recent,
  });
});

// ---------------- Students ----------------
router.get('/students', async (req, res) => {
  const q = str(req.query.q, 100);
  const programId = int(req.query.program, 0);
  const batch = str(req.query.batch, 60);
  const status = ['due', 'overdue', 'paid'].includes(req.query.status) ? req.query.status : '';
  const query = db('clients as c').leftJoin('programs as p', 'p.id', 'c.program_id').where('c.segment', 'student')
    .select('c.*', 'p.name as program_name').orderBy('c.created_at', 'desc').orderBy('c.id', 'desc');
  if (q) query.where((w) => w.where('c.name', 'like', `%${q}%`).orWhere('c.phone', 'like', `%${q}%`).orWhere('c.email', 'like', `%${q}%`).orWhere('c.college', 'like', `%${q}%`));
  if (programId) query.where('c.program_id', programId);
  if (batch) query.where('c.batch', batch);
  const open = (w) => w.select(db.raw(1)).from('invoices as i').whereRaw('i.client_id = c.id');
  if (status === 'overdue') query.whereExists(open(db.queryBuilder()).where('i.status', 'overdue'));
  if (status === 'due') query.whereExists(open(db.queryBuilder()).whereIn('i.status', ['sent', 'partially_paid', 'overdue']));
  if (status === 'paid') query.whereNotExists(open(db.queryBuilder()).whereIn('i.status', ['sent', 'partially_paid', 'overdue']));
  const page = await paginate(query, req, 50);
  const [bal, batches] = await Promise.all([
    E.balances(page.rows.map((r) => r.id)),
    db('clients').where({ segment: 'student' }).whereNotNull('batch').distinct('batch').orderBy('batch', 'desc').pluck('batch'),
  ]);
  res.render('admin/education/students', {
    title: 'Students', tab: 'students', ...page, bal, q, programId, batch, status, batches, programs: await programs(true),
  });
});

router.get('/students.csv', async (req, res) => {
  const rows = await db('clients as c').leftJoin('programs as p', 'p.id', 'c.program_id').where('c.segment', 'student').orderBy('c.id')
    .select('c.id', 'c.name', 'c.phone', 'c.email', 'c.college', 'c.course', 'p.name as program', 'c.batch', 'c.start_date', 'c.created_at');
  const bal = await E.balances(rows.map((r) => r.id));
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Student', 'Phone', 'Email', 'College', 'Course', 'Program', 'Batch', 'Start date', 'Billed (₹)', 'Paid (₹)', 'Due (₹)'].map(cell).join(',')];
  for (const r of rows) {
    const b = bal[r.id] || { billed: 0, paid: 0, due: 0 };
    lines.push([r.name, r.phone, r.email, r.college, r.course, r.program, r.batch, r.start_date, b.billed / 100, b.paid / 100, b.due / 100].map(cell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="students-${todayIST()}.csv"` });
  res.send(`﻿${lines.join('\r\n')}`);
});

function readStudent(body, s) {
  const student = {
    name: str(body.name, 190),
    phone: str(body.phone, 40),
    email: (str(body.email, 190) || '').toLowerCase() || null,
    college: str(body.college, 190),
    course: str(body.course, 120),
    batch: str(body.batch, 60),
    start_date: isDate(body.start_date) ? body.start_date : null,
    city: str(body.city, 100),
    state: str(body.state, 100) || s.state,
    country: 'India',
    notes: str(body.notes, 5000),
  };
  const errors = {};
  if (!student.name) errors.name = 'Enter the student’s name.';
  if (!student.phone && !student.email) errors.phone = 'Add a phone number or email so you can send the invoice.';
  if (student.email && !isEmail(student.email)) errors.email = 'Enter a valid email.';
  return { student, errors };
}

async function formLocals(extra) {
  const s = await getSettings();
  return {
    programs: await programs(), methods: C.PAYMENT_METHODS, states: C.STATES, settings: s,
    nextNumber: await previewNumber(s.edu_invoice_prefix, todayIST()), ...extra,
  };
}

/** Optional typed-in invoice number: { number } or { error }. */
async function readNumber(value) {
  if (!String(value || '').trim()) return { number: null };
  const number = cleanNumber(value);
  if (!number) return { error: 'Use letters, numbers and / - _ . only, e.g. HTE/25-26/0040.' };
  if (await numberTaken(number)) return { error: `${number} is already used by another invoice.` };
  return { number };
}

router.get('/students/new', async (req, res) => {
  const s = await getSettings();
  const program = await db('programs').where({ id: int(req.query.program, 0) }).first();
  res.render('admin/education/student-form', {
    title: 'New student', tab: 'students',
    ...(await formLocals({
      form: { state: s.state, program_id: program ? program.id : '', fee: program ? Number(program.fee) / 100 : '', installments: 1, start_date: todayIST(), first_due: addDays(todayIST(), Number(s.edu_due_days) || 7), method: 'upi', send_email: '1' },
      errors: {},
    })),
  });
});

router.post('/students', async (req, res) => {
  const s = await getSettings();
  const { student, errors } = readStudent(req.body, s);
  const fee = toPaise(req.body.fee);
  const discount = Math.min(fee, toPaise(req.body.discount));
  const installments = Math.min(12, Math.max(1, int(req.body.installments, 1)));
  const paidNow = toPaise(req.body.paid_now);
  if (fee <= 0) errors.fee = 'Enter the fee.';
  const num = await readNumber(req.body.number);
  if (num.error) errors.number = num.error;
  if (paidNow > fee - discount) errors.paid_now = 'That’s more than the fee.';
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/education/student-form', { title: 'New student', tab: 'students', ...(await formLocals({ form: req.body, errors })) });
  }
  const { clientId } = await E.enroll(student, {
    programId: int(req.body.program_id, 0) || null,
    description: str(req.body.description, 200),
    batch: student.batch,
    fee: fee - discount,
    installments,
    number: num.number,
    issueDate: isDate(req.body.issue_date) ? req.body.issue_date : null,
    firstDue: isDate(req.body.first_due) ? req.body.first_due : null,
    paidNow: paidNow > 0 ? {
      amount: paidNow,
      method: C.PAYMENT_METHODS.some((m) => m[0] === req.body.method) ? req.body.method : 'upi',
      reference: str(req.body.reference, 190),
      paid_on: isDate(req.body.paid_on) ? req.body.paid_on : todayIST(),
      notes: discount ? `Discount/scholarship given: ₹${discount / 100}` : null,
    } : null,
    sendEmail: Boolean(req.body.send_email),
  }, req.user.id);
  req.flash('success', `${student.name} enrolled.${paidNow ? ' Payment recorded.' : ''}`);
  res.redirect(`/admin/education/students/${clientId}`);
});

async function loadStudent(req, res, next) {
  const st = await db('clients as c').leftJoin('programs as p', 'p.id', 'c.program_id').where({ 'c.id': idParam(req), 'c.segment': 'student' })
    .select('c.*', 'p.name as program_name', 'p.kind as program_kind').first();
  if (!st) return next('route');
  req.student = st;
  next();
}

router.get('/students/:id', loadStudent, async (req, res) => {
  const st = req.student;
  const [invoices, payments, activities] = await Promise.all([
    db('invoices').where({ client_id: st.id }).orderBy('due_date').orderBy('id'),
    db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').where('p.client_id', st.id).orderBy('p.paid_on', 'desc')
      .select('p.*', 'i.number as invoice_number'),
    getActivities('client', st.id),
  ]);
  const live = invoices.filter((i) => !['draft', 'void'].includes(i.status));
  const totals = live.reduce((t, i) => ({ billed: t.billed + Number(i.total), paid: t.paid + Number(i.amount_paid) }), { billed: 0, paid: 0 });
  const next = live.find((i) => Number(i.total) > Number(i.amount_paid));
  res.render('admin/education/student', {
    title: st.name, tab: 'students', st, invoices: invoices.map((i) => ({ ...i, link: invoiceUrl(i) })), payments, activities,
    totals: { ...totals, due: totals.billed - totals.paid }, next: next ? { ...next, link: invoiceUrl(next) } : null,
    settings: await getSettings(), programs: await programs(),
    nextNumber: await previewNumber((await getSettings()).edu_invoice_prefix, todayIST()),
  });
});

router.get('/students/:id/edit', loadStudent, async (req, res) => {
  res.render('admin/education/student-edit', {
    title: `Edit ${req.student.name}`, tab: 'students', form: req.student, errors: {}, programs: await programs(true), states: C.STATES,
  });
});

router.post('/students/:id', loadStudent, async (req, res) => {
  const s = await getSettings();
  const { student, errors } = readStudent(req.body, s);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/education/student-edit', {
      title: `Edit ${req.student.name}`, tab: 'students', form: { ...req.body, id: req.student.id }, errors, programs: await programs(true), states: C.STATES,
    });
  }
  await db('clients').where({ id: req.student.id }).update({
    ...student, program_id: int(req.body.program_id, 0) || null, status: req.body.status === 'inactive' ? 'inactive' : 'active', updated_at: nowSql(),
  });
  req.flash('success', 'Student updated.');
  res.redirect(`/admin/education/students/${req.student.id}`);
});

// Another fee for an existing student (next module, certificate, extension…).
// Remove a student entirely (e.g. a duplicate created by mistake), with their invoices and payments.
router.post('/students/:id/delete', requireAdmin, loadStudent, async (req, res) => {
  const st = req.student;
  const r = await db.transaction(async (trx) => {
    const result = await deleteInvoices(trx, await trx('invoices').where({ client_id: st.id }).pluck('id'));
    await trx('activities').where({ entity_type: 'client', entity_id: st.id }).del();
    await trx('clients').where({ id: st.id }).del();
    return result;
  });
  console.log(`[education] ${req.user.email} deleted student #${st.id} ${st.name} (${r.invoices} invoices, ${r.payments} payments)`);
  req.flash('success', `${st.name} deleted${r.invoices ? `, with ${r.invoices} invoice${r.invoices === 1 ? '' : 's'}` : ''}.`);
  res.redirect('/admin/education/students');
});

router.post('/students/:id/invoice', loadStudent, async (req, res) => {
  const st = req.student;
  const s = await getSettings();
  const amount = toPaise(req.body.amount);
  const description = str(req.body.description, 200);
  if (amount <= 0 || !description) {
    req.flash('error', 'Add a description and an amount.');
    return res.redirect(`/admin/education/students/${st.id}`);
  }
  const num = await readNumber(req.body.number);
  if (num.error) {
    req.flash('error', num.error);
    return res.redirect(`/admin/education/students/${st.id}`);
  }
  const taxMode = defaultTaxMode(st, s);
  const id = await db.transaction(async (trx) => {
    const iid = await createInvoice(trx, {
      client_id: st.id, number: num.number, title: description, issue_date: isDate(req.body.issue_date) ? req.body.issue_date : todayIST(),
      due_date: isDate(req.body.due_date) ? req.body.due_date : addDays(todayIST(), Number(s.edu_due_days) || 7),
      tax_mode: taxMode, gst_rate: Number(s.edu_gst_rate) || 0, place_of_supply: st.state, terms: s.edu_terms,
    }, [{ description, sac: s.edu_sac, quantity: 1, rate: E.preTaxRate(amount, { taxMode, gstRate: Number(s.edu_gst_rate), inclusive: true }) }]);
    await issueInvoice(trx, iid);
    await logActivity('client', st.id, req.user.id, 'system', `Invoiced: ${description}`, trx);
    return iid;
  });
  if (req.body.send_email && st.email) await sendInvoiceEmail(id, req.user.id);
  req.flash('success', 'Invoice created.');
  res.redirect(`/admin/education/students/${st.id}`);
});

// ---------------- Programs ----------------
router.get('/programs', async (req, res) => {
  const rows = await programs(true);
  const stats = await db('clients as c').leftJoin('invoices as i', function join() { this.on('i.client_id', 'c.id').andOnVal('i.status', '<>', 'void'); })
    .where('c.segment', 'student').whereNotNull('c.program_id')
    .select('c.program_id').countDistinct({ students: 'c.id' }).sum({ billed: 'i.total', paid: 'i.amount_paid' }).groupBy('c.program_id');
  const byId = Object.fromEntries(stats.map((r) => [r.program_id, { students: Number(r.students), billed: Number(r.billed || 0), paid: Number(r.paid || 0) }]));
  const edit = await db('programs').where({ id: int(req.query.edit, 0) }).first();
  res.render('admin/education/programs', { title: 'Programs', tab: 'programs', rows, byId, kinds: E.PROGRAM_KINDS, edit, settings: await getSettings() });
});

function readProgram(body) {
  return {
    name: str(body.name, 190),
    kind: E.PROGRAM_KINDS.some((k) => k[0] === body.kind) ? body.kind : 'internship',
    fee: toPaise(body.fee),
    fee_includes_gst: Boolean(body.fee_includes_gst),
    duration: str(body.duration, 60),
    description: str(body.description, 2000),
  };
}

router.post('/programs', async (req, res) => {
  const p = readProgram(req.body);
  if (!p.name) {
    req.flash('error', 'Give the program a name.');
    return res.redirect('/admin/education/programs');
  }
  await db('programs').insert({ ...p, is_active: true, created_at: nowSql(), updated_at: nowSql() });
  req.flash('success', `${p.name} added.`);
  res.redirect('/admin/education/programs');
});

router.post('/programs/:id', async (req, res, next) => {
  const prog = await db('programs').where({ id: idParam(req) }).first();
  if (!prog) return next();
  if (req.body.toggle) await db('programs').where({ id: prog.id }).update({ is_active: !prog.is_active, updated_at: nowSql() });
  else {
    const p = readProgram(req.body);
    if (p.name) await db('programs').where({ id: prog.id }).update({ ...p, updated_at: nowSql() });
  }
  req.flash('success', 'Program saved.');
  res.redirect('/admin/education/programs');
});

module.exports = router;
