'use strict';

const express = require('express');
const config = require('../../config');
const { db } = require('../../db');
const C = require('../../lib/constants');
const { logActivity } = require('../../lib/activity');
const { sendMail } = require('../../lib/mailer');
const { toPaise } = require('../../lib/money');
const { nowSql, str, int, isDate, humanize } = require('../../lib/util');
const { paginate, clientOptions, idParam } = require('./_helpers');

const router = express.Router();

function parseProject(body) {
  const p = {
    client_id: int(body.client_id, 0),
    name: str(body.name, 190),
    service: str(body.service, 80),
    description: str(body.description, 5000),
    status: C.PROJECT_STATUSES.includes(body.status) ? body.status : 'planning',
    progress: Math.min(100, Math.max(0, int(body.progress, 0))),
    start_date: isDate(body.start_date) ? body.start_date : null,
    due_date: isDate(body.due_date) ? body.due_date : null,
    budget: toPaise(body.budget),
  };
  const errors = {};
  if (!p.client_id) errors.client_id = 'Choose a client.';
  if (!p.name) errors.name = 'Project name is required.';
  return { p, errors };
}

router.get('/', async (req, res) => {
  const status = req.query.status || 'active';
  const query = db('projects as p').join('clients as c', 'c.id', 'p.client_id').select('p.*', 'c.name as client_name');
  if (status === 'active') query.whereIn('p.status', ['planning', 'in_progress', 'review']);
  else if (C.PROJECT_STATUSES.includes(status)) query.where('p.status', status);
  query.orderByRaw('CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END').orderBy('p.due_date').orderBy('p.id', 'desc');
  const page = await paginate(query, req, 50);
  res.render('admin/projects/index', { title: 'Projects', ...page, status });
});

router.get('/new', async (req, res) => {
  res.render('admin/projects/form', {
    title: 'New project', project: { client_id: int(req.query.client_id, 0), status: 'planning', progress: 0 }, errors: {}, clients: await clientOptions(),
  });
});

router.post('/', async (req, res) => {
  const { p, errors } = parseProject(req.body);
  if (Object.keys(errors).length) return res.status(422).render('admin/projects/form', { title: 'New project', project: req.body, errors, clients: await clientOptions() });
  const [id] = await db('projects').insert({ ...p, created_at: nowSql(), updated_at: nowSql() });
  // Sensible default milestones so the client sees a roadmap from day one.
  const defaults = ['Kick-off & requirements', 'Design', 'Build', 'Review & feedback', 'Launch'];
  if (req.body.default_milestones) {
    await db('milestones').insert(defaults.map((title) => ({ project_id: id, title, status: 'todo', client_visible: true, created_at: nowSql() })));
  }
  await logActivity('project', id, req.user.id, 'system', 'Project created');
  req.flash('success', 'Project created.');
  res.redirect(`/admin/projects/${id}`);
});

async function loadProject(req) {
  return db('projects as p').join('clients as c', 'c.id', 'p.client_id').where('p.id', idParam(req))
    .select('p.*', 'c.name as client_name', 'c.email as client_email', 'c.contact_name as client_contact').first();
}

router.get('/:id', async (req, res, next) => {
  const project = await loadProject(req);
  if (!project) return next();
  const [milestones, updates, links, invoices, tickets] = await Promise.all([
    db('milestones').where({ project_id: project.id }).orderByRaw('CASE WHEN due_date IS NULL THEN 1 ELSE 0 END').orderBy('due_date').orderBy('id'),
    db('project_updates as u').leftJoin('users as us', 'us.id', 'u.user_id').where('u.project_id', project.id).orderBy('u.id', 'desc').select('u.*', 'us.name as user_name'),
    db('project_links').where({ project_id: project.id }).orderBy('id', 'desc'),
    db('invoices').where({ project_id: project.id }).orderBy('id', 'desc'),
    db('tickets').where({ project_id: project.id }).orderBy('id', 'desc').limit(10),
  ]);
  res.render('admin/projects/show', { title: project.name, project, milestones, updates, links, invoices, tickets });
});

router.get('/:id/edit', async (req, res, next) => {
  const project = await db('projects').where({ id: idParam(req) }).first();
  if (!project) return next();
  res.render('admin/projects/form', { title: `Edit ${project.name}`, project, errors: {}, clients: await clientOptions() });
});

router.post('/:id', async (req, res, next) => {
  const project = await db('projects').where({ id: idParam(req) }).first();
  if (!project) return next();
  const { p, errors } = parseProject(req.body);
  if (Object.keys(errors).length) return res.status(422).render('admin/projects/form', { title: `Edit ${project.name}`, project: { ...req.body, id: project.id }, errors, clients: await clientOptions() });
  await db('projects').where({ id: project.id }).update({ ...p, updated_at: nowSql() });
  req.flash('success', 'Project updated.');
  res.redirect(`/admin/projects/${project.id}`);
});

router.post('/:id/status', async (req, res, next) => {
  const project = await db('projects').where({ id: idParam(req) }).first();
  if (!project) return next();
  const status = C.PROJECT_STATUSES.includes(req.body.status) ? req.body.status : project.status;
  const progress = status === 'completed' ? 100 : Math.min(100, Math.max(0, int(req.body.progress, project.progress)));
  await db('projects').where({ id: project.id }).update({ status, progress, updated_at: nowSql() });
  if (status !== project.status) {
    await db('project_updates').insert({
      project_id: project.id, user_id: req.user.id, client_visible: true, created_at: nowSql(),
      body: `Status changed to ${humanize(status)}.`,
    });
  }
  req.flash('success', 'Project status saved.');
  res.redirect(`/admin/projects/${project.id}`);
});

router.post('/:id/milestones', async (req, res, next) => {
  const project = await db('projects').where({ id: idParam(req) }).first();
  if (!project) return next();
  const title = str(req.body.title, 255);
  if (title) {
    await db('milestones').insert({
      project_id: project.id, title, due_date: isDate(req.body.due_date) ? req.body.due_date : null,
      status: 'todo', client_visible: Boolean(req.body.client_visible), created_at: nowSql(),
    });
  }
  res.redirect(`/admin/projects/${project.id}#milestones`);
});

/** Moving milestones also nudges overall progress to the share of milestones done. */
async function syncProgress(projectId) {
  const all = await db('milestones').where({ project_id: projectId }).select('status');
  if (!all.length) return;
  const done = all.filter((m) => m.status === 'done').length;
  await db('projects').where({ id: projectId }).whereNot({ status: 'completed' })
    .update({ progress: Math.round((done / all.length) * 100), updated_at: nowSql() });
}

router.post('/:id/milestones/:mid', async (req, res, next) => {
  const m = await db('milestones').where({ id: idParam(req, 'mid'), project_id: idParam(req) }).first();
  if (!m) return next();
  if (req.body.action === 'delete') {
    await db('milestones').where({ id: m.id }).del();
  } else {
    const status = ['todo', 'doing', 'done'].includes(req.body.status) ? req.body.status : m.status;
    await db('milestones').where({ id: m.id }).update({ status, completed_at: status === 'done' ? (m.completed_at || nowSql()) : null });
    if (status === 'done' && m.status !== 'done' && m.client_visible) {
      await db('project_updates').insert({ project_id: m.project_id, user_id: req.user.id, client_visible: true, body: `Milestone completed: ${m.title}`, created_at: nowSql() });
    }
  }
  await syncProgress(m.project_id);
  res.redirect(`/admin/projects/${m.project_id}#milestones`);
});

router.post('/:id/updates', async (req, res, next) => {
  const project = await loadProject(req);
  if (!project) return next();
  const body = str(req.body.body, 5000);
  if (!body) return res.redirect(`/admin/projects/${project.id}#updates`);
  const visible = Boolean(req.body.client_visible);
  await db('project_updates').insert({ project_id: project.id, user_id: req.user.id, body, client_visible: visible, created_at: nowSql() });
  if (visible && req.body.notify) {
    const recipients = await db('users').where({ client_id: project.client_id, is_active: true }).pluck('email');
    const to = recipients.length ? recipients : [project.client_email].filter(Boolean);
    for (const email of to) {
      await sendMail({
        to: email,
        subject: `Update on ${project.name}`,
        related: ['project', project.id],
        heading: `Project update: ${project.name}`,
        lines: body.split(/\n+/),
        rows: [['Status', humanize(project.status)], ['Progress', `${project.progress}%`]],
        button: { label: 'View in client portal', url: `${config.baseUrl}/portal/projects/${project.id}` },
      });
    }
    req.flash('success', to.length ? `Update posted and emailed to ${to.length} contact(s).` : 'Update posted (client has no email on file).');
  } else {
    req.flash('success', visible ? 'Update posted to the client portal.' : 'Internal note added.');
  }
  res.redirect(`/admin/projects/${project.id}#updates`);
});

router.post('/:id/links', async (req, res, next) => {
  const project = await db('projects').where({ id: idParam(req) }).first();
  if (!project) return next();
  const label = str(req.body.label, 190);
  const url = str(req.body.url, 1000);
  if (label && url && /^https?:\/\//i.test(url)) {
    await db('project_links').insert({ project_id: project.id, label, url, client_visible: Boolean(req.body.client_visible), created_at: nowSql() });
  } else {
    req.flash('error', 'Add a label and a full link starting with https://');
  }
  res.redirect(`/admin/projects/${project.id}#links`);
});

router.post('/:id/links/:lid/delete', async (req, res) => {
  await db('project_links').where({ id: idParam(req, 'lid'), project_id: idParam(req) }).del();
  res.redirect(`/admin/projects/${idParam(req)}#links`);
});

module.exports = router;
