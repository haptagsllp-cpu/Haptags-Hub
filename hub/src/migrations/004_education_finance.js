'use strict';

// Education: students and interns are clients with segment 'student', so invoices, payments,
// UPI/Razorpay and receipts work unchanged; their invoices get their own number series.
// Finance: imported bank statement lines, categorised for cost analysis.

exports.up = async function up(knex) {
  await knex.schema.createTable('programs', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('kind', 20).notNullable().defaultTo('internship'); // internship | training | course | workshop | certification
    t.bigInteger('fee').notNullable().defaultTo(0); // what the student pays, in paise
    t.boolean('fee_includes_gst').notNullable().defaultTo(true);
    t.string('duration', 60);
    t.text('description');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.datetime('created_at');
    t.datetime('updated_at');
  });

  await knex.schema.alterTable('clients', (t) => {
    t.string('segment', 12).notNullable().defaultTo('business'); // business | student
    t.string('college', 190);
    t.string('course', 120); // degree, branch, year
    t.integer('program_id').unsigned().references('id').inTable('programs').onDelete('SET NULL');
    t.string('batch', 60);
    t.date('start_date');
    t.index(['segment']);
  });

  await knex.schema.alterTable('invoices', (t) => {
    t.string('segment', 12).notNullable().defaultTo('business');
    t.index(['segment']);
  });

  await knex.schema.createTable('bank_imports', (t) => {
    t.increments('id');
    t.string('account', 80).notNullable();
    t.string('filename', 255);
    t.integer('rows_read').notNullable().defaultTo(0);
    t.integer('rows_added').notNullable().defaultTo(0);
    t.integer('rows_duplicate').notNullable().defaultTo(0);
    t.date('from_date');
    t.date('to_date');
    t.integer('uploaded_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
  });

  await knex.schema.createTable('bank_txns', (t) => {
    t.increments('id');
    t.integer('import_id').unsigned().references('id').inTable('bank_imports').onDelete('CASCADE');
    t.string('account', 80).notNullable();
    t.date('txn_date').notNullable();
    t.string('description', 500);
    t.string('reference', 120);
    t.string('counterparty', 120);
    t.bigInteger('debit').notNullable().defaultTo(0); // paise out
    t.bigInteger('credit').notNullable().defaultTo(0); // paise in
    t.bigInteger('balance');
    t.boolean('has_balance').notNullable().defaultTo(false);
    t.integer('seq').notNullable().defaultTo(0); // order within the statement, for opening/closing balances
    t.string('category', 40).notNullable().defaultTo('uncategorized');
    t.string('categorized_by', 10).notNullable().defaultTo('auto'); // auto | rule | user
    t.integer('payment_id').unsigned().references('id').inTable('payments').onDelete('SET NULL');
    t.string('hash', 64).notNullable().unique();
    t.text('notes');
    t.datetime('created_at');
    t.index(['txn_date']);
    t.index(['category']);
  });

  await knex.schema.createTable('bank_rules', (t) => {
    t.increments('id');
    t.string('pattern', 120).notNullable();
    t.string('direction', 6).notNullable().defaultTo('any'); // any | in | out
    t.string('category', 40).notNullable();
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('bank_rules');
  await knex.schema.dropTableIfExists('bank_txns');
  await knex.schema.dropTableIfExists('bank_imports');
  await knex.schema.alterTable('invoices', (t) => { t.dropIndex(['segment']); t.dropColumn('segment'); });
  await knex.schema.alterTable('clients', (t) => {
    t.dropIndex(['segment']);
    t.dropForeign(['program_id']);
    t.dropColumn('segment'); t.dropColumn('college'); t.dropColumn('course'); t.dropColumn('program_id'); t.dropColumn('batch'); t.dropColumn('start_date');
  });
  await knex.schema.dropTableIfExists('programs');
};
