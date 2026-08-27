#!/usr/bin/env node
// scripts/run-aggregator.js
//
// Single-process orchestrator that runs the 6 raw-HTTP sources in PARALLEL via
// Promise.all + dedicated node child-processes (not sessions_spawn). jobwinner.ch
// is handled by the calling agent via MCP browser; this script reads the resulting
// state/v2-sources/jobwinner.ch.json if it exists.
//
// Outputs: per-source state/v2-sources/<name>.json files, then runs
// `node src/orchestrate.js --merge-only` to dedup + email.
//
// This is the SINGLE call the cron agent makes. One shell invocation,
// parallel child processes, no sessions_spawn needed.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const RAW_HTTPS_SOURCES = [
  'jobs.ch',
  'itjobs.ch',
  'linkedin',
  'jobscout24.ch',
  'ictcareer.ch',
  'jobup.ch',
];

function scrapeOne(source) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      'node',
      ['src/orchestrate.js', `--source=${source}`, '--skip-email', '--skip-history'],
      { cwd: PROJECT, stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      resolve({ source, ms: Date.now() - startedAt, exitCode: code });
    });
    child.on('error', (err) => {
      console.error(`[${source}] spawn error:`, err.message);
      resolve({ source, ms: Date.now() - startedAt, exitCode: 1, error: err.message });
    });
  });
}

async function main() {
  const t0 = Date.now();
  console.log(`[run-aggregator] Starting ${RAW_HTTPS_SOURCES.length} parallel source scrapers...`);
  const results = await Promise.all(RAW_HTTPS_SOURCES.map(scrapeOne));
  for (const r of results) {
    console.log(`[run-aggregator] ${r.source}: exit=${r.exitCode} in ${r.ms}ms`);
  }
  const ok = results.filter(r => r.exitCode === 0).length;
  console.log(`[run-aggregator] ${ok}/${RAW_HTTPS_SOURCES.length} sources succeeded (${Date.now() - t0}ms wall-clock)`);

  // Optional: if the calling agent did Phase B (jobwinner.ch via MCP browser),
  // its state file should already exist.
  const jwFile = path.join(PROJECT, 'state', 'v2-sources', 'jobwinner.ch.json');
  console.log(`[run-aggregator] jobwinner.ch state file: ${existsSync(jwFile) ? 'present' : 'absent'}`);

  console.log(`[run-aggregator] Running merge-only step...`);
  if (process.argv.includes('--skip-merge')) {
    console.log(`[run-aggregator] --skip-merge: skipping merge step`);
    console.log(`[run-aggregator] Done in ${Date.now() - t0}ms wall-clock total (no merge).`);
    return;
  }
  const mergeStartedAt = Date.now();
  await new Promise((resolve) => {
    const child = spawn(
      'node',
      ['src/orchestrate.js', '--merge-only'],
      { cwd: PROJECT, stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      console.log(`[run-aggregator] merge step exit=${code} in ${Date.now() - mergeStartedAt}ms`);
      resolve();
    });
  });

  console.log(`[run-aggregator] Done in ${Date.now() - t0}ms wall-clock total.`);
}

main().catch((e) => {
  console.error('[run-aggregator] FATAL:', e);
  process.exit(1);
});
