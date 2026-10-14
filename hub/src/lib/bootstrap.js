'use strict';

const { db } = require('../db');
const { hashPassword, passwordProblem } = require('./auth');
const { nowSql } = require('./util');

/**
 * First-run setup without shell access: if no owner exists and ADMIN_EMAIL + ADMIN_PASSWORD are
 * set, create the owner account. Ignored once an owner exists, so the env vars can be removed
 * after the first sign-in.
 */
async function ensureOwner() {
  const owner = await db('users').where({ role: 'owner' }).first();
  if (owner) return null;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('[setup] No owner account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run `npm run create-admin`.');
    return null;
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  const existing = await db('users').where({ email }).first();
  const values = {
    name: process.env.ADMIN_NAME || 'Haptags Admin',
    role: 'owner',
    client_id: null,
    password_hash: await hashPassword(password),
    is_active: true,
    updated_at: nowSql(),
  };
  if (existing) await db('users').where({ id: existing.id }).update(values);
  else await db('users').insert({ ...values, email, token_version: 1, created_at: nowSql() });
  console.log(`[setup] Owner account created for ${email}.`);
  return email;
}

module.exports = { ensureOwner };
