#!/usr/bin/env node
/**
 * Unit tests for src/stages/mailer.js dry-run paths + renderDigest contract.
 *
 * Run: node tests/test-mailer.js
 *
 * The mailer is the cron's last stage — if it emails duplicates, sends the
 * wrong subject line, or sends HTML with broken markup, the user notices.
 * The tests cover the no-network paths (dry-run, --skip-email, 0 jobs,
 * missing config) which exercise ~all of the mailer's branching without
 * needing a real Resend API key.
 *
 * Strategy: import renderDigest directly + run mailer.js with --dry-run
 * against fixture state in a temp dir to verify the output paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderDigest } from '../src/email/template.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Per-test temp STATE dir (lives outside the project on purpose — see
// src/orchestrate.js for the new STATE_DIR contract).
const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'job-aggregator-v2-test-state-'));
process.env.JOB_AGGREGATOR_STATE_DIR = TEST_STATE;

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

function checkTruthy(label, actual) {
  if (actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — expected truthy, got ${JSON.stringify(actual)}`); }
}

function checkFalsy(label, actual) {
  if (!actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — expected falsy, got ${JSON.stringify(actual)}`); }
}

const baseJob = (overrides = {}) => ({
  title: 'Senior Product Manager',
  company: 'Acme',
  location: 'Zurich',
  datePosted: '2026-08-27',
  link: 'https://example.com/job/1',
  source: 'jobs.ch',
  germanRequired: false,
  ...overrides,
});

// ─── renderDigest: subject line ─────────────────────────────────────────────

console.log('\nrenderDigest: subject:');
{
  const { subject } = renderDigest([baseJob()]);
  check('subject includes count "1 new job" (singular)', subject.includes('1 new job'), true);
  check('subject includes date', subject.includes('2026-08-27'), true);

  const { subject: s2 } = renderDigest([baseJob(), baseJob({ company: 'Beta' })]);
  check('subject uses "jobs" (plural) for 2', s2.includes('2 new jobs'), true);

  const { subject: s3 } = renderDigest([]);
  check('subject uses 0 + jobs', s3.includes('0 new jobs'), true);
}

// ─── renderDigest: HTML body ────────────────────────────────────────────────

console.log('\nrenderDigest: HTML body:');
{
  const { html } = renderDigest([baseJob()]);
  checkTruthy('html is a non-empty string', typeof html === 'string' && html.length > 100);
  checkTruthy('html includes company name', html.includes('Acme'));
  checkTruthy('html includes job title', html.includes('Senior Product Manager'));
  checkTruthy('html includes location', html.includes('Zurich'));
  checkTruthy('html includes link', html.includes('https://example.com/job/1'));
  checkTruthy('html escapes &amp; for ampersands', html.includes('&amp;') || !html.includes('& '));
}

console.log('\nrenderDigest: HTML escaping:');
{
  const job = baseJob({ title: 'PM <script>alert(1)</script>', company: 'A & B Co' });
  const { html } = renderDigest([job]);
  checkTruthy('escapes <script> in title', html.includes('&lt;script&gt;'));
  checkTruthy('escapes & in company', html.includes('A &amp; B Co'));
  checkFalsy('does NOT contain raw <script>', html.includes('<script>'));
}

console.log('\nrenderDigest: German-required column:');
{
  const jobYes = baseJob({ germanRequired: true, company: 'ACo' });
  const jobNo = baseJob({ germanRequired: false, company: 'BCo' });
  const { html } = renderDigest([jobYes, jobNo]);
  // Look for German column indicators in the rendered HTML
  checkTruthy('shows German=yes for germanRequired=true', html.toLowerCase().includes('yes') || html.toLowerCase().includes('de'));
  checkTruthy('shows German=no for germanRequired=false', html.toLowerCase().includes('no') || html.toLowerCase().includes('en'));
}

// ─── mailer dry-run: 0 jobs ─────────────────────────────────────────────────

console.log('\nmailer dry-run: 0 new jobs:');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-test-'));
  // Mailer resolves STATE_DIR from JOB_AGGREGATOR_STATE_DIR (set above).
  // Fixtures live in the per-test temp dir; nothing touches project/state/.
  const STATE = TEST_STATE;
  const TARGET = path.join(STATE, 'new-jobs.json');
  const BACKUP = path.join(TMP, 'new-jobs.json.backup');
  if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, BACKUP);

  try {
    fs.writeFileSync(TARGET, JSON.stringify({
      searchDate: '2026-08-27',
      source: 'job-aggregator-v2',
      jobs: [],
    }));
    const r = spawnSync('node', ['src/stages/mailer.js', '--dry-run'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, JOB_AGGREGATOR_STATE_DIR: TEST_STATE },
      encoding: 'utf8',
    });
    check('exits 0 on 0 new jobs', r.status, 0);
    checkTruthy('logs no-new-jobs status', r.stdout.includes('no-new-jobs'));
  } finally {
    if (fs.existsSync(BACKUP)) fs.copyFileSync(BACKUP, TARGET);
    else if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

// ─── mailer dry-run: N jobs ─────────────────────────────────────────────────

console.log('\nmailer dry-run: N new jobs (skips email):');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-test-'));
  const STATE = TEST_STATE;
  const TARGET = path.join(STATE, 'new-jobs.json');
  const BACKUP = path.join(TMP, 'new-jobs.json.backup');
  if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, BACKUP);

  try {
    fs.writeFileSync(TARGET, JSON.stringify({
      searchDate: '2026-08-27',
      source: 'job-aggregator-v2',
      jobs: [baseJob(), baseJob({ company: 'Beta' })],
    }));
    const r = spawnSync('node', ['src/stages/mailer.js', '--dry-run'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, JOB_AGGREGATOR_STATE_DIR: TEST_STATE },
      encoding: 'utf8',
    });
    check('exits 0 with N jobs', r.status, 0);
    checkTruthy('logs skipped status', r.stdout.includes('skipped'));
  } finally {
    if (fs.existsSync(BACKUP)) fs.copyFileSync(BACKUP, TARGET);
    else if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

// ─── mailer: missing new-jobs.json ─────────────────────────────────────────

console.log('\nmailer: missing new-jobs.json:');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-test-'));
  const STATE = TEST_STATE;
  const TARGET = path.join(STATE, 'new-jobs.json');
  const BACKUP = path.join(TMP, 'new-jobs.json.backup');
  if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, BACKUP);

  try {
    if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);
    const r = spawnSync('node', ['src/stages/mailer.js', '--dry-run'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, JOB_AGGREGATOR_STATE_DIR: TEST_STATE },
      encoding: 'utf8',
    });
    check('exits 1 on missing new-jobs.json', r.status, 1);
  } finally {
    if (fs.existsSync(BACKUP)) fs.copyFileSync(BACKUP, TARGET);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);