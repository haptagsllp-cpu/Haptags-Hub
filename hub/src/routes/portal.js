'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { sendMail } = require('../lib/mailer');
const { verifyPassword, hashPassword, passwordProblem, signIn } = require('../lib/auth');
const { nowSql, str, int } = require('../lib/util');

const router = express.Router();

// Every query below is scoped to the signed-in user's client_id.
router.use(async (req, res, next) => {
  req.clientId = req.user.client_id;
  res.locals.client = await db('clients').where({ id: req.clientId }).first();
  if (!res.locals.client) {
    req.session = null;
    return res.redirect('/login');
  }
  next();
});

const visibleInvoices = (clientId) => db('invoices').where({ client_id: clientId }).whereNotIn('status', ['draft']);
const visibleQuotes = (clientId) => db('quotes').where({ client_id: clientId }).whereNot({ status: 'draft' });

router.get('/', async (req, res) => {
  const [projects, unpaid, quotes, tickets, updates] = await Promise.all([
    db('projects').where({ client_id: req.clientId }).whereIn('status', ['planning', 'in_progress', 'review', 'on_hold']).orderBy('due_date'),
    visibleInvoices(req.clientId).whereIn('status', ['sent', 'partially_paid', 'overdue']).orderBy('due_date'),
    visibleQuotes(req.clientId).where({ status: 'sent' }).orderBy('id', 'desc'),
    db('tickets').where({ client_id: req.clientId }).whereIn('status', ['open', 'awaiting_client']).orderBy('last_reply_at', 'desc').limit(5),
    db('project_updates as u').join('projects as p', 'p.id', 'u.project_id').where('p.client_id', req.clientId).where('u.client_visible', true)
      .orderBy('u.id', 'desc').limit(8).select('u.*', 'p.name as project_name', 'p.id as project_id'),
  ]);
  const balance = unpaid.reduce((s, i) => s + Number(i.total) - Number(i.amount_paid), 0);
  res.render('portal/home', { title: 'Overview', projects, unpaid, quotes, tickets, updates, balance });
});

router.get('/projects', async (req, res) => {
  const projects = await db('projects').where({ client_id: req.clientId }).whereNot({ status: 'cancelled' }).orderBy('id', 'desc');
  res.render('portal/projects', { title: 'Projects', projects });
});

router.get('/projects/:id', async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0), client_id: req.clientId }).first();
  if (!project) return next();
  const [milestones, updates, links, invoices] = await Promise.all([
    db('milestones').where({ project_id: project.id, client_visible: true }).orderByRaw('CASE WHEN due_date IS NULL THEN 1 ELSE 0 END').orderBy('due_date').orderBy('id'),
    db('project_updates as u').leftJoin('users as us', 'us.id', 'u.user_id').where({ 'u.project_id': project.id, 'u.client_visible': true })
      .orderBy('u.id', 'desc').select('u.*', 'us.name as user_name'),
    db('project_links').where({ project_id: project.id, client_visible: true }).orderBy('id', 'desc'),
    visibleInvoices(req.clientId).where({ project_id: project.id }).orderBy('id', 'desc'),
  ]);
  res.render('portal/project', { title: project.name, project, milestones, updates, links, invoices });
});

router.get('/invoices', async (req, res) => {
  const invoices = await visibleInvoices(req.clientId).orderBy('issue_date', 'desc').orderBy('id', 'desc');
  res.render('portal/invoices', { title: 'Invoices', invoices });
});

router.get('/quotes', async (req, res) => {
  const quotes = await visibleQuotes(req.clientId).orderBy('id', 'desc');
  res.render('portal/quotes', { title: 'Quotations', quotes });
});

// ---- Support ---------------------------------------------------------------------------
router.get('/tickets', async (req, res) => {
  const tickets = await db('tickets as t').leftJoin('projects as p', 'p.id', 't.project_id').where('t.client_id', req.clientId)
    .orderByRaw("CASE WHEN t.status IN ('open','awaiting_client') THEN 0 ELSE 1 END").orderBy('t.last_reply_at', 'desc')
    .select('t.*', 'p.name as project_name');
  res.render('portal/tickets', { title: 'Support', tickets });
});

router.get('/tickets/new', async (req, res) => {
  const projects = await db('projects').where({ client_id: req.clientId }).whereNot({ status: 'cancelled' }).orderBy('name');
  res.render('portal/ticket-new', { title: 'New request', projects, values: { project_id: req.query.project_id || '' }, errors: {} });
});

async function notifyTeam(ticket, body, clientName, userName, isNew) {
  await sendMail({
    to: config.notifyEmail,
    subject: `${isNew ? '🆕 Support request' : '💬 Client reply'} [#${ticket.id}] ${ticket.subject} — ${clientName}`,
    related: ['ticket', ticket.id],
    heading: isNew ? 'New support request' : 'Client replied',
    lines: [`${userName} (${clientName}) wrote:`, ...body.split(/\n+/)],
    rows: [['Priority', ticket.priority]],
    button: { label: 'Open ticket', url: `${config.baseUrl}/admin/tickets/${ticket.id}` },
  });
}

router.post('/tickets', async (req, res) => {
  const subject = str(req.body.subject, 255);
  const body = str(req.body.body, 10000);
  const projectId = int(req.body.project_id, 0);
  const project = projectId ? await db('projects').where({ id: projectId, client_id: req.clientId }).first() : null;
  const errors = {};
  if (!subject) errors.subject = 'Add a short subject.';
  if (!body) errors.body = 'Tell us what you need.';
  if (Object.keys(errors).length) {
    const projects = await db('projects').where({ client_id: req.clientId }).orderBy('name');
    return res.status(422).render('portal/ticket-new', { title: 'New request', projects, values: req.body, errors });
  }
  const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal';
  const [id] = await db('tickets').insert({
    client_id: req.clientId, project_id: project ? project.id : null, subject, priority, status: 'open', created_by: req.user.id,
    last_reply_at: nowSql(), last_reply_by: 'client', created_at: nowSql(), updated_at: nowSql(),
  });
  await db('ticket_messages').insert({ ticket_id: id, user_id: req.user.id, body, internal: false, created_at: nowSql() });
  await notifyTeam({ id, subject, priority }, body, res.locals.client.name, req.user.name, true);
  req.flash('success', 'Request sent. We’ll reply here and by email.');
  res.redirect(`/portal/tickets/${id}`);
});

router.get('/tickets/:id', async (req, res, next) => {
  const ticket = await db('tickets').where({ id: int(req.params.id, 0), client_id: req.clientId }).first();
  if (!ticket) return next();
  const messages = await db('ticket_messages as m').leftJoin('users as u', 'u.id', 'm.user_id')
    .where({ 'm.ticket_id': ticket.id, 'm.internal': false }).orderBy('m.id').select('m.*', 'u.name as user_name', 'u.role as user_role');
  res.render('portal/ticket', { title: ticket.subject, ticket, messages });
});

router.post('/tickets/:id/reply', async (req, res, next) => {
  const ticket = await db('tickets').where({ id: int(req.params.id, 0), client_id: req.clientId }).first();
  if (!ticket) return next();
  const body = str(req.body.body, 10000);
  if (req.body.close) {
    await db('tickets').where({ id: ticket.id }).update({ status: 'closed', updated_at: nowSql() });
    req.flash('success', 'Request closed. Thanks!');
    return res.redirect(`/portal/tickets/${ticket.id}`);
  }
  if (body) {
    await db('ticket_messages').insert({ ticket_id: ticket.id, user_id: req.user.id, body, internal: false, created_at: nowSql() });
    await db('tickets').where({ id: ticket.id }).update({ status: 'open', last_reply_at: nowSql(), last_reply_by: 'client', updated_at: nowSql() });
    await notifyTeam(ticket, body, res.locals.client.name, req.user.name, false);
    req.flash('success', 'Reply sent.');
  }
  res.redirect(`/portal/tickets/${ticket.id}`);
});

// ---- Account ---------------------------------------------------------------------------
router.get('/account', (req, res) => res.render('portal/account', { title: 'My account', error: null }));

router.post('/account', async (req, res) => {
  const ok = await verifyPassword(req.body.current || '', req.user.password_hash);
  const problem = !ok ? 'Your current password is incorrect.' : passwordProblem(req.body.password) || (req.body.password !== req.body.confirm ? 'The new passwords don’t match.' : null);
  if (problem) return res.status(422).render('portal/account', { title: 'My account', error: problem });
  const v = req.user.token_version + 1;
  await db('users').where({ id: req.user.id }).update({ password_hash: await hashPassword(req.body.password), token_version: v, updated_at: nowSql() });
  signIn(req, { ...req.user, token_version: v });
  req.flash('success', 'Password changed.');
  res.redirect('/portal/account');
});

module.exports = router;
