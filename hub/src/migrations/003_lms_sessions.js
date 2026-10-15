'use strict';

// Daily doubt-clearing sessions for Haptags LMS (lms.haptags.com) students:
// one Hub meeting per course per day, created on demand by the LMS.

exports.up = async function up(knex) {
  await knex.schema.createTable('lms_sessions', (t) => {
    t.increments('id');
    t.string('course_slug', 190).notNullable();
    t.string('session_date', 10).notNullable(); // IST date, YYYY-MM-DD
    t.integer('meeting_id').unsigned().notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    t.datetime('created_at');
    t.unique(['course_slug', 'session_date']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lms_sessions');
};
