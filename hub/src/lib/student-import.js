'use strict';

// Bulk import of students and interns from a CSV (e.g. the batches that joined before the Hub).
// Each row: the student, their course and dates, the fee and any payment, an optional invoice
// number, and an optional LMS certificate number. Re-importing the same file doesn't duplicate
// students or invoices.

const { db } = require('../db');
const { parseCsv, parseBankDate, parseAmount } = require('./finance');
const { enroll } = require('./education');
const { cleanNumber, numberTaken } = require('./billing');
const { importFromLms } = require('./certificates');
const { PAYMENT_METHODS } = require('./constants');
const { nowSql, todayIST, isEmail } = require('./util');

const COLUMNS = [
  ['name', 'Name', ['name', 'studentname', 'fullname', 'candidatename']],
  ['phone', 'Phone', ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'whatsapp', 'contact']],
  ['email', 'Email', ['email', 'emailid', 'mail', 'emailaddress']],
  ['college', 'College', ['college', 'collegename', 'institution', 'university', 'collegeorganization']],
  ['course', 'Course / year', ['course', 'courseyear', 'degree', 'branch', 'year', 'department']],
  ['program', 'Program', ['program', 'programme', 'internship', 'internshipprogram', 'programtitle', 'programmetitle', 'track', 'domain']],
  ['batch', 'Batch', ['batch', 'cohort']],
  ['start_date', 'Start date', ['startdate', 'start', 'from', 'joiningdate', 'joinedon']],
  ['end_date', 'End date', ['enddate', 'end', 'to', 'completiondate', 'completedon']],
  ['fee', 'Fee', ['fee', 'fees', 'totalfee', 'coursefee', 'amount']],
  ['discount', 'Discount', ['discount', 'scholarship']],
  ['paid', 'Paid', ['paid', 'amountpaid', 'paidamount', 'received', 'amountreceived']],
  ['paid_on', 'Paid on', ['paidon', 'paymentdate', 'receivedon', 'dateofpayment', 'paiddate']],
  ['method', 'Method', ['method', 'paymentmethod', 'mode', 'paymentmode']],
  ['reference', 'Reference', ['reference', 'utr', 'transactionid', 'ref', 'upiref', 'txnid']],
  ['invoice_number', 'Invoice number', ['invoicenumber', 'invoiceno', 'invoice']],
  ['invoice_date', 'Invoice date', ['invoicedate']],
  ['certificate_id', 'Certificate ID', ['certificateid', 'certificateno', 'certificatenumber', 'certificate', 'certid']],
  ['state', 'State', ['state']],
];

const TEMPLATE = `${COLUMNS.map((c) => c[1]).join(',')}\r\n`
  + 'Example Student,9800000000,student@example.com,Example College of Engineering,B.E. CSE 3rd year,Full Stack Java Internship,Aug 2026,17/08/2026,17/10/2026,999,,999,17/08/2026,UPI,UPI0000000000,,17/08/2026,,Karnataka\r\n';

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const date = (v) => (String(v || '').trim() ? parseBankDate(v) : null);
const money = (v) => parseAmount(v).paise;

function method(v) {
  const k = key(v);
  if (!k) return 'upi';
  if (/upi|gpay|phonepe|paytm/.test(k)) return 'upi';
  if (/razor/.test(k)) return 'razorpay';
  if (/cash/.test(k)) return 'cash';
  if (/cheque|check/.test(k)) return 'cheque';
  if (/bank|neft|imps|rtgs|transfer/.test(k)) return 'bank_transfer';
  return PAYMENT_METHODS.some((m) => m[0] === k) ? k : 'other';
}

/** Reads the CSV into objects keyed by our column names. Throws if there's no Name column. */
function readRows(text) {
  const rows = parseCsv(text);
  const headIndex = rows.findIndex((r) => r.some((c) => ['name', 'studentname', 'fullname', 'candidatename'].includes(key(c))));
  if (headIndex === -1) throw new Error('Couldn’t find the header row. The first row should have column names, including “Name”.');
  const head = rows[headIndex].map(key);
  const map = {};
  for (const [field, , aliases] of COLUMNS) {
    const i = head.findIndex((h) => aliases.includes(h));
    if (i !== -1) map[field] = i;
  }
  return rows.slice(headIndex + 1).map((r, n) => {
    const o = { line: headIndex + n + 2 };
    for (const [field, i] of Object.entries(map)) o[field] = (r[i] || '').trim();
    return o;
  }).filter((o) => o.name);
}

async function findStudent(r) {
  const all = await db('clients').where({ segment: 'student' }).select('id', 'name', 'email', 'phone');
  return all.find((c) => r.email && c.email && c.email.toLowerCase() === r.email.toLowerCase())
    || all.find((c) => digits(r.phone).length === 10 && digits(c.phone) === digits(r.phone))
    || all.find((c) => norm(c.name) === norm(r.name)) || null;
}

async function programFor(name, fee) {
  if (!name) return null;
  const found = (await db('programs').select('id', 'name')).find((p) => norm(p.name) === norm(name));
  if (found) return found.id;
  const [id] = await db('programs').insert({
    name: name.slice(0, 190), kind: /intern/i.test(name) ? 'internship' : 'course', fee: fee || 0, fee_includes_gst: true, is_active: true,
    created_at: nowSql(), updated_at: nowSql(),
  });
  return id;
}

/**
 * Imports the rows. Returns one report line per row:
 * { line, name, studentId, status: 'created'|'updated'|'error', notes: [] }.
 */
async function importStudents(text, { userId, state }) {
  const rows = readRows(text);
  if (!rows.length) throw new Error('The file has a header row but no students under it.');
  const report = [];
  for (const r of rows) {
    const notes = [];
    const out = { line: r.line, name: r.name, notes };
    try {
      if (r.email && !isEmail(r.email)) { notes.push(`email “${r.email}” ignored (not valid)`); r.email = ''; }
      const fee = money(r.fee);
      const discount = Math.min(fee, money(r.discount));
      const paid = money(r.paid);
      const start = date(r.start_date);
      const end = date(r.end_date);
      const invoiceDate = date(r.invoice_date) || start || todayIST();
      const programId = await programFor(r.program, fee);
      const existing = await findStudent(r);
      const fields = {
        name: r.name.slice(0, 190), phone: r.phone || null, email: r.email ? r.email.toLowerCase() : null, college: r.college || null,
        course: r.course || null, batch: r.batch || null, start_date: start, end_date: end, state: r.state || state, country: 'India',
      };
      // Keep what's already on file when the CSV leaves a column blank.
      if (existing) for (const k of Object.keys(fields)) if (fields[k] === null || fields[k] === '') delete fields[k];

      const invoiced = existing ? await db('invoices').where({ client_id: existing.id }).whereNot('status', 'void').first() : null;
      let studentId = existing ? existing.id : null;
      if (fee > 0 && !invoiced) {
        let number = null;
        if (r.invoice_number) {
          number = cleanNumber(r.invoice_number);
          if (!number) notes.push(`invoice number “${r.invoice_number}” isn’t valid, so the next automatic number was used`);
          else if (await numberTaken(number)) { notes.push(`invoice number ${number} is already used, so the next automatic number was used`); number = null; }
        }
        const res = await enroll(fields, {
          clientId: studentId, programId, description: r.program || 'Program fee', batch: r.batch, fee: fee - discount, installments: 1,
          number, issueDate: invoiceDate, firstDue: invoiceDate, notify: false,
          paidNow: paid > 0 ? {
            amount: Math.min(paid, fee - discount), method: method(r.method), reference: r.reference || null,
            paid_on: date(r.paid_on) || invoiceDate, notes: discount ? `Discount given: ₹${discount / 100}` : null,
          } : null,
        }, userId);
        studentId = res.clientId;
        const inv = await db('invoices').where({ id: res.invoiceIds[0] }).first();
        notes.push(`invoice ${inv.number} for ₹${(Number(inv.total) / 100).toLocaleString('en-IN')}${paid ? `, ₹${(Math.min(paid, fee - discount) / 100).toLocaleString('en-IN')} paid` : ''}`);
        if (paid > fee - discount) notes.push('paid more than the fee; the extra wasn’t recorded');
      } else if (studentId) {
        await db('clients').where({ id: studentId }).update({ ...fields, ...(programId ? { program_id: programId } : {}), updated_at: nowSql() });
        if (invoiced && fee > 0) notes.push('already invoiced, so no new invoice');
      } else {
        [studentId] = await db('clients').insert({ ...fields, segment: 'student', program_id: programId, status: 'active', created_at: nowSql(), updated_at: nowSql() });
        if (!fee) notes.push('no fee given, so no invoice');
      }
      out.studentId = studentId;
      out.status = existing ? 'updated' : 'created';

      if (r.certificate_id) {
        try {
          await importFromLms(r.certificate_id.trim(), { clientId: studentId, userId });
          notes.push(`certificate ${r.certificate_id} attached`);
        } catch (err) {
          notes.push(`certificate ${r.certificate_id}: ${err.message}`);
        }
      }
    } catch (err) {
      out.status = 'error';
      notes.push(err.message);
    }
    report.push(out);
  }
  return report;
}

module.exports = { COLUMNS, TEMPLATE, readRows, importStudents };
