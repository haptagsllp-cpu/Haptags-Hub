'use strict';

// Usage: npm run create-admin -- --name "Your Name" --email you@haptags.com --password "a-strong-password" [--role owner|admin]

const { db, migrate } = require('../src/db');
const { hashPassword, passwordProblem } = require('../src/lib/auth');
const { nowSql, isEmail } = require('../src/lib/util');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg('name');
  const email = (arg('email') || '').toLowerCase();
  const password = arg('password');
  const role = ['owner', 'admin'].includes(arg('role')) ? arg('role') : 'owner';
  if (!name || !isEmail(email) || !password) throw new Error('Pass --name, --email and --password.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  await migrate();
  const existing = await db('users').where({ email }).first();
  const values = { name, role, client_id: null, password_hash: await hashPassword(password), is_active: true, updated_at: nowSql() };
  if (existing) {
    await db('users').where({ id: existing.id }).update({ ...values, token_version: existing.token_version + 1 });
    console.log(`Updated ${email} (${role}).`);
  } else {
    await db('users').insert({ ...values, email, token_version: 1, created_at: nowSql() });
    console.log(`Created ${email} (${role}).`);
  }
}

main().then(() => db.destroy()).catch((err) => {
  console.error(err.message);
  db.destroy();
  process.exit(1);
});
