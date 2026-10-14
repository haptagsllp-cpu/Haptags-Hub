'use strict';

const { db } = require('../db');
const { nowSql } = require('./util');

async function logActivity(entityType, entityId, userId, kind, body, trx = db) {
  await trx('activities').insert({
    entity_type: entityType,
    entity_id: entityId,
    user_id: userId || null,
    kind,
    body: String(body).slice(0, 5000),
    created_at: nowSql(),
  });
}

async function getActivities(entityType, entityId) {
  return db('activities as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .where({ 'a.entity_type': entityType, 'a.entity_id': entityId })
    .orderBy('a.id', 'desc')
    .select('a.*', 'u.name as user_name');
}

module.exports = { logActivity, getActivities };
