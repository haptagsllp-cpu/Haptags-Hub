'use strict';

// Certificates for students and interns: pulled from lms.haptags.com or uploaded by hand.
// Note: no foreign-key columns are added to existing tables (SQLite rebuilds the table to do it,
// and the drop cascades into invoices). New tables can reference others safely.

exports.up = async function up(knex) {
  await knex.schema.createTable('certificates', (t) => {
    t.increments('id');
    t.integer('client_id').unsigned().references('id').inTable('clients').onDelete('CASCADE');
    t.string('certificate_no', 60).notNullable().unique(); // e.g. HAP-INT-001
    t.string('lms_id', 30); // the LMS record id, for its PDF
    t.string('recipient_name', 200);
    t.string('college', 200);
    t.string('programme', 200);
    t.date('start_date');
    t.date('end_date');
    t.date('issued_on');
    t.string('duration', 60);
    t.string('grade', 100);
    t.text('remarks');
    t.string('verify_url', 300);
    t.integer('file_id').unsigned().references('id').inTable('files').onDelete('SET NULL');
    t.string('source', 10).notNullable().defaultTo('upload'); // lms | upload
    t.datetime('synced_at');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
  });

  await knex.schema.alterTable('clients', (t) => {
    t.date('end_date'); // when the internship/course ends
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('certificates');
  await knex.schema.alterTable('clients', (t) => { t.dropColumn('end_date'); });
};
