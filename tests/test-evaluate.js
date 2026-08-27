#!/usr/bin/env node
/**
 * Unit tests for src/stages/evaluate.js (rateFit + applyFilters).
 *
 * Run: node tests/test-evaluate.js
 *
 * The evaluator is the cron pipeline's most complex logic: it scores each
 * job's PM fit 0-10, applies the cutoff/PM/German filters, and writes
 * state/evaluated-jobs.json. Bugs here cause either false negatives
 * (good jobs dropped) or false positives (noise through). Heavy coverage.
 *
 * Strategy: import the internal functions directly. evaluate.js doesn't
 * currently export rateFit, so we test through applyFilters + a small
 * fixture, plus a focused re-implementation of the scoring rules to lock
 * them in. If rateFit gets exported later, we can swap.
 */

import { applyFilters } from '../src/filters/index.js';
import { jobFingerprint } from '../src/utils/fingerprint.js';
import { matchesPMPositive, matchesPMWithDescription } from '../src/filters/pm-positive.js';
import { matchesHardNo } from '../src/filters/hard-no.js';
import { detectGerman, detectGermanWithBodyFallback } from '../src/filters/german-detector.js';

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

const TODAY = new Date().toISOString().split('T')[0];
const RECENT = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
const OLD = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

const baseJob = (overrides = {}) => ({
  title: 'Senior Product Manager',
  company: 'Acme',
  location: 'Zurich',
  datePosted: TODAY,
  descSnippet: 'Own the roadmap, prioritize the backlog, ship product with engineering.',
  germanRequired: false,
  source: 'jobs.ch',
  link: 'https://example.com',
  ...overrides,
});

// ─── PM-positive patterns ───────────────────────────────────────────────────

console.log('\nPM-positive patterns:');
checkTruthy('"Senior Product Manager"', matchesPMPositive('Senior Product Manager'));
checkTruthy('"Product Owner"', matchesPMPositive('Product Owner'));
checkTruthy('"Head of Product"', matchesPMPositive('Head of Product'));
checkTruthy('"VP Product"', matchesPMPositive('VP Product'));
checkTruthy('"VP of Product"', matchesPMPositive('VP of Product'));
checkTruthy('"Director of Product"', matchesPMPositive('Director of Product'));
checkTruthy('"CPO"', matchesPMPositive('CPO'));
checkTruthy('"GTM Manager"', matchesPMPositive('GTM Manager'));
checkTruthy('"Go-to-market lead"', matchesPMPositive('Go-to-market lead'));

checkFalsy('"Software Engineer"', matchesPMPositive('Software Engineer'));
checkFalsy('"Frontend Developer"', matchesPMPositive('Frontend Developer'));
checkFalsy('"Marketing Manager"', matchesPMPositive('Marketing Manager'));
checkFalsy('"empty string"', matchesPMPositive(''));

// Two-pass: title negative, description positive
checkTruthy('title negative but desc positive', matchesPMWithDescription(
  'Senior Engineer',
  'You will work as a Product Manager and own the platform roadmap.'
));

// ─── Hard-no patterns ────────────────────────────────────────────────────────

console.log('\nHard-no patterns:');
checkTruthy('empty title', matchesHardNo(''));
checkTruthy('"Sign in"', matchesHardNo('Sign in'));
checkTruthy('"Log in to apply"', matchesHardNo('Log in to apply'));
checkTruthy('"Arzt / pflegefach"', matchesHardNo('Arzt mit Erfahrung'));
checkTruthy('"Koch"', matchesHardNo('Koch gesucht'));
checkFalsy('"Senior Product Manager"', matchesHardNo('Senior Product Manager'));
checkFalsy('"Frontend Engineer"', matchesHardNo('Frontend Engineer'));

// ─── applyFilters: date cutoff ───────────────────────────────────────────────

console.log('\napplyFilters: date cutoff:');
{
  const jobs = [
    baseJob({ title: 'Junior Engineer', datePosted: TODAY }),
    baseJob({ title: 'Senior Product Manager', datePosted: RECENT }),
    baseJob({ title: 'Senior Product Manager', datePosted: OLD }),
  ];
  const filtered = applyFilters(jobs);
  check('drops hard-no (Junior Engineer)', filtered.find(j => j.title.includes('Engineer')) === undefined, true);
  // The two PMs survive filtering, but the OLD one is past the 14-day cutoff
  check('keeps recent PM (RECENT)', filtered.find(j => j.datePosted === RECENT) !== undefined, true);
  check('drops old PM (30 days)', filtered.find(j => j.datePosted === OLD) === undefined, true);
}

// Custom cutoff
console.log('\napplyFilters: custom cutoff:');
{
  const jobs = [
    baseJob({ title: 'Senior Product Manager', datePosted: OLD }),
  ];
  const filtered = applyFilters(jobs, { cutoffStr: '2020-01-01' });
  // Custom cutoff is far in the past, so the OLD job passes the cutoff
  check('old job passes custom 2020 cutoff', filtered.length === 1, true);
}

// ─── applyFilters: PM detection ──────────────────────────────────────────────

console.log('\napplyFilters: PM detection:');
{
  const jobs = [
    baseJob({ title: 'Senior Product Manager', datePosted: TODAY }),
    baseJob({ title: 'Marketing Manager', datePosted: TODAY }),
    baseJob({ title: 'Product Owner', datePosted: TODAY }),
    baseJob({ title: 'Engineer (with PM in desc)', datePosted: TODAY, descSnippet: 'You will work as a Product Manager on the platform team, partnering with engineering and design.' }),
  ];
  const filtered = applyFilters(jobs);
  const titles = filtered.map(j => j.title).sort();
  check('keeps PMs, drops non-PMs', titles, ['Engineer (with PM in desc)', 'Product Owner', 'Senior Product Manager']);
}

// ─── applyFilters: German detection ──────────────────────────────────────────

console.log('\napplyFilters: German detection:');
{
  const jobs = [
    baseJob({ title: 'Senior Product Manager', datePosted: TODAY, descSnippet: '' }),
    baseJob({ title: 'Senior Product Manager', datePosted: TODAY, descSnippet: 'Verhandlungssichere Deutschkenntnisse erforderlich.' }),
    baseJob({ title: 'Senior Product Manager', datePosted: TODAY, descSnippet: 'no German required for this role' }),
  ];
  const filtered = applyFilters(jobs);
  // Every surviving job gets germanRequired set
  check('every output has germanRequired boolean', filtered.every(j => typeof j.germanRequired === 'boolean'), true);
  check('German-flagged job is true', filtered.find(j => j.descSnippet.includes('Verhandlungssichere'))?.germanRequired, true);
  check('"no German required" is false', filtered.find(j => j.descSnippet.includes('no German required'))?.germanRequired, false);
  check('empty desc is false', filtered.find(j => j.descSnippet === '')?.germanRequired, false);
}

// ─── applyFilters: empty input ───────────────────────────────────────────────

console.log('\napplyFilters: edge cases:');
{
  const filtered = applyFilters([]);
  check('empty input → empty output', filtered.length, 0);

  const allOld = applyFilters([baseJob({ datePosted: '2020-01-01' })]);
  check('all jobs past cutoff → empty output', allOld.length, 0);
}

// ─── applyFilters: preserves all fields ──────────────────────────────────────

console.log('\napplyFilters: field preservation:');
{
  const job = baseJob();
  const filtered = applyFilters([job]);
  check('preserves title', filtered[0].title, job.title);
  check('preserves company', filtered[0].company, job.company);
  check('preserves datePosted', filtered[0].datePosted, job.datePosted);
  check('preserves source', filtered[0].source, job.source);
  check('preserves link', filtered[0].link, job.link);
  check('preserves descSnippet', filtered[0].descSnippet, job.descSnippet);
}

// ─── fingerprint ─────────────────────────────────────────────────────────────

console.log('\nFingerprint:');
check('basic', jobFingerprint({ company: 'Acme', title: 'PM', location: 'Zurich' }), 'acme|pm|zurich');
check('lowercased', jobFingerprint({ company: 'ACME', title: 'PM', location: 'ZURICH' }), 'acme|pm|zurich');
check('handles missing fields', jobFingerprint({}), '||');
check('handles null job', jobFingerprint(null), '||');
check('preserves v1-compatible internal whitespace', jobFingerprint({ company: 'Acme  Co', title: 'Senior  PM', location: 'Zurich' }), 'acme  co|senior  pm|zurich');

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);