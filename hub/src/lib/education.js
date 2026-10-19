'use strict';

const { db } = require('../db');
const { getSettings } = require('./settings');
const { createInvoice, issueInvoice, defaultTaxMode, recordPayment, sendInvoiceEmail } = require('./billing');
const { logActivity } = require('./activity');
const { nowSql, todayIST, addDays, addMonths } = require('./util');
const { formatINR } = require('./money');

const PROGRAM_KINDS = [
  ['internship', 'Internship'],
  ['training', 'Training'],
  ['course', 'Course'],
  ['workshop', 'Workshop'],
  ['certification', 'Certification'],
];

/** Splits paise into n parts that add up exactly; the first part takes any remainder. */
function split(total, n) {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? total - base * (n - 1) : base));
}

/**
 * Line rate (before GST) for an amount the student actually pays. Fees are usually quoted
 * inclusive of GST, so ₹5,900 at 18% becomes ₹5,000 + ₹900 GST.
 */
function preTaxRate(amount, { taxMode, gstRate, inclusive }) {
  if (taxMode === 'none' || !inclusive || !gstRate) return amount;
  return Math.round((amount * 100) / (100 + Number(gstRate)));
}

/**
 * Creates a student (a client with segment 'student') with one invoice per instalment, issues
 * them, and records a payment taken on the spot against the first. Returns { clientId, invoiceIds }.
 */
async function enroll(student, plan, userId) {
  const s = await getSettings();
  const now = nowSql();
  const today = todayIST();
  const program = plan.programId ? await db('programs').where({ id: plan.programId }).first() : null;
  const programName = program ? program.name : (plan.description || 'Program fee');
  const result = await db.transaction(async (trx) => {
    const [clientId] = await trx('clients').insert({
      ...student, segment: 'student', program_id: program ? program.id : null, status: 'active', created_at: now, updated_at: now,
    });
    const client = await trx('clients').where({ id: clientId }).first();
    const taxMode = defaultTaxMode(client, s);
    const gstRate = Number(s.edu_gst_rate) || 0;
    const inclusive = program ? Boolean(program.fee_includes_gst) : plan.inclusive !== false;
    const parts = split(plan.fee, plan.installments);
    const firstDue = plan.firstDue || addDays(today, Number(s.edu_due_days) || 7);
    const invoiceIds = [];
    for (let i = 0; i < parts.length; i += 1) {
      const label = parts.length > 1 ? ` (instalment ${i + 1} of ${parts.length})` : '';
      const id = await createInvoice(trx, {
        client_id: clientId,
        title: `${programName}${plan.batch ? ` · ${plan.batch}` : ''}${label}`,
        issue_date: today,
        due_date: i === 0 ? firstDue : addMonths(firstDue, i),
        tax_mode: taxMode,
        gst_rate: gstRate,
        place_of_supply: client.state,
        terms: s.edu_terms,
      }, [{
        description: `${programName}${label}`,
        sac: s.edu_sac,
        quantity: 1,
        rate: preTaxRate(parts[i], { taxMode, gstRate, inclusive }),
      }]);
      await issueInvoice(trx, id);
      invoiceIds.push(id);
    }
    await logActivity('client', clientId, userId, 'system', `Enrolled in ${programName}: ${formatINR(plan.fee)}${parts.length > 1 ? ` in ${parts.length} instalments` : ''}`, trx);
    return { clientId, invoiceIds };
  });

  if (plan.paidNow && plan.paidNow.amount > 0) {
    // Spread what was paid across the instalments in order.
    let left = plan.paidNow.amount;
    for (const invoiceId of result.invoiceIds) {
      if (left <= 0) break;
      const inv = await db('invoices').where({ id: invoiceId }).first();
      const take = Math.min(left, Number(inv.total) - Number(inv.amount_paid));
      if (take <= 0) continue;
      await recordPayment({ ...plan.paidNow, amount: take, invoice_id: invoiceId, recorded_by: userId }, { notify: Boolean(student.email) });
      left -= take;
    }
  }
  if (plan.sendEmail && student.email) await sendInvoiceEmail(result.invoiceIds[0], userId);
  return result;
}

/** Per-student billed / paid / due for issued invoices. */
async function balances(clientIds) {
  if (!clientIds.length) return {};
  const rows = await db('invoices').whereIn('client_id', clientIds).whereNotIn('status', ['draft', 'void'])
    .select('client_id').sum({ billed: 'total', paid: 'amount_paid' })
    .select(db.raw("sum(case when status = 'overdue' then 1 else 0 end) as overdue"))
    .select(db.raw("min(case when status in ('sent','partially_paid','overdue') then due_date end) as next_due"))
    .groupBy('client_id');
  return Object.fromEntries(rows.map((r) => [r.client_id, {
    billed: Number(r.billed || 0), paid: Number(r.paid || 0), due: Number(r.billed || 0) - Number(r.paid || 0),
    overdue: Number(r.overdue || 0) > 0, nextDue: r.next_due ? String(r.next_due).slice(0, 10) : null,
  }]));
}

module.exports = { PROGRAM_KINDS, split, preTaxRate, enroll, balances };
