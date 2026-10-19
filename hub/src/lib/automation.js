'use strict';

const config = require('../config');
const { db } = require('../db');
const { getSettings, setSettings } = require('./settings');
const { todayIST, addDays, addMonths, nowSql, daysBetween } = require('./util');
const { refreshInvoice, invoiceFromRetainer, sendInvoiceEmail } = require('./billing');
const { logActivity } = require('./activity');
const { RETAINER_INTERVALS } = require('./constants');

// Reminder stages, in days relative to the due date.
const REMINDER_OFFSETS = [-3, 0, 3, 7, 14, 30];
const MAX_CATCH_UP = 12;

let running = false;

function intervalMonths(interval) {
  const row = RETAINER_INTERVALS.find((r) => r[0] === interval);
  return row ? row[2] : 1;
}

async function markOverdue(today) {
  const rows = await db('invoices').whereIn('status', ['sent', 'partially_paid']).where('due_date', '<', today).select('id');
  for (const r of rows) await db.transaction((trx) => refreshInvoice(trx, r.id));
  return rows.length;
}

async function expireQuotes(today) {
  return db('quotes').where({ status: 'sent' }).whereNotNull('valid_until').where('valid_until', '<', today)
    .update({ status: 'expired', updated_at: nowSql() });
}

async function billRetainers(today) {
  let created = 0;
  const due = await db('retainers').where({ status: 'active' }).where('next_invoice_date', '<=', today);
  for (const r of due) {
    let next = r.next_invoice_date;
    for (let i = 0; i < MAX_CATCH_UP && next <= today && (!r.end_date || next <= r.end_date); i += 1) {
      const issueDate = next;
      const invoiceId = await db.transaction(async (trx) => {
        const id = await invoiceFromRetainer(trx, r, issueDate);
        next = addMonths(issueDate, intervalMonths(r.interval));
        await trx('retainers').where({ id: r.id }).update({ next_invoice_date: next, last_invoiced_at: nowSql(), updated_at: nowSql() });
        await logActivity('retainer', r.id, null, 'system', `Invoice generated for ${issueDate}`, trx);
        return id;
      });
      created += 1;
      if (r.auto_send) await sendInvoiceEmail(invoiceId, null);
    }
    if (r.end_date && next > r.end_date) {
      await db('retainers').where({ id: r.id }).update({ status: 'ended', updated_at: nowSql() });
    }
  }
  return created;
}

async function sendReminders(today) {
  let sent = 0;
  const invoices = await db('invoices as i')
    .join('clients as c', 'c.id', 'i.client_id')
    .whereIn('i.status', ['sent', 'partially_paid', 'overdue'])
    .whereNotNull('i.number')
    .whereRaw('i.total > i.amount_paid')
    .select('i.*', 'c.email as client_email');
  for (const inv of invoices) {
    const daysFromDue = daysBetween(inv.due_date, today);
    const stage = REMINDER_OFFSETS.filter((o) => daysFromDue >= o).length;
    if (stage <= inv.reminder_stage) continue;
    // Don't nag a client we emailed in the last 48 hours; just move the stage forward.
    const lastContact = [inv.sent_at, inv.last_reminder_at].filter(Boolean).sort().pop();
    const recent = lastContact && lastContact > addDays(today, -2);
    if (!recent && inv.client_email) {
      await sendInvoiceEmail(inv.id, null, { reminder: true });
      sent += 1;
    }
    await db('invoices').where({ id: inv.id }).update({ reminder_stage: stage });
  }
  return sent;
}

/** New certificates from lms.haptags.com. A network problem is logged and retried next hour. */
async function syncCertificates() {
  if (!config.lms.apiUrl) return 0;
  try {
    return (await require('./certificates').syncFromLms()).added;
  } catch (err) {
    console.error('[automation] LMS certificate sync:', err.message);
    return 0;
  }
}

/** Idempotent: safe to run every hour and on demand. */
async function runAutomations() {
  if (running) return { skipped: true };
  running = true;
  try {
    const s = await getSettings();
    const today = todayIST();
    const result = {
      overdue: await markOverdue(today),
      quotesExpired: await expireQuotes(today),
      retainerInvoices: await billRetainers(today),
      reminders: s.auto_reminders === '1' ? await sendReminders(today) : 0,
      lmsCertificates: await syncCertificates(),
      holidays: await require('./holidays').syncIfStale(),
    };
    await setSettings({ automation_last_run: nowSql() });
    return result;
  } finally {
    running = false;
  }
}

/** Hosted Node processes can sleep; staff page views catch up if the hourly run was missed. */
async function runIfStale() {
  const s = await getSettings();
  const last = s.automation_last_run ? new Date(`${s.automation_last_run.replace(' ', 'T')}Z`).getTime() : 0;
  if (Date.now() - last > 60 * 60 * 1000) runAutomations().catch((err) => console.error('[automation]', err));
}

function startScheduler() {
  const tick = () => runAutomations().catch((err) => console.error('[automation]', err));
  setTimeout(tick, 15 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { runAutomations, runIfStale, startScheduler, intervalMonths, REMINDER_OFFSETS };
