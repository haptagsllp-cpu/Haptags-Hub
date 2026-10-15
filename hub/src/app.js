'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const config = require('./config');
const { getSettings } = require('./lib/settings');
const { loadUser, requireStaff, requireClient } = require('./lib/auth');
const { csrf, flash, notFound } = require('./lib/middleware');
const viewHelpers = require('./lib/view-helpers');

const app = express();

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com', 'https://*.razorpay.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://*.razorpay.com'],
      frameSrc: ['https://*.razorpay.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/haptags-mark.png'));
app.get('/healthz', async (req, res) => {
  try {
    await require('./db').db.raw('select 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

// Webhooks need the raw body for signature checks, so they mount before the body parsers.
app.use('/webhooks', require('./routes/webhooks'));

app.use(express.urlencoded({ extended: false, limit: '300kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'hub_session',
  keys: [config.sessionSecret],
  maxAge: 14 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
}));

// Wrap views in a layout chosen by folder: admin/*, portal/*, everything else public.
app.use((req, res, next) => {
  const render = res.render.bind(res);
  res.render = (view, locals = {}) => {
    render(view, locals, (err, html) => {
      if (err) return next(err);
      const layout = locals.layout !== undefined ? locals.layout
        : view.startsWith('admin/') ? 'admin' : view.startsWith('portal/') ? 'portal' : 'public';
      if (!layout) return res.send(html);
      render(`layouts/${layout}`, { ...locals, body: html }, (err2, page) => (err2 ? next(err2) : res.send(page)));
    });
  };
  next();
});

app.use(async (req, res, next) => {
  res.locals.settings = await getSettings();
  res.locals.h = viewHelpers;
  res.locals.fullPath = req.path;
  res.locals.searchQuery = req.path === '/admin/search' ? String(req.query.q || '') : '';
  res.locals.baseUrl = config.baseUrl;
  res.locals.title = '';
  next();
});

app.use(loadUser);
app.use(flash);
app.use(csrf);

app.use('/api/rt', require('./routes/realtime'));
app.use(require('./routes/meet'));
app.use(require('./routes/lms'));
app.use(require('./routes/public'));
app.use(require('./routes/auth'));
app.use('/admin', requireStaff, require('./routes/admin'));
app.use('/portal', requireClient, require('./routes/portal'));

app.use(notFound);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.status(status).json({ success: false, error: status === 500 ? 'Server error' : err.message });
  }
  res.status(status).render('public/message', {
    title: 'Something went wrong', heading: 'Something went wrong',
    body: config.isProd ? 'The error has been logged. Please try again.' : err.message,
    link: { href: '/', label: 'Go home' },
  });
});

module.exports = app;
