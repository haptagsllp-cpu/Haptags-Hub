'use strict';

const config = require('../config');
const { db } = require('../db');
const { nowSql, str, isEmail } = require('./util');
const { logActivity } = require('./activity');
const { sendMail } = require('./mailer');
const { getSettings } = require('./settings');
const C = require('./constants');

/** Validates enquiry input from any channel. Returns { lead } or { fields } with errors. */
function parseEnquiry(body) {
  const lead = {
    name: str(body.name, 190),
    email: str(body.email, 190),
    phone: str(body.phone, 40),
    company: str(body.company, 190),
    website: str(body.website, 255),
    service: str(body.service, 80),
    budget: str(body.budget, 40),
    timeline: str(body.timeline, 40),
    message: str(body.message || body.description, 5000),
  };
  if (lead.email) lead.email = lead.email.toLowerCase();
  const fields = {};
  if (!lead.name) fields.name = 'Please tell us your name.';
  if (!lead.email && !lead.phone) fields.email = 'Please share an email or phone number.';
  if (lead.email && !isEmail(lead.email)) fields.email = 'Please enter a valid email address.';
  if (lead.phone && lead.phone.replace(/\D/g, '').length < 8) fields.phone = 'Please enter a valid phone number.';
  return Object.keys(fields).length ? { fields } : { lead };
}

/**
 * Creates a lead, or folds a repeat enquiry into the person's existing open lead so the
 * pipeline doesn't fill with duplicates. Notifies the team and auto-replies to the prospect.
 */
async function createLead(lead, { source = 'manual', sourceDetail = null, userId = null, notify = true } = {}) {
  const match = [];
  if (lead.email) match.push(['email', lead.email]);
  if (lead.phone) match.push(['phone', lead.phone]);
  let existing = null;
  if (match.length) {
    existing = await db('leads').whereIn('status', C.LEAD_OPEN)
      .where((q) => match.forEach(([k, v]) => q.orWhere(k, v)))
      .orderBy('id', 'desc').first();
  }
  if (existing) {
    const summary = [lead.service && `Service: ${C.serviceLabel(lead.service)}`, lead.budget && `Budget: ${C.budgetLabel(lead.budget)}`, lead.message]
      .filter(Boolean).join('\n');
    await logActivity('lead', existing.id, userId, 'note', `Enquired again via ${source}.${summary ? `\n${summary}` : ''}`);
    await db('leads').where({ id: existing.id }).update({ updated_at: nowSql() });
    return { id: existing.id, duplicate: true };
  }

  const [id] = await db('leads').insert({
    ...lead,
    source,
    source_detail: sourceDetail,
    status: 'new',
    value_estimate: C.budgetEstimate(lead.budget),
    created_at: nowSql(),
    updated_at: nowSql(),
  });
  await logActivity('lead', id, userId, 'system', `Lead created from ${source}${sourceDetail ? ` (${sourceDetail})` : ''}`);

  if (notify) {
    const s = await getSettings();
    await sendMail({
      to: config.notifyEmail,
      replyTo: lead.email || undefined,
      subject: `🔔 New lead: ${lead.name}${lead.company ? ` (${lead.company})` : ''} — ${C.serviceLabel(lead.service) || 'General enquiry'}`,
      related: ['lead', id],
      heading: 'New enquiry',
      lines: [lead.message || 'No message provided.', 'Reply within the hour — fast responses win more deals.'],
      rows: [
        ['Name', lead.name], ['Company', lead.company || '—'], ['Email', lead.email || '—'], ['Phone', lead.phone || '—'],
        ['Service', C.serviceLabel(lead.service) || '—'], ['Budget', C.budgetLabel(lead.budget) || '—'],
        ['Timeline', C.timelineLabel(lead.timeline) || '—'], ['Source', source],
      ],
      button: { label: 'Open lead', url: `${config.baseUrl}/admin/leads/${id}` },
    });
    if (s.lead_auto_reply === '1' && lead.email) {
      await sendMail({
        to: lead.email,
        replyTo: s.email,
        subject: `Thanks for contacting ${s.company_name} — we've got your enquiry`,
        related: ['lead', id],
        heading: `Thanks, ${lead.name.split(' ')[0]}!`,
        lines: [
          `We've received your enquiry${lead.service ? ` about ${C.serviceLabel(lead.service)}` : ''} and a member of our team will get back to you within one working day.`,
          'If it’s urgent, message us on WhatsApp and we’ll pick it up right away.',
        ],
        button: s.whatsapp ? { label: 'Chat on WhatsApp', url: `https://wa.me/${s.whatsapp}` } : null,
        footnote: `${s.legal_name} · ${s.tagline}`,
      });
    }
  }
  return { id, duplicate: false };
}

module.exports = { parseEnquiry, createLead };
