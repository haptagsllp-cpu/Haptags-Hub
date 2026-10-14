'use strict';

const { itemsFromForm } = require('../../lib/billing');
const { toPaise } = require('../../lib/money');
const { str, int, isDate } = require('../../lib/util');

/** Shared parsing for the quote / invoice / retainer editor. */
function parseDocForm(body) {
  const items = itemsFromForm(body);
  const rate = Number(body.gst_rate);
  const data = {
    client_id: int(body.client_id, 0),
    project_id: int(body.project_id, 0) || null,
    title: str(body.title, 255),
    tax_mode: ['intra', 'inter', 'none'].includes(body.tax_mode) ? body.tax_mode : 'intra',
    gst_rate: Number.isFinite(rate) && rate >= 0 && rate <= 28 ? rate : 18,
    discount: toPaise(body.discount),
    notes: str(body.notes, 5000),
    terms: str(body.terms, 5000),
    issue_date: isDate(body.issue_date) ? body.issue_date : null,
    due_date: isDate(body.due_date) ? body.due_date : null,
    valid_until: isDate(body.valid_until) ? body.valid_until : null,
  };
  const errors = {};
  if (!data.client_id) errors.client_id = 'Choose a client.';
  if (!items.length) errors.items = 'Add at least one line item.';
  if (items.some((i) => i.rate <= 0)) errors.items = 'Every line item needs a rate.';
  return { data, items, errors };
}

/** Re-populate the editor after a validation error. Parsed values (paise) win over raw input. */
function formState(body, data, items) {
  return { ...body, ...data, items: items.length ? items : [{ description: '', quantity: 1, rate: 0 }] };
}

module.exports = { parseDocForm, formState };
