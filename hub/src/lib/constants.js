'use strict';

// Values match the enquiry form on haptags.com so forwarded leads map 1:1.
const SERVICES = [
  ['website-development', 'Website Development'],
  ['web-application-development', 'Web Application Development'],
  ['mobile-app-development', 'Mobile App Development'],
  ['saas-development', 'SaaS Development'],
  ['ecommerce-development', 'E-commerce Development'],
  ['crm-development', 'CRM Development'],
  ['lms-development', 'LMS Development'],
  ['real-estate-technology', 'Real Estate Technology'],
  ['ai-solutions', 'AI Solutions'],
  ['ai-automation', 'AI Automation'],
  ['digital-marketing', 'Digital Marketing'],
  ['ui-ux-design', 'UI/UX Design'],
  ['cloud-devops', 'Cloud & DevOps'],
  ['software-consulting', 'Software Consulting'],
  ['spaces', 'Haptags Spaces'],
  ['maintenance', 'Maintenance & Support (AMC)'],
];

const BUDGETS = [
  ['under-50k', 'Under ₹50,000', 3500000],
  ['50k-2l', '₹50,000 – ₹2 lakh', 12500000],
  ['2l-5l', '₹2 – 5 lakh', 35000000],
  ['5l-15l', '₹5 – 15 lakh', 100000000],
  ['15l-plus', '₹15 lakh+', 150000000],
  ['not-sure', 'Not sure yet', 0],
];

const TIMELINES = [
  ['2-4-weeks', '2–4 weeks'],
  ['1-2-months', '1–2 months'],
  ['2-4-months', '2–4 months'],
  ['4-plus', '4+ months'],
];

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const LEAD_OPEN = ['new', 'contacted', 'qualified', 'proposal'];
const LEAD_SOURCES = ['website', 'hub-form', 'whatsapp', 'call', 'referral', 'instagram', 'linkedin', 'google-ads', 'meta-ads', 'event', 'manual'];

const PROJECT_STATUSES = ['planning', 'in_progress', 'review', 'on_hold', 'completed', 'cancelled'];
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'invoiced'];
const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void'];
const TICKET_STATUSES = ['open', 'awaiting_client', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const PAYMENT_METHODS = [
  ['upi', 'UPI'],
  ['bank_transfer', 'Bank transfer (NEFT/RTGS/IMPS)'],
  ['razorpay', 'Razorpay'],
  ['cash', 'Cash'],
  ['cheque', 'Cheque'],
  ['other', 'Other'],
];
const RETAINER_INTERVALS = [['monthly', 'Monthly', 1], ['quarterly', 'Quarterly', 3], ['half_yearly', 'Half-yearly', 6], ['yearly', 'Yearly', 12]];

// GST state codes (first two digits of a GSTIN).
const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
];

const label = (pairs, value) => (pairs.find((p) => p[0] === value) || [null, value || ''])[1];

function stateFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return null;
  return label(STATES, gstin.slice(0, 2)) || null;
}

function budgetEstimate(budget) {
  const row = BUDGETS.find((b) => b[0] === budget);
  return row ? row[2] : 0;
}

module.exports = {
  SERVICES, BUDGETS, TIMELINES, LEAD_STATUSES, LEAD_OPEN, LEAD_SOURCES, PROJECT_STATUSES, QUOTE_STATUSES,
  INVOICE_STATUSES, TICKET_STATUSES, TICKET_PRIORITIES, PAYMENT_METHODS, RETAINER_INTERVALS, STATES,
  label, stateFromGstin, budgetEstimate,
  serviceLabel: (v) => label(SERVICES, v),
  budgetLabel: (v) => label(BUDGETS, v),
  timelineLabel: (v) => label(TIMELINES, v),
  methodLabel: (v) => label(PAYMENT_METHODS, v),
};
