'use strict';

const fs = require('fs');
const path = require('path');
const knex = require('knex');
const config = require('./config');

if (config.db.client === 'better-sqlite3') {
  fs.mkdirSync(path.dirname(config.db.connection.filename), { recursive: true });
}

const db = knex(config.db);

async function migrate() {
  if (config.db.client === 'better-sqlite3') {
    await db.raw('PRAGMA foreign_keys = ON');
    await db.raw('PRAGMA journal_mode = WAL');
  }
  await db.migrate.latest({ directory: path.join(__dirname, 'migrations'), loadExtensions: ['.js'] });
}

module.exports = { db, migrate };
