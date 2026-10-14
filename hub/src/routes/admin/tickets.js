'use strict';

const express = require('express');
const config = require('../../config');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { sendMail } = require('../../lib/mailer');
const { nowSql, str, int, humanize } = require('../../lib/util');
const { paginate, clientOptions, idParam } = require('./_helpers');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = req.query.status || 'active';
  const query = db('tickets as t').join('clients as c', 'c.id', 't.client_id').leftJoin('projects as p', 'p.id', 't.project_id')
    .select('t.*', 'c.name as client_name', 'p.name as project_name');
  if (status === 'active') query.whereIn('t.status', ['open', 'awaiting_client']);
  else if (C.TICKET_STATUSES.includes(status)) query.where('t.status', status);
  // Tickets waiting on us, most urgent first.
  query.orderByRaw("CASE t.status WHEN 'open' THEN 0 WHEN 'awaiting_client' THEN 1 ELSE 2 END")
    .orderByRaw("CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END")
    .orderBy('t.last_reply_at', 'desc');
  const page = await paginate(query, req);
  res.render('admin/tickets/index', { title: 'Support', ...page, status });
});

router.get('/new', async (req, res) => {
  res.render('admin/tickets/form', {
    title: 'New ticket', ticket: { client_id: int(req.query.client_id, 0), priority: 'normal' }, errors: {},
    clients: await clientOptions(), projects: await db('projects').whereNotIn('status', ['cancelled']).orderBy('name').select('id', 'name', 'client_id'),
  });
});

router.post('/', async (req, res) => {
  const clientId = int(req.body.client_id, 0);
  const subject = str(req.body.subject, 255);
  const body = str(req.body.body, 10000);
  const errors = {};
  if (!clientId) errors.client_id = 'Choose a client.';
  if (!subject) errors.subject = 'Add a subject.';
  if (!body) errors.body = 'Describe the request.';
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/tickets/form', {
      title: 'New ticket', ticket: req.body, errors, clients: await clientOptions(), projects: await db('projects').orderBy('name').select('id', 'name', 'client_id'),
    });
  }
  const [id] = await db('tickets').insert({
    client_id: clientId, project_id: int(req.body.project_id, 0) || null, subject,
    priority: C.TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal',
    status: 'open', created_by: req.user.id, last_reply_at: nowSql(), last_reply_by: 'staff', created_at: nowSql(), updated_at: nowSql(),
  });
  await db('ticket_messages').insert({ ticket_id: id, user_id: req.user.id, body, internal: false, created_at: nowSql() });
  req.flash('success', 'Ticket created.');
  res.redirect(`/admin/tickets/${id}`);
});

router.get('/:id', async (req, res, next) => {
  const ticket = await db('tickets as t').join('clients as c', 'c.id', 't.client_id').leftJoin('projects as p', 'p.id', 't.project_id')
    .where('t.id', idParam(req)).select('t.*', 'c.name as client_name', 'c.email as client_email', 'p.name as project_name').first();
  if (!ticket) return next();
  const messages = await db('ticket_messages as m').leftJoin('users as u', 'u.id', 'm.user_id').where('m.ticket_id', ticket.id)
    .orderBy('m.id').select('m.*', 'u.name as user_name', 'u.role as user_role');
  res.render('admin/tickets/show', { title: ticket.subject, ticket, messages });
});

router.post('/:id/reply', async (req, res, next) => {
  const ticket = await db('tickets').where({ id: idParam(req) }).first();
  if (!ticket) return next();
  const body = str(req.body.body, 10000);
  const internal = Boolean(req.body.internal);
  const status = C.TICKET_STATUSES.includes(req.body.status) ? req.body.status : (internal ? ticket.status : 'awaiting_client');
  if (body) await db('ticket_messages').insert({ ticket_id: ticket.id, user_id: req.user.id, body, internal, created_at: nowSql() });
  const patch = { status, updated_at: nowSql() };
  if (body && !internal) Object.assign(patch, { last_reply_at: nowSql(), last_reply_by: 'staff' });
  await db('tickets').where({ id: ticket.id }).update(patch);

  if (body && !internal) {
    // Email the person who raised it, or every active portal user for the client.
    const creator = ticket.created_by ? await db('users').where({ id: ticket.created_by, role: 'client', is_active: true }).first() : null;
    const recipients = creator ? [creator.email] : await db('users').where({ client_id: ticket.client_id, is_active: true }).pluck('email');
    for (const to of recipients) {
      await sendMail({
        to,
        subject: `Re: ${ticket.subject} [#${ticket.id}]`,
        related: ['ticket', ticket.id],
        heading: `New reply on your request #${ticket.id}`,
        lines: [...body.split(/\n+/), `Status: ${humanize(status)}`],
        button: { label: 'View & reply', url: `${config.baseUrl}/portal/tickets/${ticket.id}` },
      });
    }
  }
  req.flash('success', internal ? 'Internal note added.' : 'Reply sent.');
  res.redirect(`/admin/tickets/${ticket.id}`);
});

router.post('/:id/meta', async (req, res, next) => {
  const ticket = await db('tickets').where({ id: idParam(req) }).first();
  if (!ticket) return next();
  await db('tickets').where({ id: ticket.id }).update({
    status: C.TICKET_STATUSES.includes(req.body.status) ? req.body.status : ticket.status,
    priority: C.TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : ticket.priority,
    updated_at: nowSql(),
  });
  res.redirect(`/admin/tickets/${ticket.id}`);
});

module.exports = router;
