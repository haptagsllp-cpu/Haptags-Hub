'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const { db } = require('../db');
const { nowSql } = require('./util');
const { getSettings } = require('./settings');

const transport = config.smtp ? nodemailer.createTransport(config.smtp) : null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Branded transactional email. `lines` are plain-text paragraphs (escaped); `rows` render as a
 * label/value table; `button` is the single call to action.
 */
async function renderEmail({ heading, lines = [], rows = [], button, footnote }) {
  const s = await getSettings();
  const para = lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#445169">${esc(l)}</p>`).join('');
  const table = rows.length
    ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:6px 0 18px;font-size:14px">${rows
        .map(([k, v]) => `<tr><td style="padding:8px 0;color:#64748b;border-bottom:1px solid #e2e8f0">${esc(k)}</td><td style="padding:8px 0;text-align:right;color:#0b1324;font-weight:600;border-bottom:1px solid #e2e8f0">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : '';
  const btn = button
    ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#007af5;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;font-size:15px">${esc(button.label)}</a></p>`
    : '';
  const note = footnote ? `<p style="margin:16px 0 0;font-size:13px;color:#64748b">${esc(footnote)}</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f8fc;font-family:'Segoe UI',Roboto,Arial,sans-serif">
<table role="presentation" width="100%" style="background:#f6f8fc;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e2e8f0;font-weight:800;font-size:18px;color:#02213d;letter-spacing:.04em">${esc(s.company_name.toUpperCase())}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:21px;color:#0b1324">${esc(heading)}</h1>${para}${table}${btn}${note}
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.6">
${esc(s.legal_name)} · ${esc(s.city)}, ${esc(s.state)}<br>${esc(s.email)} · ${esc(s.phone)} · ${esc(s.website.replace(/^https?:\/\//, ''))}
</td></tr></table></td></tr></table></body></html>`;
}

function htmlToText(html) {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2: $1')
    .replace(/<\/(p|tr|h1)>/g, '\n')
    .replace(/<td[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Sends (or, without SMTP, records) an email. Never throws: a mail failure must not
 * break the business action that triggered it. Returns true when the message went out.
 */
async function sendMail({ to, subject, replyTo, related, ...content }) {
  if (!to) return false;
  const html = await renderEmail(content);
  let status = 'not_configured';
  let error = null;
  if (transport) {
    try {
      await transport.sendMail({ from: config.mailFrom, to, replyTo, subject, html, text: htmlToText(html) });
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = String(err && err.message ? err.message : err).slice(0, 1000);
      console.error(`[mail] failed to ${to}: ${error}`);
    }
  } else if (!config.isProd) {
    console.log(`[mail:dev] to=${to} subject="${subject}"`);
  }
  try {
    await db('email_log').insert({
      to_email: String(to).slice(0, 190),
      subject: String(subject).slice(0, 255),
      status,
      error,
      related_type: related ? related[0] : null,
      related_id: related ? related[1] : null,
      created_at: nowSql(),
    });
  } catch (err) {
    console.error('[mail] could not write email_log', err.message);
  }
  return status === 'sent';
}

module.exports = { sendMail, mailEnabled: Boolean(transport) };
