'use strict';

const { db } = require('../db');
const { randomToken } = require('./util');

// Defaults come from haptags.com; everything is editable under Settings.
const DEFAULTS = {
  company_name: 'Haptags',
  legal_name: 'Haptags LLP',
  tagline: 'Build. Automate. Scale.',
  address: 'Near Maheshwarramma Temple Road, Mahadevapura',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560048',
  gstin: '',
  pan: '',
  llpin: 'ACS-0435',
  udyam: 'UDYAM-KR-03-0633150',
  email: 'info@haptags.com',
  phone: '+91 99868 61402',
  website: 'https://www.haptags.com',
  whatsapp: '919986861402',

  invoice_prefix: 'HT',
  quote_prefix: 'HTQ',
  default_due_days: '7',
  quote_valid_days: '15',
  default_gst_rate: '18',
  default_sac: '998314',
  invoice_terms: 'Payment due by the date shown. Please quote the invoice number with your payment.\nTDS, if deducted, should be reported with the challan details.',
  quote_terms: '50% advance to start, balance on delivery.\nPrices are valid until the date shown.\nHosting, domains and third-party licences are billed at actuals unless listed.',

  upi_id: '',
  upi_name: 'Haptags LLP',
  bank_name: '',
  bank_account_name: 'Haptags LLP',
  bank_account_number: '',
  bank_ifsc: '',
  bank_branch: '',

  auto_reminders: '1',
  lead_auto_reply: '1',
  lead_api_key: '',
  automation_last_run: '',
};

// The cache is loaded at startup and reloaded after every write, so getSettings() never has to
// query inside someone else's transaction (SQLite has a single pooled connection).
let cache = null;

async function load() {
  const rows = await db('settings').select('key', 'value');
  cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache;
}

async function getSettings() {
  if (cache) return cache;
  await load();
  if (!cache.lead_api_key) await setSettings({ lead_api_key: `hl_${randomToken(20)}` });
  return cache;
}

async function setSettings(values) {
  const entries = Object.entries(values).filter(([k]) => k in DEFAULTS);
  await db.transaction(async (trx) => {
    for (const [key, value] of entries) {
      const v = value === null || value === undefined ? '' : String(value);
      const existing = await trx('settings').where({ key }).first();
      if (existing) await trx('settings').where({ key }).update({ value: v });
      else await trx('settings').insert({ key, value: v });
    }
  });
  await load();
}

module.exports = { getSettings, setSettings, DEFAULTS };
