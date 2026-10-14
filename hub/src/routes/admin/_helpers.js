'use strict';

const { db } = require('../../db');
const { int } = require('../../lib/util');

const PER_PAGE = 30;

/** Offset pagination without a COUNT: fetch one extra row to know whether there's a next page. */
async function paginate(query, req, perPage = PER_PAGE) {
  const page = Math.max(1, int(req.query.page, 1));
  const rows = await query.limit(perPage + 1).offset((page - 1) * perPage);
  return { rows: rows.slice(0, perPage), page, hasNext: rows.length > perPage, hasPrev: page > 1 };
}

async function clientOptions() {
  return db('clients').where({ status: 'active' }).orderBy('name').select('id', 'name', 'state', 'country', 'gstin', 'email');
}

const idParam = (req, key = 'id') => int(req.params[key], 0);

/** Keep the current filters when redirecting back to a list. */
function back(req, fallback) {
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.pathname.startsWith('/admin')) return u.pathname + u.search;
    } catch { /* ignore */ }
  }
  return fallback;
}

module.exports = { paginate, clientOptions, idParam, back, PER_PAGE };
