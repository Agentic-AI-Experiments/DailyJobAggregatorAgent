// scripts/mailer.js — Stage 3 of post-merge pipeline
//
// Reads state/new-jobs.json, renders the HTML digest, and sends the email via
// Resend. Pure dispatch — no filtering, no scoring.
//
// Input:  state/new-jobs.json
// Output: email sent (or skipped if 0 new jobs / --dry-run)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretFromEnvOrFile } from '../utils/secrets.js';
import { renderDigest } from '../email/template.js';
import { sendDigest } from '../email/send.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..', '..');
// Mirrors src/orchestrate.js: STATE_DIR is project-external by default,
// overrideable via JOB_AGGREGATOR_STATE_DIR.
const STATE_DIR = process.env.JOB_AGGREGATOR_STATE_DIR
  ? path.resolve(process.env.JOB_AGGREGATOR_STATE_DIR)
  : path.resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'job-aggregator-v2-state');
const NEW_JOBS_FILE = path.join(STATE_DIR, 'new-jobs.json');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_EMAIL = process.argv.includes('--skip-email');

function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    src: 'job-aggregator-v2.mailer',
    msg,
    ...fields,
  });
  console.log(line);
  fs.appendFileSync(path.join(STATE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 17)}Z.jsonl`), line + '\n');
}

async function send() {
  const t0 = Date.now();
  log('info', 'mailer start', { dryRun: DRY_RUN, skipEmail: SKIP_EMAIL });

  if (!fs.existsSync(NEW_JOBS_FILE)) {
    log('error', 'new-jobs.json missing', { path: NEW_JOBS_FILE });
    process.exit(1);
  }
  const newJobsDoc = JSON.parse(fs.readFileSync(NEW_JOBS_FILE, 'utf8'));
  const newJobs = newJobsDoc.jobs || [];
  log('info', 'loaded new-jobs.json', { jobs: newJobs.length, searchDate: newJobsDoc.searchDate });

  if (newJobs.length === 0) {
    log('info', 'no new jobs to email');
    console.log('\n=== MAILER SUMMARY ===');
    console.log(JSON.stringify({ source: 'mailer', newJobs: 0, status: 'no-new-jobs', durationMs: Date.now() - t0 }, null, 2));
    return;
  }

  if (DRY_RUN || SKIP_EMAIL) {
    log('info', 'email skipped (dry-run or --skip-email)', { jobs: newJobs.length });
    console.log('\n=== MAILER SUMMARY ===');
    console.log(JSON.stringify({ source: 'mailer', newJobs: newJobs.length, status: 'skipped', durationMs: Date.now() - t0 }, null, 2));
    return;
  }

  const apiKey = secretFromEnvOrFile('RESEND_API_KEY');
  const from = process.env.EMAIL_FROM || secretFromEnvOrFile('EMAIL_FROM');
  const to = process.env.EMAIL_RECIPIENT || secretFromEnvOrFile('EMAIL_RECIPIENT');

  if (!apiKey || !from || !to) {
    log('error', 'email config missing', { hasApiKey: !!apiKey, hasFrom: !!from, hasTo: !!to });
    console.log('\n=== MAILER SUMMARY ===');
    console.log(JSON.stringify({ source: 'mailer', status: 'config-missing', durationMs: Date.now() - t0 }, null, 2));
    process.exit(1);
  }

  const { subject, html } = renderDigest(newJobs);
  const res = await sendDigest({ subject, html, to, from, apiKey });

  if (res.error) {
    log('error', 'email send failed', { name: res.error.name, message: res.error.message });
    console.log('\n=== MAILER SUMMARY ===');
    console.log(JSON.stringify({ source: 'mailer', status: 'send-failed', error: res.error.message, durationMs: Date.now() - t0 }, null, 2));
    process.exit(1);
  }

  log('info', 'email sent', { msgId: res.data?.id, recipient: to, jobCount: newJobs.length });
  console.log('\n=== MAILER SUMMARY ===');
  console.log(JSON.stringify({
    source: 'mailer',
    newJobs: newJobs.length,
    msgId: res.data?.id,
    recipient: to,
    status: 'sent',
    durationMs: Date.now() - t0,
  }, null, 2));
}

send().catch((e) => {
  log('error', 'mailer crashed', { error: e.message, stack: e.stack });
  process.exit(1);
});
