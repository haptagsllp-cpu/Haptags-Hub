'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * WebRTC servers for the meeting room. STUN finds each browser's public address; a TURN relay
 * is only needed for networks that block direct connections (some offices and mobile carriers).
 */
function iceServers() {
  if (env.ICE_SERVERS) {
    try {
      return JSON.parse(env.ICE_SERVERS);
    } catch {
      console.error('[config] ICE_SERVERS is not valid JSON; using the defaults.');
    }
  }
  const servers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  if (env.TURN_URL) servers.push({ urls: list(env.TURN_URL), username: env.TURN_USERNAME || '', credential: env.TURN_CREDENTIAL || '' });
  return servers;
}

const config = {
  isProd,
  port: Number(env.PORT) || 3000,
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/+$/, ''),
  sessionSecret: env.SESSION_SECRET || (isProd ? null : 'dev-only-secret-change-me'),

  db: env.DB_HOST
    ? {
        client: 'mysql2',
        connection: {
          host: env.DB_HOST,
          port: Number(env.DB_PORT) || 3306,
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          database: env.DB_NAME,
          charset: 'utf8mb4',
          dateStrings: true,
          decimalNumbers: true,
          timezone: 'Z',
        },
        pool: { min: 0, max: 8 },
      }
    : {
        client: 'better-sqlite3',
        connection: { filename: env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'hub.sqlite') },
        useNullAsDefault: true,
      },

  smtp: env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT) || 465,
        secure: (Number(env.SMTP_PORT) || 465) === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      }
    : null,
  mailFrom: env.MAIL_FROM || 'Haptags <info@haptags.com>',
  notifyEmail: env.NOTIFY_EMAIL || 'info@haptags.com',

  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  // Optional: lets a hosting cron job call /api/v1/cron?key=... to run automations.
  cronKey: env.CRON_KEY || '',

  iceServers: iceServers(),

  // Haptags LMS (lms.haptags.com) daily doubt sessions. The LMS server sends `X-API-Key`;
  // only its SHA-256 is kept here, so the key itself never lives in this repository.
  lms: {
    keySha256: (env.LMS_KEY_SHA256 || '4c3eabeed667b9f03e87fea97a1e9275f78f758e337c9f7c570c483c16ec94d5').toLowerCase(),
    sessionTime: env.LMS_SESSION_TIME || '19:00', // IST, every day
    sessionMinutes: Number(env.LMS_SESSION_MINUTES) || 60,
    hostEmail: env.LMS_HOST_EMAIL || '', // organiser; defaults to the first owner
    // The LMS API, for pulling certificates (its verify and PDF endpoints are public).
    apiUrl: (env.LMS_API_URL === undefined ? 'https://lms.haptags.com/hcgi/api' : env.LMS_API_URL).replace(/\/+$/, ''),
  },

  // Browser origins allowed to post enquiries straight to /api/v1/leads.
  leadOrigins: list(env.LEAD_ORIGINS || 'https://haptags.com,https://www.haptags.com'),
};

config.razorpay.enabled = Boolean(config.razorpay.keyId && config.razorpay.keySecret);

if (isProd && !config.sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production.');
}

module.exports = config;
