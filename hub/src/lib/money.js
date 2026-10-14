'use strict';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const inrCompact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

/** '1,25,000.50' or '125000.5' -> 12500050 paise. Returns 0 for blank/invalid input. */
function toPaise(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function toRupees(paise) {
  return (Number(paise) || 0) / 100;
}

function formatINR(paise) {
  return inr.format(toRupees(paise));
}

/** Whole-rupee format for dashboards: ₹1,25,000. */
function formatINRShort(paise) {
  return inrCompact.format(Math.round(toRupees(paise)));
}

/** Lakh/crore shorthand for tight spaces: ₹1.2L, ₹3.4Cr. */
function formatINRCompact(paise) {
  const r = toRupees(paise);
  if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(2).replace(/\.?0+$/, '')}Cr`;
  if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(2).replace(/\.?0+$/, '')}L`;
  if (Math.abs(r) >= 1e3) return `₹${(r / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `₹${Math.round(r)}`;
}

/**
 * Line items + tax settings -> totals, all in paise.
 * taxMode: 'intra' (CGST+SGST, same state), 'inter' (IGST, other state), 'none' (no GST).
 */
function computeTotals(items, { taxMode = 'intra', gstRate = 18, discount = 0 } = {}) {
  const lines = items.map((it, i) => {
    const quantity = Math.max(0, Number(it.quantity) || 0);
    const rate = Math.max(0, Math.round(Number(it.rate) || 0));
    return { ...it, quantity, rate, amount: Math.round(quantity * rate), sort: i };
  });
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const disc = Math.min(Math.max(0, Math.round(Number(discount) || 0)), subtotal);
  const taxable = subtotal - disc;
  const rate = Number(gstRate) || 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (taxMode === 'intra') {
    cgst = Math.round((taxable * rate) / 200);
    sgst = cgst;
  } else if (taxMode === 'inter') {
    igst = Math.round((taxable * rate) / 100);
  }
  return { lines, subtotal, discount: disc, taxable, cgst, sgst, igst, total: taxable + cgst + sgst + igst };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}

/** Indian-system words: 125000050 paise -> 'Rupees Twelve Lakh Fifty Thousand and Fifty Paise Only'. */
function amountInWords(paise) {
  const total = Math.round(Number(paise) || 0);
  let rupees = Math.floor(total / 100);
  const ps = total % 100;
  if (rupees === 0 && ps === 0) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(rupees / 1e7);
  rupees %= 1e7;
  const lakh = Math.floor(rupees / 1e5);
  rupees %= 1e5;
  const thousand = Math.floor(rupees / 1e3);
  rupees %= 1e3;
  if (crore) parts.push(`${crore >= 100 ? threeDigits(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rupees) parts.push(threeDigits(rupees));
  let words = parts.length ? `Rupees ${parts.join(' ')}` : 'Rupees Zero';
  if (ps) words += ` and ${twoDigits(ps)} Paise`;
  return `${words} Only`;
}

module.exports = { toPaise, toRupees, formatINR, formatINRShort, formatINRCompact, computeTotals, amountInWords };
