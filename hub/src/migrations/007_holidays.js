'use strict';

// Holidays on the team calendar: Indian public holidays and observances (synced from Google's
// public "Holidays in India" calendar) plus company holidays added by owners and admins.

exports.up = async function up(knex) {
  await knex.schema.createTable('holidays', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('name', 190).notNullable();
    t.string('kind', 12).notNullable(); // public | observance | company
    t.string('source', 10).notNullable(); // google | company
    t.boolean('tentative').notNullable().defaultTo(false);
    t.string('note', 255);
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.unique(['date', 'name', 'source']);
    t.index(['date']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('holidays');
};
