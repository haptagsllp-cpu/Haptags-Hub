'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const {
  verifyPassword, hashPassword, passwordProblem, signIn, homeFor, createPasswordLink, findByPasswordToken,
} = require('../lib/auth');
const { sendMail } = require('../lib/mailer');
const { nowSql, str } = require('../lib/util');

const router = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : null);

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Sign in', email: '', next: safeNext(req.query.next) || '', error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (str(req.body.email, 190) || '').toLowerCase();
  const user = email ? await db('users').where({ email }).first() : null;
  const ok = user && user.is_active && await verifyPassword(req.body.password || '', user.password_hash);
  if (!ok) {
    return res.status(401).render('auth/login', {
      title: 'Sign in', email, next: safeNext(req.body.next) || '', error: 'That email and password don’t match an active account.',
    });
  }
  await db('users').where({ id: user.id }).update({ last_login_at: nowSql() });
  signIn(req, user);
  const target = safeNext(req.body.next);
  const allowed = target && (user.role === 'client' ? target.startsWith('/portal') || target.startsWith('/i/') || target.startsWith('/q/') : true);
  res.redirect(allowed ? target : homeFor(user));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/forgot', (req, res) => {
  res.render('auth/forgot', { title: 'Reset password', sent: false });
});

router.post('/forgot', loginLimiter, async (req, res) => {
  const email = (str(req.body.email, 190) || '').toLowerCase();
  const user = email ? await db('users').where({ email, is_active: true }).first() : null;
  if (user) {
    const link = await createPasswordLink(user.id);
    await sendMail({
      to: user.email,
      subject: 'Reset your Haptags Hub password',
      related: ['user', user.id],
      heading: 'Reset your password',
      lines: [`Hi ${user.name},`, 'Use the button below to choose a new password. The link works for 7 days.', 'If you didn’t ask for this, you can ignore this email.'],
      button: { label: 'Choose a new password', url: link },
    });
  }
  res.render('auth/forgot', { title: 'Reset password', sent: true });
});

router.get('/set-password/:token', async (req, res) => {
  const user = await findByPasswordToken(req.params.token);
  if (!user) {
    return res.status(410).render('public/message', {
      title: 'Link expired', heading: 'This link has expired',
      body: 'Set-password links work for 7 days and only once. Request a new one below.', link: { href: '/forgot', label: 'Send a new link' },
    });
  }
  res.render('auth/set-password', { title: 'Choose a password', user, token: req.params.token, error: null });
});

router.post('/set-password/:token', loginLimiter, async (req, res) => {
  const user = await findByPasswordToken(req.params.token);
  if (!user) return res.redirect(`/set-password/${encodeURIComponent(req.params.token)}`);
  const pw = req.body.password || '';
  const problem = passwordProblem(pw) || (pw !== req.body.confirm ? 'The two passwords don’t match.' : null);
  if (problem) return res.status(422).render('auth/set-password', { title: 'Choose a password', user, token: req.params.token, error: problem });
  await db('users').where({ id: user.id }).update({
    password_hash: await hashPassword(pw),
    invite_token_hash: null,
    invite_expires_at: null,
    token_version: user.token_version + 1,
    last_login_at: nowSql(),
    updated_at: nowSql(),
  });
  signIn(req, { ...user, token_version: user.token_version + 1 });
  req.flash('success', 'Your password is set. Welcome!');
  res.redirect(homeFor(user));
});

module.exports = router;
