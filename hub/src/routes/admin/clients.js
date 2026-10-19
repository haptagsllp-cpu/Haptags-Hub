'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { logActivity, getActivities } = require('../../lib/activity');
const { createPasswordLink, INVITE_DAYS } = require('../../lib/auth');
const { sendMail } = require('../../lib/mailer');
const { nowSql, str, isEmail } = require('../../lib/util');
const { paginate, idParam } = require('./_helpers');

const router = express.Router();

function parseClient(body) {
  const c = {
    name: str(body.name, 190),
    contact_name: str(body.contact_name, 190),
    email: (str(body.email, 190) || '').toLowerCase() || null,
    phone: str(body.phone, 40),
    gstin: (str(body.gstin, 20) || '').toUpperCase() || null,
    address: str(body.address, 1000),
    city: str(body.city, 100),
    state: str(body.state, 100),
    pincode: str(body.pincode, 12),
    country: str(body.country, 80) || 'India',
    notes: str(body.notes, 5000),
    status: body.status === 'inactive' ? 'inactive' : 'active',
  };
  // GSTIN's first two digits are the state code — fill the state in if it was left blank.
  if (c.gstin && !c.state) c.state = C.stateFromGstin(c.gstin);
  const errors = {};
  if (!c.name) errors.name = 'Client name is required.';
  if (c.email && !isEmail(c.email)) errors.email = 'Enter a valid email.';
  if (c.gstin && !/^\d{2}[A-Z0-9]{13}$/.test(c.gstin)) errors.gstin = 'GSTIN should be 15 characters, e.g. 29ABCDE1234F1Z5.';
  return { c, errors };
}

/** Billed / received / outstanding per client, from issued invoices only. */
async function balances(clientIds) {
  if (!clientIds.length) return {};
  const rows = await db('invoices').whereIn('client_id', clientIds).whereNotIn('status', ['draft', 'void'])
    .select('client_id').sum({ billed: 'total', paid: 'amount_paid' }).groupBy('client_id');
  return Object.fromEntries(rows.map((r) => [r.client_id, { billed: Number(r.billed || 0), paid: Number(r.paid || 0), due: Number(r.billed || 0) - Number(r.paid || 0) }]));
}

router.get('/', async (req, res) => {
  const q = str(req.query.q, 100);
  const status = req.query.status === 'inactive' ? 'inactive' : 'active';
  // Students and interns live under Education.
  const query = db('clients').where({ status, segment: 'business' }).orderBy('name');
  if (q) query.where((w) => w.where('name', 'like', `%${q}%`).orWhere('contact_name', 'like', `%${q}%`).orWhere('email', 'like', `%${q}%`).orWhere('phone', 'like', `%${q}%`));
  const page = await paginate(query, req, 50);
  const ids = page.rows.map((r) => r.id);
  const [bal, projects] = await Promise.all([
    balances(ids),
    ids.length ? db('projects').whereIn('client_id', ids).whereIn('status', ['planning', 'in_progress', 'review']).select('client_id').count({ n: '*' }).groupBy('client_id') : [],
  ]);
  const activeProjects = Object.fromEntries(projects.map((p) => [p.client_id, Number(p.n)]));
  res.render('admin/clients/index', { title: 'Clients', ...page, q, status, bal, activeProjects });
});

router.get('/new', (req, res) => {
  res.render('admin/clients/form', { title: 'New client', client: { country: 'India', state: res.locals.settings.state }, errors: {} });
});

router.post('/', async (req, res) => {
  const { c, errors } = parseClient(req.body);
  if (Object.keys(errors).length) return res.status(422).render('admin/clients/form', { title: 'New client', client: req.body, errors });
  const [id] = await db('clients').insert({ ...c, created_at: nowSql(), updated_at: nowSql() });
  await logActivity('client', id, req.user.id, 'system', 'Client created');
  req.flash('success', 'Client added.');
  res.redirect(`/admin/clients/${id}`);
});

router.get('/:id', async (req, res, next) => {
  const client = await db('clients').where({ id: idParam(req) }).first();
  if (!client) return next();
  if (client.segment === 'student') return res.redirect(`/admin/education/students/${client.id}`);
  const [projects, quotes, invoices, retainers, tickets, users, activities, bal, lead] = await Promise.all([
    db('projects').where({ client_id: client.id }).orderBy('id', 'desc'),
    db('quotes').where({ client_id: client.id }).orderBy('id', 'desc').limit(20),
    db('invoices').where({ client_id: client.id }).orderBy('id', 'desc').limit(30),
    db('retainers').where({ client_id: client.id }).orderBy('id', 'desc'),
    db('tickets').where({ client_id: client.id }).orderBy('id', 'desc').limit(10),
    db('users').where({ client_id: client.id }).orderBy('name'),
    getActivities('client', client.id),
    balances([client.id]),
    client.source_lead_id ? db('leads').where({ id: client.source_lead_id }).first() : null,
  ]);
  const inviteLink = req.session.inviteLink || null;
  req.session.inviteLink = null;
  res.render('admin/clients/show', {
    title: client.name, client, projects, quotes, invoices, retainers, tickets, users, activities, lead, inviteLink,
    bal: bal[client.id] || { billed: 0, paid: 0, due: 0 },
  });
});

router.get('/:id/edit', async (req, res, next) => {
  const client = await db('clients').where({ id: idParam(req) }).first();
  if (!client) return next();
  res.render('admin/clients/form', { title: `Edit ${client.name}`, client, errors: {} });
});

router.post('/:id', async (req, res, next) => {
  const client = await db('clients').where({ id: idParam(req) }).first();
  if (!client) return next();
  const { c, errors } = parseClient(req.body);
  if (Object.keys(errors).length) return res.status(422).render('admin/clients/form', { title: `Edit ${client.name}`, client: { ...req.body, id: client.id }, errors });
  await db('clients').where({ id: client.id }).update({ ...c, updated_at: nowSql() });
  req.flash('success', 'Client updated.');
  res.redirect(`/admin/clients/${client.id}`);
});

router.post('/:id/note', async (req, res, next) => {
  const client = await db('clients').where({ id: idParam(req) }).first();
  if (!client) return next();
  const body = str(req.body.body, 5000);
  if (body) await logActivity('client', client.id, req.user.id, 'note', body);
  res.redirect(`/admin/clients/${client.id}#activity`);
});

async function emailInvite(user, client, link, inviter) {
  return sendMail({
    to: user.email,
    subject: `Your ${client.name} client portal at Haptags`,
    related: ['client', client.id],
    heading: 'You’re invited to the Haptags client portal',
    lines: [
      `Hi ${user.name},`,
      `${inviter} has set up a client portal for ${client.name}. You can track project progress, view and pay invoices, approve quotations and raise support requests in one place.`,
      `The link below works for ${INVITE_DAYS} days.`,
    ],
    button: { label: 'Set up my account', url: link },
  });
}

router.post('/:id/users', async (req, res, next) => {
  const client = await db('clients').where({ id: idParam(req) }).first();
  if (!client) return next();
  const name = str(req.body.name, 190);
  const email = (str(req.body.email, 190) || '').toLowerCase();
  if (!name || !isEmail(email)) {
    req.flash('error', 'Enter a name and a valid email for the portal user.');
    return res.redirect(`/admin/clients/${client.id}#portal`);
  }
  const taken = await db('users').where({ email }).first();
  if (taken) {
    req.flash('error', taken.client_id === client.id ? 'That person already has portal access.' : 'That email is already used by another account.');
    return res.redirect(`/admin/clients/${client.id}#portal`);
  }
  const [uid] = await db('users').insert({
    name, email, phone: str(req.body.phone, 40), role: 'client', client_id: client.id, is_active: true, token_version: 1,
    created_at: nowSql(), updated_at: nowSql(),
  });
  const link = await createPasswordLink(uid);
  const sent = await emailInvite({ name, email }, client, link, req.user.name);
  await logActivity('client', client.id, req.user.id, 'system', `Portal access given to ${name} <${email}>`);
  req.session.inviteLink = { name, link, sent };
  res.redirect(`/admin/clients/${client.id}#portal`);
});

router.post('/:id/users/:uid/resend', async (req, res, next) => {
  const user = await db('users').where({ id: idParam(req, 'uid'), client_id: idParam(req), role: 'client' }).first();
  if (!user) return next();
  const client = await db('clients').where({ id: user.client_id }).first();
  const link = await createPasswordLink(user.id);
  const sent = await emailInvite(user, client, link, req.user.name);
  req.session.inviteLink = { name: user.name, link, sent };
  res.redirect(`/admin/clients/${client.id}#portal`);
});

router.post('/:id/users/:uid/toggle', async (req, res, next) => {
  const user = await db('users').where({ id: idParam(req, 'uid'), client_id: idParam(req), role: 'client' }).first();
  if (!user) return next();
  await db('users').where({ id: user.id }).update({ is_active: !user.is_active, token_version: user.token_version + 1, updated_at: nowSql() });
  req.flash('success', user.is_active ? `${user.name} can no longer sign in.` : `${user.name} can sign in again.`);
  res.redirect(`/admin/clients/${user.client_id}#portal`);
});

module.exports = router;
module.exports.balances = balances;
