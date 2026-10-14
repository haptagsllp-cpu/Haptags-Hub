'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { parseEnquiry, createLead } = require('../../lib/leads');
const { logActivity, getActivities } = require('../../lib/activity');
const { toPaise } = require('../../lib/money');
const { nowSql, str, int, isDate, todayIST, humanize } = require('../../lib/util');
const { paginate, idParam } = require('./_helpers');
const { ADMIN_ROLES } = require('../../lib/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = req.query.status || 'open';
  const q = str(req.query.q, 100);
  const source = str(req.query.source, 40);
  const query = db('leads as l').leftJoin('users as u', 'u.id', 'l.assigned_to').select('l.*', 'u.name as owner_name');
  if (status === 'open') query.whereIn('l.status', C.LEAD_OPEN);
  else if (status === 'followup') query.whereIn('l.status', C.LEAD_OPEN).where('l.next_follow_up', '<=', todayIST());
  else if (C.LEAD_STATUSES.includes(status)) query.where('l.status', status);
  if (source) query.where('l.source', source);
  if (q) {
    query.where((w) => w.where('l.name', 'like', `%${q}%`).orWhere('l.email', 'like', `%${q}%`)
      .orWhere('l.phone', 'like', `%${q}%`).orWhere('l.company', 'like', `%${q}%`));
  }
  if (status === 'followup') query.orderBy('l.next_follow_up', 'asc');
  query.orderBy('l.id', 'desc');
  const page = await paginate(query, req);

  const stageRows = await db('leads').select('status').count({ n: '*' }).sum({ value: 'value_estimate' }).groupBy('status');
  const stages = Object.fromEntries(C.LEAD_STATUSES.map((s) => [s, { n: 0, value: 0 }]));
  for (const r of stageRows) if (stages[r.status]) stages[r.status] = { n: Number(r.n), value: Number(r.value || 0) };
  const followups = await db('leads').whereIn('status', C.LEAD_OPEN).where('next_follow_up', '<=', todayIST()).count({ n: '*' }).first();

  res.render('admin/leads/index', {
    title: 'Leads', ...page, status, q, source, stages, followupCount: Number(followups.n),
  });
});

router.get('/new', async (req, res) => {
  res.render('admin/leads/form', { title: 'New lead', lead: { source: 'call' }, errors: {}, users: await staffUsers() });
});

router.post('/', async (req, res) => {
  const parsed = parseEnquiry(req.body);
  if (parsed.fields) {
    return res.status(422).render('admin/leads/form', { title: 'New lead', lead: req.body, errors: parsed.fields, users: await staffUsers() });
  }
  const source = C.LEAD_SOURCES.includes(req.body.source) ? req.body.source : 'manual';
  const { id, duplicate } = await createLead(parsed.lead, { source, userId: req.user.id, notify: false });
  const patch = pipelinePatch(req.body);
  if (Object.keys(patch).length && !duplicate) await db('leads').where({ id }).update(patch);
  req.flash(duplicate ? 'info' : 'success', duplicate ? 'This person already has an open lead — added the enquiry to it.' : 'Lead added.');
  res.redirect(`/admin/leads/${id}`);
});

router.get('/:id', async (req, res, next) => {
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  const [activities, users, client, quotes] = await Promise.all([
    getActivities('lead', lead.id),
    staffUsers(),
    lead.client_id ? db('clients').where({ id: lead.client_id }).first() : null,
    db('quotes').where({ lead_id: lead.id }).orderBy('id', 'desc'),
  ]);
  res.render('admin/leads/show', { title: lead.name, lead, activities, users, client, quotes });
});

router.get('/:id/edit', async (req, res, next) => {
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  res.render('admin/leads/form', { title: `Edit ${lead.name}`, lead, errors: {}, users: await staffUsers() });
});

router.post('/:id', async (req, res, next) => {
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  const parsed = parseEnquiry(req.body);
  if (parsed.fields) {
    return res.status(422).render('admin/leads/form', { title: `Edit ${lead.name}`, lead: { ...req.body, id: lead.id }, errors: parsed.fields, users: await staffUsers() });
  }
  const source = C.LEAD_SOURCES.includes(req.body.source) ? req.body.source : lead.source;
  await db('leads').where({ id: lead.id }).update({ ...parsed.lead, source, updated_at: nowSql() });
  req.flash('success', 'Lead updated.');
  res.redirect(`/admin/leads/${lead.id}`);
});

function pipelinePatch(body) {
  const patch = {};
  if (C.LEAD_STATUSES.includes(body.status)) patch.status = body.status;
  if (body.value_estimate !== undefined && body.value_estimate !== '') patch.value_estimate = toPaise(body.value_estimate);
  if (body.next_follow_up !== undefined) patch.next_follow_up = isDate(body.next_follow_up) ? body.next_follow_up : null;
  if (body.assigned_to !== undefined) patch.assigned_to = int(body.assigned_to, 0) || null;
  if (body.lost_reason !== undefined) patch.lost_reason = str(body.lost_reason, 255);
  return patch;
}

router.post('/:id/pipeline', async (req, res, next) => {
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  const patch = pipelinePatch(req.body);
  await db('leads').where({ id: lead.id }).update({ ...patch, updated_at: nowSql() });
  if (patch.status && patch.status !== lead.status) {
    await logActivity('lead', lead.id, req.user.id, 'status', `Status: ${humanize(lead.status)} → ${humanize(patch.status)}${patch.status === 'lost' && patch.lost_reason ? ` (${patch.lost_reason})` : ''}`);
  }
  if (patch.next_follow_up && patch.next_follow_up !== lead.next_follow_up) {
    await logActivity('lead', lead.id, req.user.id, 'system', `Follow-up set for ${patch.next_follow_up}`);
  }
  req.flash('success', 'Pipeline updated.');
  res.redirect(`/admin/leads/${lead.id}`);
});

router.post('/:id/note', async (req, res, next) => {
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  const body = str(req.body.body, 5000);
  const kind = ['note', 'call', 'email', 'meeting', 'whatsapp'].includes(req.body.kind) ? req.body.kind : 'note';
  if (body) {
    await logActivity('lead', lead.id, req.user.id, kind, body);
    const patch = { updated_at: nowSql() };
    // Logging the first real conversation moves a fresh lead forward automatically.
    if (lead.status === 'new' && kind !== 'note') patch.status = 'contacted';
    if (isDate(req.body.next_follow_up)) patch.next_follow_up = req.body.next_follow_up;
    await db('leads').where({ id: lead.id }).update(patch);
  }
  res.redirect(`/admin/leads/${lead.id}#activity`);
});

/** Creates (or links) the client record so we can send a quote or invoice. */
router.post('/:id/convert', async (req, res, next) => {
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  let clientId = lead.client_id;
  if (!clientId) {
    const existing = lead.email ? await db('clients').where({ email: lead.email }).first() : null;
    if (existing) {
      clientId = existing.id;
    } else {
      [clientId] = await db('clients').insert({
        name: lead.company || lead.name,
        contact_name: lead.name,
        email: lead.email,
        phone: lead.phone,
        state: res.locals.settings.state,
        country: 'India',
        notes: lead.message,
        status: 'active',
        source_lead_id: lead.id,
        created_at: nowSql(),
        updated_at: nowSql(),
      });
      await logActivity('client', clientId, req.user.id, 'system', `Client created from lead #${lead.id}`);
    }
    const status = ['new', 'contacted'].includes(lead.status) ? 'qualified' : lead.status;
    await db('leads').where({ id: lead.id }).update({ client_id: clientId, status, updated_at: nowSql() });
    await logActivity('lead', lead.id, req.user.id, 'system', 'Client record created');
  }
  const goTo = req.body.then === 'quote' ? `/admin/quotes/new?client_id=${clientId}&lead_id=${lead.id}` : `/admin/clients/${clientId}`;
  req.flash('success', 'Client record ready. Check their state and GSTIN so tax is calculated correctly.');
  res.redirect(goTo);
});

router.post('/:id/delete', async (req, res, next) => {
  if (!ADMIN_ROLES.includes(req.user.role)) return res.sendStatus(403);
  const lead = await db('leads').where({ id: idParam(req) }).first();
  if (!lead) return next();
  await db('activities').where({ entity_type: 'lead', entity_id: lead.id }).del();
  await db('leads').where({ id: lead.id }).del();
  req.flash('success', 'Lead deleted.');
  res.redirect('/admin/leads');
});

function staffUsers() {
  return db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).orderBy('name').select('id', 'name');
}

module.exports = router;
