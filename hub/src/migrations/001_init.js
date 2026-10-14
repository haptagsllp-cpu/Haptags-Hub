'use strict';

// Money is stored as integer paise (₹1 = 100). Dates are 'YYYY-MM-DD', datetimes are UTC
// 'YYYY-MM-DD HH:MM:SS' strings so SQLite (dev) and MySQL (prod) behave the same.

exports.up = async function up(knex) {
  await knex.schema.createTable('settings', (t) => {
    t.string('key', 100).primary();
    t.text('value');
  });

  await knex.schema.createTable('sequences', (t) => {
    t.string('name', 60).primary();
    t.integer('value').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('clients', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('contact_name', 190);
    t.string('email', 190);
    t.string('phone', 40);
    t.string('gstin', 20);
    t.text('address');
    t.string('city', 100);
    t.string('state', 100);
    t.string('pincode', 12);
    t.string('country', 80).defaultTo('India');
    t.text('notes');
    t.string('status', 20).notNullable().defaultTo('active');
    t.integer('source_lead_id').unsigned();
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['status']);
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('phone', 40);
    t.string('password_hash', 100);
    t.string('role', 20).notNullable(); // owner | admin | staff | client
    t.integer('client_id').unsigned().references('id').inTable('clients').onDelete('CASCADE');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('token_version').notNullable().defaultTo(1);
    t.string('invite_token_hash', 64);
    t.datetime('invite_expires_at');
    t.datetime('last_login_at');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
  });

  await knex.schema.createTable('leads', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('email', 190);
    t.string('phone', 40);
    t.string('company', 190);
    t.string('website', 255);
    t.string('service', 80);
    t.string('budget', 40);
    t.string('timeline', 40);
    t.text('message');
    t.string('source', 40).notNullable().defaultTo('manual');
    t.string('source_detail', 255);
    t.string('status', 20).notNullable().defaultTo('new');
    t.bigInteger('value_estimate').notNullable().defaultTo(0);
    t.integer('assigned_to').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.date('next_follow_up');
    t.string('lost_reason', 255);
    t.integer('client_id').unsigned().references('id').inTable('clients').onDelete('SET NULL');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['status']);
    t.index(['next_follow_up']);
    t.index(['created_at']);
  });

  await knex.schema.createTable('projects', (t) => {
    t.increments('id');
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.string('name', 190).notNullable();
    t.string('service', 80);
    t.text('description');
    t.string('status', 20).notNullable().defaultTo('planning');
    t.integer('progress').notNullable().defaultTo(0);
    t.date('start_date');
    t.date('due_date');
    t.bigInteger('budget').notNullable().defaultTo(0);
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
    t.index(['status']);
  });

  await knex.schema.createTable('milestones', (t) => {
    t.increments('id');
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('title', 255).notNullable();
    t.date('due_date');
    t.string('status', 20).notNullable().defaultTo('todo'); // todo | doing | done
    t.boolean('client_visible').notNullable().defaultTo(true);
    t.datetime('completed_at');
    t.datetime('created_at');
    t.index(['project_id']);
  });

  await knex.schema.createTable('project_updates', (t) => {
    t.increments('id');
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.text('body').notNullable();
    t.boolean('client_visible').notNullable().defaultTo(true);
    t.datetime('created_at');
    t.index(['project_id']);
  });

  await knex.schema.createTable('project_links', (t) => {
    t.increments('id');
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('label', 190).notNullable();
    t.string('url', 1000).notNullable();
    t.boolean('client_visible').notNullable().defaultTo(true);
    t.datetime('created_at');
    t.index(['project_id']);
  });

  await knex.schema.createTable('quotes', (t) => {
    t.increments('id');
    t.string('number', 30).notNullable().unique();
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.integer('lead_id').unsigned().references('id').inTable('leads').onDelete('SET NULL');
    t.string('title', 255).notNullable();
    t.date('issue_date').notNullable();
    t.date('valid_until');
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | sent | accepted | declined | expired | invoiced
    t.string('tax_mode', 10).notNullable().defaultTo('intra'); // intra | inter | none
    t.decimal('gst_rate', 5, 2).notNullable().defaultTo(18);
    t.bigInteger('subtotal').notNullable().defaultTo(0);
    t.bigInteger('discount').notNullable().defaultTo(0);
    t.bigInteger('cgst').notNullable().defaultTo(0);
    t.bigInteger('sgst').notNullable().defaultTo(0);
    t.bigInteger('igst').notNullable().defaultTo(0);
    t.bigInteger('total').notNullable().defaultTo(0);
    t.text('notes');
    t.text('terms');
    t.string('public_token', 64).notNullable().unique();
    t.datetime('sent_at');
    t.datetime('responded_at');
    t.string('responded_by', 190);
    t.text('client_comment');
    t.integer('invoice_id').unsigned();
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
    t.index(['status']);
  });

  await knex.schema.createTable('retainers', (t) => {
    t.increments('id');
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.integer('project_id').unsigned().references('id').inTable('projects').onDelete('SET NULL');
    t.string('title', 255).notNullable();
    t.string('interval', 20).notNullable().defaultTo('monthly'); // monthly | quarterly | yearly
    t.date('next_invoice_date').notNullable();
    t.date('end_date');
    t.integer('due_days').notNullable().defaultTo(7);
    t.boolean('auto_send').notNullable().defaultTo(true);
    t.string('tax_mode', 10).notNullable().defaultTo('intra');
    t.decimal('gst_rate', 5, 2).notNullable().defaultTo(18);
    t.bigInteger('subtotal').notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('active'); // active | paused | ended
    t.text('notes');
    t.datetime('last_invoiced_at');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['status', 'next_invoice_date']);
  });

  await knex.schema.createTable('invoices', (t) => {
    t.increments('id');
    t.string('number', 30).unique(); // assigned when issued, so GST serials have no gaps
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.integer('project_id').unsigned().references('id').inTable('projects').onDelete('SET NULL');
    t.integer('quote_id').unsigned().references('id').inTable('quotes').onDelete('SET NULL');
    t.integer('retainer_id').unsigned().references('id').inTable('retainers').onDelete('SET NULL');
    t.string('title', 255);
    t.date('issue_date').notNullable();
    t.date('due_date').notNullable();
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | sent | partially_paid | paid | overdue | void
    t.string('tax_mode', 10).notNullable().defaultTo('intra');
    t.decimal('gst_rate', 5, 2).notNullable().defaultTo(18);
    t.string('place_of_supply', 100);
    t.bigInteger('subtotal').notNullable().defaultTo(0);
    t.bigInteger('discount').notNullable().defaultTo(0);
    t.bigInteger('cgst').notNullable().defaultTo(0);
    t.bigInteger('sgst').notNullable().defaultTo(0);
    t.bigInteger('igst').notNullable().defaultTo(0);
    t.bigInteger('total').notNullable().defaultTo(0);
    t.bigInteger('amount_paid').notNullable().defaultTo(0);
    t.text('notes');
    t.text('terms');
    t.string('public_token', 64).notNullable().unique();
    t.datetime('sent_at');
    t.datetime('paid_at');
    t.integer('reminder_stage').notNullable().defaultTo(0);
    t.datetime('last_reminder_at');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
    t.index(['status']);
    t.index(['due_date']);
  });

  await knex.schema.createTable('line_items', (t) => {
    t.increments('id');
    t.string('doc_type', 12).notNullable(); // invoice | quote | retainer
    t.integer('doc_id').unsigned().notNullable();
    t.string('description', 500).notNullable();
    t.string('sac', 12);
    t.decimal('quantity', 12, 2).notNullable().defaultTo(1);
    t.bigInteger('rate').notNullable().defaultTo(0);
    t.bigInteger('amount').notNullable().defaultTo(0);
    t.integer('sort').notNullable().defaultTo(0);
    t.index(['doc_type', 'doc_id']);
  });

  await knex.schema.createTable('payments', (t) => {
    t.increments('id');
    t.integer('invoice_id').unsigned().notNullable().references('id').inTable('invoices').onDelete('CASCADE');
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.bigInteger('amount').notNullable(); // money received
    t.bigInteger('tds').notNullable().defaultTo(0); // tax deducted at source by the client
    t.string('method', 20).notNullable(); // razorpay | upi | bank_transfer | cash | cheque | other
    t.string('reference', 190);
    t.string('status', 20).notNullable().defaultTo('confirmed'); // confirmed | pending | rejected
    t.string('razorpay_payment_id', 64).unique();
    t.string('razorpay_order_id', 64);
    t.date('paid_on').notNullable();
    t.text('notes');
    t.integer('recorded_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.index(['invoice_id']);
    t.index(['status']);
    t.index(['paid_on']);
  });

  await knex.schema.createTable('razorpay_orders', (t) => {
    t.increments('id');
    t.string('order_id', 64).notNullable().unique();
    t.integer('invoice_id').unsigned().notNullable().references('id').inTable('invoices').onDelete('CASCADE');
    t.bigInteger('amount').notNullable();
    t.string('status', 20).notNullable().defaultTo('created');
    t.datetime('created_at');
  });

  await knex.schema.createTable('tickets', (t) => {
    t.increments('id');
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.integer('project_id').unsigned().references('id').inTable('projects').onDelete('SET NULL');
    t.string('subject', 255).notNullable();
    t.string('status', 20).notNullable().defaultTo('open'); // open | awaiting_client | resolved | closed
    t.string('priority', 10).notNullable().defaultTo('normal'); // low | normal | high | urgent
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('last_reply_at');
    t.string('last_reply_by', 10); // client | staff
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
    t.index(['status']);
  });

  await knex.schema.createTable('ticket_messages', (t) => {
    t.increments('id');
    t.integer('ticket_id').unsigned().notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.text('body').notNullable();
    t.boolean('internal').notNullable().defaultTo(false);
    t.datetime('created_at');
    t.index(['ticket_id']);
  });

  await knex.schema.createTable('activities', (t) => {
    t.increments('id');
    t.string('entity_type', 20).notNullable();
    t.integer('entity_id').unsigned().notNullable();
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('kind', 20).notNullable().defaultTo('note'); // note | call | email | status | system
    t.text('body').notNullable();
    t.datetime('created_at');
    t.index(['entity_type', 'entity_id']);
  });

  await knex.schema.createTable('email_log', (t) => {
    t.increments('id');
    t.string('to_email', 190).notNullable();
    t.string('subject', 255).notNullable();
    t.string('status', 20).notNullable(); // sent | failed | not_configured
    t.text('error');
    t.string('related_type', 20);
    t.integer('related_id').unsigned();
    t.datetime('created_at');
    t.index(['created_at']);
  });
};

exports.down = async function down(knex) {
  const tables = [
    'email_log', 'activities', 'ticket_messages', 'tickets', 'razorpay_orders', 'payments', 'line_items',
    'invoices', 'retainers', 'quotes', 'project_links', 'project_updates', 'milestones', 'projects',
    'leads', 'users', 'clients', 'sequences', 'settings',
  ];
  for (const name of tables) await knex.schema.dropTableIfExists(name);
};
