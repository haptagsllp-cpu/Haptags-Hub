'use strict';

// Certificates in the Hub. Most come from lms.haptags.com: its verify endpoint and PDF download
// are public, so the Hub pulls them by certificate number (HAP-INT-001 …) and keeps a copy of
// the PDF, filed under the right student. They can also be uploaded by hand.

const config = require('../config');
const { db } = require('../db');
const { nowSql } = require('./util');

const MAX_PDF = 8 * 1024 * 1024;
const day = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function lmsJson(path) {
  if (!config.lms.apiUrl) throw new Error('The LMS address isn’t set (LMS_API_URL).');
  const res = await fetch(`${config.lms.apiUrl}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The LMS answered ${res.status}.`);
  return res.json();
}

/** Certificate details from the LMS, or null if that number doesn't exist there. */
async function fetchFromLms(certificateNo) {
  const data = await lmsJson(`/certificates/verify/${encodeURIComponent(certificateNo)}`);
  return data && data.verified && data.certificate ? data.certificate : null;
}

async function fetchPdf(lmsId) {
  const res = await fetch(`${config.lms.apiUrl}/certificates/${encodeURIComponent(lmsId)}/download?format=pdf`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok || !/pdf/i.test(res.headers.get('content-type') || '')) throw new Error(`Couldn’t download the PDF (LMS answered ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF) throw new Error('The certificate PDF is too large to store.');
  return buf;
}

async function storeFile(name, mime, data, userId) {
  const [id] = await db('files').insert({ name, mime, size: data.length, data, uploaded_by: userId || null, created_at: nowSql() });
  return id;
}

/** The student a certificate belongs to: same name (and college, when both have one). */
async function matchStudent(name, college) {
  const candidates = await db('clients').where({ segment: 'student' }).select('id', 'name', 'college');
  const n = norm(name);
  const same = candidates.filter((c) => norm(c.name) === n);
  if (same.length > 1 && college) return same.find((c) => norm(c.college) === norm(college)) || same[0];
  return same[0] || null;
}

/** Program by name, so a certificate's programme lines up with Education → Programs. */
async function programByName(title) {
  if (!title) return null;
  const all = await db('programs').select('id', 'name');
  return all.find((p) => norm(p.name) === norm(title)) || null;
}

/**
 * Pulls one certificate from the LMS into the Hub (or refreshes it), with its PDF.
 * clientId: the student to file it under; otherwise matched by name, or a student is created.
 * Returns { certificate, created, studentCreated }.
 */
async function importFromLms(certificateNo, { clientId = null, userId = null } = {}) {
  const c = await fetchFromLms(certificateNo);
  if (!c) throw new Error(`No certificate “${certificateNo}” on the LMS.`);
  const existing = await db('certificates').where({ certificate_no: c.certificate_id }).first();
  let studentId = clientId || (existing && existing.client_id) || null;
  let studentCreated = false;
  if (!studentId) {
    const match = await matchStudent(c.recipient_name, c.college_organization);
    if (match) studentId = match.id;
    else {
      let prog = await programByName(c.programme_title);
      if (!prog && c.programme_title) {
        const [pid] = await db('programs').insert({
          name: c.programme_title.slice(0, 190), kind: /intern/i.test(c.programme_title) ? 'internship' : 'course', fee: 0,
          fee_includes_gst: true, duration: c.duration || null, is_active: true, created_at: nowSql(), updated_at: nowSql(),
        });
        prog = { id: pid };
      }
      const now = nowSql();
      [studentId] = await db('clients').insert({
        name: c.recipient_name || 'Student', college: c.college_organization || null, course: null, segment: 'student',
        program_id: prog ? prog.id : null, start_date: day(c.start_date), end_date: day(c.end_date), country: 'India',
        status: 'active', notes: 'Added from an LMS certificate.', created_at: now, updated_at: now,
      });
      studentCreated = true;
    }
  }
  let fileId = existing ? existing.file_id : null;
  if (!fileId && c.id) {
    const pdf = await fetchPdf(c.id);
    fileId = await storeFile(`certificate-${c.certificate_id}.pdf`, 'application/pdf', pdf, userId);
  }
  const row = {
    client_id: studentId, certificate_no: c.certificate_id, lms_id: c.id || null, recipient_name: c.recipient_name || null,
    college: c.college_organization || null, programme: c.programme_title || null, start_date: day(c.start_date), end_date: day(c.end_date),
    issued_on: day(c.issued_on), duration: c.duration || null, grade: c.grade || null, remarks: c.remarks || null,
    verify_url: `${String(c.verification_url_base || 'https://lms.haptags.com/verify?id=')}${c.certificate_id}`,
    file_id: fileId, source: 'lms', synced_at: nowSql(), updated_at: nowSql(),
  };
  let id;
  if (existing) {
    await db('certificates').where({ id: existing.id }).update(row);
    id = existing.id;
  } else {
    [id] = await db('certificates').insert({ ...row, created_at: nowSql() });
  }
  // Fill in course dates on the student if they're blank.
  const st = await db('clients').where({ id: studentId }).first();
  const patch = {};
  if (st && !st.start_date && row.start_date) patch.start_date = row.start_date;
  if (st && !st.end_date && row.end_date) patch.end_date = row.end_date;
  if (st && !st.college && row.college) patch.college = row.college;
  if (Object.keys(patch).length) await db('clients').where({ id: studentId }).update({ ...patch, updated_at: nowSql() });
  return { certificate: await db('certificates').where({ id }).first(), created: !existing, studentCreated };
}

/**
 * Pulls every certificate the LMS has issued that the Hub doesn't have yet. The LMS numbers
 * them PREFIX + 001, 002 …; its settings say the next number, so we know how far to look.
 */
async function syncFromLms({ userId = null } = {}) {
  const settings = await lmsJson('/certificates/settings');
  if (!settings) throw new Error('The LMS certificate settings weren’t found.');
  const prefix = settings.id_prefix || 'HAP-INT-';
  const last = Math.max(0, Number(settings.next_number || 1) - 1);
  const have = new Set(await db('certificates').pluck('certificate_no'));
  const result = { checked: 0, added: 0, studentsCreated: 0, missing: 0, errors: [] };
  for (let n = 1; n <= last; n += 1) {
    const no = `${prefix}${String(n).padStart(3, '0')}`;
    if (have.has(no)) continue;
    result.checked += 1;
    try {
      const r = await importFromLms(no, { userId });
      if (r.created) result.added += 1;
      if (r.studentCreated) result.studentsCreated += 1;
    } catch (err) {
      if (/^No certificate/.test(err.message)) result.missing += 1; // deleted on the LMS
      else result.errors.push(`${no}: ${err.message}`);
    }
  }
  return result;
}

/** A certificate PDF uploaded by hand. */
async function addUploaded(clientId, fields, file, userId) {
  const fileId = file ? await storeFile(file.name, file.mime, file.data, userId) : null;
  const [id] = await db('certificates').insert({ ...fields, client_id: clientId, file_id: fileId, source: 'upload', created_at: nowSql(), updated_at: nowSql() });
  return id;
}

module.exports = { fetchFromLms, importFromLms, syncFromLms, addUploaded, matchStudent, programByName, day };
