'use strict';

// Workspace: team chat, meetings with a built-in video room, and announcements.
// Times follow 001_init: UTC 'YYYY-MM-DD HH:MM:SS' strings.

exports.up = async function up(knex) {
  const mysql = knex.client.config.client === 'mysql2';

  await knex.schema.createTable('files', (t) => {
    t.increments('id');
    t.string('name', 255).notNullable();
    t.string('mime', 120).notNullable();
    t.integer('size').unsigned().notNullable();
    t.specificType('data', mysql ? 'LONGBLOB' : 'BLOB').notNullable();
    t.integer('uploaded_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
  });

  await knex.schema.createTable('channels', (t) => {
    t.increments('id');
    t.string('kind', 12).notNullable(); // channel | dm | group
    t.string('name', 120);
    t.string('topic', 255);
    t.boolean('is_private').notNullable().defaultTo(false);
    t.string('dm_key', 60).unique(); // "3:7" for a 1:1 chat, so there is only ever one
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('last_message_at');
    t.datetime('created_at');
  });

  await knex.schema.createTable('channel_members', (t) => {
    t.increments('id');
    t.integer('channel_id').unsigned().notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('last_read_id').unsigned().notNullable().defaultTo(0);
    t.datetime('joined_at');
    t.unique(['channel_id', 'user_id']);
    t.index(['user_id']);
  });

  await knex.schema.createTable('messages', (t) => {
    t.increments('id');
    t.integer('channel_id').unsigned().notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('kind', 12).notNullable().defaultTo('text'); // text | call | system
    t.text('body');
    t.integer('file_id').unsigned().references('id').inTable('files').onDelete('SET NULL');
    t.integer('meeting_id').unsigned();
    t.datetime('edited_at');
    t.datetime('deleted_at');
    t.datetime('created_at');
    t.index(['channel_id', 'id']);
  });

  await knex.schema.createTable('meetings', (t) => {
    t.increments('id');
    t.string('title', 190).notNullable();
    t.text('agenda');
    t.datetime('starts_at').notNullable();
    t.integer('duration_min').notNullable().defaultTo(30);
    t.string('room_token', 64).notNullable().unique();
    t.boolean('allow_guests').notNullable().defaultTo(true);
    t.string('status', 20).notNullable().defaultTo('scheduled'); // scheduled | cancelled
    t.integer('channel_id').unsigned().references('id').inTable('channels').onDelete('SET NULL');
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('reminded_at');
    t.datetime('started_at');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['starts_at']);
  });

  await knex.schema.createTable('meeting_invitees', (t) => {
    t.increments('id');
    t.integer('meeting_id').unsigned().notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 190);
    t.string('response', 12).notNullable().defaultTo('pending'); // pending | accepted | declined
    t.index(['meeting_id']);
    t.index(['user_id']);
  });

  await knex.schema.createTable('announcements', (t) => {
    t.increments('id');
    t.string('title', 190).notNullable();
    t.text('body').notNullable();
    t.boolean('important').notNullable().defaultTo(false);
    t.boolean('pinned').notNullable().defaultTo(false);
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['created_at']);
  });

  await knex.schema.createTable('announcement_reads', (t) => {
    t.integer('announcement_id').unsigned().notNullable().references('id').inTable('announcements').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.datetime('read_at');
    t.primary(['announcement_id', 'user_id']);
  });
};

exports.down = async function down(knex) {
  for (const name of ['announcement_reads', 'announcements', 'meeting_invitees', 'meetings', 'messages', 'channel_members', 'channels', 'files']) {
    await knex.schema.dropTableIfExists(name);
  }
};
