'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const { db } = require('../db');
const { nowSql, randomToken, sha256 } = require('./util');

const STAFF_ROLES = ['owner', 'admin', 'staff'];
const ADMIN_ROLES = ['owner', 'admin'];
const INVITE_DAYS = 7;

const hashPassword = (pw) => bcrypt.hash(pw, 11);
const verifyPassword = (pw, hash) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

function passwordProblem(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

async function loadUser(req, res, next) {
  res.locals.user = null;
  const s = req.session;
  if (s && s.uid) {
    const user = await db('users').where({ id: s.uid }).first();
    if (user && user.is_active && user.token_version === s.v) {
      req.user = user;
      res.locals.user = user;
      res.locals.isStaff = STAFF_ROLES.includes(user.role);
      res.locals.isAdmin = ADMIN_ROLES.includes(user.role);
    } else {
      req.session = null;
    }
  }
  next();
}

function signIn(req, user) {
  req.session.uid = user.id;
  req.session.v = user.token_version;
  req.session.csrf = randomToken(16);
}

function homeFor(user) {
  return user && user.role === 'client' ? '/portal' : '/admin';
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      const nextUrl = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?next=${nextUrl}`);
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('public/message', {
        title: 'Not allowed', heading: 'You don’t have access to this page', body: 'Ask an administrator if you need access.',
        link: { href: homeFor(req.user), label: 'Go to my dashboard' },
      });
    }
    next();
  };
}

/** Issues a single-use set-password link (used for invites and password resets). */
async function createPasswordLink(userId) {
  const token = randomToken(24);
  const expires = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await db('users').where({ id: userId }).update({ invite_token_hash: sha256(token), invite_expires_at: expires, updated_at: nowSql() });
  return `${config.baseUrl}/set-password/${token}`;
}

async function findByPasswordToken(token) {
  if (!token || token.length < 20) return null;
  const user = await db('users').where({ invite_token_hash: sha256(token) }).first();
  if (!user || !user.invite_expires_at || user.invite_expires_at < nowSql()) return null;
  return user;
}

module.exports = {
  STAFF_ROLES, ADMIN_ROLES, INVITE_DAYS, hashPassword, verifyPassword, passwordProblem, loadUser, signIn, homeFor,
  requireStaff: requireRole(STAFF_ROLES),
  requireAdmin: requireRole(ADMIN_ROLES),
  requireClient: requireRole(['client']),
  createPasswordLink, findByPasswordToken,
};
