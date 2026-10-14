'use strict';

const { randomToken, safeEqual } = require('./util');

/** Per-session CSRF token, checked on every state-changing request except APIs and webhooks. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = randomToken(16);
  res.locals.csrfToken = req.session.csrf;
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const exempt = req.path.startsWith('/api/') || req.path.startsWith('/webhooks/');
  if (safe || exempt) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (sent && safeEqual(sent, req.session.csrf)) return next();
  res.status(403).render('public/message', {
    title: 'Session expired', heading: 'This form has expired',
    body: 'Please go back, refresh the page and try again.', link: { href: req.get('referer') || '/', label: 'Go back' },
  });
}

/** One-shot messages that survive a redirect. */
function flash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  if (req.session.flash) req.session.flash = null;
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  next();
}

function notFound(req, res) {
  res.status(404).render('public/message', {
    title: 'Not found', heading: 'Page not found', body: 'The page you were looking for doesn’t exist or has moved.',
    link: { href: '/', label: 'Go home' },
  });
}

module.exports = { csrf, flash, notFound };
