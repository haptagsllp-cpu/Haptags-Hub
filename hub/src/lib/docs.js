'use strict';

const QRCode = require('qrcode');
const { db } = require('../db');
const { getItems } = require('./billing');
const { getSettings } = require('./settings');
const { toRupees } = require('./money');

/** UPI intent link + QR so clients can pay from any UPI app with zero gateway fees. */
async function upiFor(invoice, amountPaise) {
  const s = await getSettings();
  if (!s.upi_id || amountPaise <= 0) return null;
  // Keep the VPA's '@' literal and encode spaces as %20: some UPI apps don't decode %40 or '+'.
  const vpa = s.upi_id.trim().replace(/[^A-Za-z0-9.\-_@]/g, '');
  const params = [
    `pa=${vpa}`,
    `pn=${encodeURIComponent(s.upi_name || s.legal_name)}`,
    `am=${toRupees(amountPaise).toFixed(2)}`,
    'cu=INR',
    `tn=${encodeURIComponent(`Invoice ${invoice.number}`.slice(0, 50))}`,
  ];
  const link = `upi://pay?${params.join('&')}`;
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
  return { link, qr, id: s.upi_id };
}

/** Everything needed to render an invoice or quote document. */
async function loadDoc(type, row) {
  const client = await db('clients').where({ id: row.client_id }).first();
  const items = await getItems(type, row.id);
  return { doc: row, client, items };
}

module.exports = { upiFor, loadDoc };
