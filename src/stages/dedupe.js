// scripts/dedupe.js — Stage 2 of post-merge pipeline
//
// Reads state/evaluated-jobs.json (PM-fit rated), deduplicates against
// state/job-history.json (cross-run dedup), and produces state/new-jobs.json
// (today's new jobs).
//
// Two passes:
//   1. Cross-source dedup (today only): jobs from different sources with the
//      same fingerprint within the same evaluation batch are merged into one
//      (keeps the highest-scoring one).
//   2. Cross-run dedup: jobs already in state/job-history.json are filtered
//      out. Surviving jobs are appended to history.
//
// Input:  state/evaluated-jobs.json
// Output: state/new-jobs.json (today's new jobs)
// Side effect: state/job-history.json is updated (capped at 5000 jobs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobFingerprint } from '../utils/fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(PROJECT, 'state');
const EVALUATED_FILE = path.join(STATE_DIR, 'evaluated-jobs.json');
const NEW_JOBS_FILE = path.join(STATE_DIR, 'new-jobs.json');
const HISTORY_FILE = path.join(STATE_DIR, 'job-history.json');
const HISTORY_CAP = 5000;

function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    src: 'job-aggregator-v2.dedupe',
    msg,
    ...fields,
  });
  console.log(line);
  fs.appendFileSync(path.join(STATE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 17)}Z.jsonl`), line + '\n');
}

function crossSourceDedup(jobs) {
  // Group by fingerprint, keep the highest-scoring entry (or the first if tied).
  const groups = new Map();
  for (const job of jobs) {
    const fp = jobFingerprint(job);
    const existing = groups.get(fp);
    if (!existing || (job.fitScore || 0) > (existing.fitScore || 0)) {
      groups.set(fp, job);
    }
  }
  const merged = [];
  let crossSourceDupes = 0;
  for (const [, job] of groups) {
    merged.push(job);
  }
  crossSourceDupes = jobs.length - merged.length;
  return { merged, crossSourceDupes };
}

function dedupe() {
  const t0 = Date.now();

  if (!fs.existsSync(EVALUATED_FILE)) {
    log('error', 'evaluated-jobs.json missing', { path: EVALUATED_FILE });
    process.exit(1);
  }
  const evaluated = JSON.parse(fs.readFileSync(EVALUATED_FILE, 'utf8'));
  log('info', 'dedupe start', { evaluated: evaluated.jobs?.length || 0 });

  // 1) Cross-source dedup
  const { merged, crossSourceDupes } = crossSourceDedup(evaluated.jobs || []);
  log('info', 'cross-source dedup', { input: evaluated.jobs?.length, output: merged.length, dupes: crossSourceDupes });

  // 2) Cross-run dedup against history
  const history = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).jobs || []
    : [];
  const historyFps = new Set(history.map(jobFingerprint));
  const newJobs = merged.filter(j => !historyFps.has(jobFingerprint(j)));
  log('info', 'cross-run dedup', { input: merged.length, history: history.length, newJobs: newJobs.length });

  // 3) Write new-jobs.json
  const today = new Date().toISOString().slice(0, 10);
  const newJobsOutput = {
    searchDate: today,
    source: 'job-aggregator-v2',
    evaluatedAt: evaluated.evaluatedAt,
    crossSourceDupes,
    historyBefore: history.length,
    jobs: newJobs,
  };
  fs.writeFileSync(NEW_JOBS_FILE, JSON.stringify(newJobsOutput, null, 2));
  log('info', 'new-jobs.json written', { path: NEW_JOBS_FILE, jobs: newJobs.length });

  // 4) Update history (cap at HISTORY_CAP)
  const updatedHistory = [...history, ...newJobs].slice(-HISTORY_CAP);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ jobs: updatedHistory }, null, 2));
  log('info', 'job-history.json updated', { size: updatedHistory.length, cap: HISTORY_CAP });

  // Summary
  console.log('\n=== DEDUPE SUMMARY ===');
  console.log(JSON.stringify({
    source: 'dedupe',
    evaluatedInput: evaluated.jobs?.length || 0,
    crossSourceDupes,
    afterCrossSource: merged.length,
    crossRunDupes: merged.length - newJobs.length,
    historyBefore: history.length,
    historyAfter: updatedHistory.length,
    newJobs: newJobs.length,
    topSources: Object.fromEntries(
      Object.entries(newJobs.reduce((acc, j) => {
        acc[j.source] = (acc[j.source] || 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1])
    ),
    durationMs: Date.now() - t0,
  }, null, 2));
}

dedupe();
