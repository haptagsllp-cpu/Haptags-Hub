'use strict';

// Partners of the LLP, and which partner brought in each client or student, so revenue can be
// credited to whoever originated it.

exports.up = async function up(knex) {
  await knex.schema.createTable('partners', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('dpin', 20); // Designated Partner Identification Number (DIN/DPIN)
    t.string('designation', 60).notNullable().defaultTo('Designated Partner');
    t.string('status', 12).notNullable().defaultTo('active'); // active | resigned
    t.date('joined_on');
    t.date('left_on');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL'); // their Hub login, if any
    t.text('notes');
    t.datetime('created_at');
    t.datetime('updated_at');
  });

  // No foreign key here: on SQLite, adding one rebuilds the clients table, and dropping the old
  // copy cascades into invoices and payments. MySQL adds the column in place either way.
  await knex.schema.alterTable('clients', (t) => {
    t.integer('partner_id').unsigned();
    t.index(['partner_id']);
  });

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await knex('partners').insert([
    { name: 'Reddivari Harshavardhan Reddy', dpin: '11342035', status: 'active', created_at: now, updated_at: now },
    { name: 'Abhay Anantha', dpin: '11342034', status: 'active', notes: 'Left earlier and rejoined.', created_at: now, updated_at: now },
    { name: 'Bhavesh Reddy Pagireddy', dpin: '11379873', status: 'resigned', created_at: now, updated_at: now },
  ]);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('clients', (t) => {
    t.dropIndex(['partner_id']);
    t.dropColumn('partner_id');
  });
  await knex.schema.dropTableIfExists('partners');
};
