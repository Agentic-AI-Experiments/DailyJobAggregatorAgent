#!/usr/bin/env node
// scripts/run-pipeline.js — Master orchestrator for the 3-stage post-merge pipeline.
//
// Runs the three sub-agents sequentially:
//   1. evaluate.js     — PM-fit rating (uses PM filters + scoring)
//   2. dedupe.js       — cross-source + cross-run dedup against history
//   3. mailer.js       — sends email via Resend
//
// Each stage runs as its own Node child process (deterministic, no sessions_spawn
// timing issues). The cron agent turn calls this script in a single exec step.
//
// Inputs (assumed already populated by scripts/run-aggregator.js):
//   - state/v2-sources/*.json     (raw per-source jobs)
//   - state/job-history.json      (existing dedup history, or empty)
//
// Outputs:
//   - state/evaluated-jobs.json   (after stage 1)
//   - state/new-jobs.json         (after stage 2)
//   - email sent                  (after stage 3)
//   - state/job-history.json      (updated after stage 2)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

function runStage(stageName, scriptPath, args = []) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    console.log(`\n[pipeline] ─── ${stageName}: ${scriptPath} ${args.join(' ')} ───\n`);
    const child = spawn('node', [scriptPath, ...args], {
      cwd: PROJECT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      const ms = Date.now() - t0;
      console.log(`\n[pipeline] ${stageName} exit=${code} in ${ms}ms\n`);
      resolve({ stage: stageName, exitCode: code, ms });
    });
    child.on('error', (err) => {
      console.error(`[pipeline] ${stageName} spawn error:`, err.message);
      resolve({ stage: stageName, exitCode: 1, ms: Date.now() - t0, error: err.message });
    });
  });
}

async function main() {
  const t0 = Date.now();
  const stages = [
    { name: 'evaluate', script: 'src/stages/evaluate.js' },
    { name: 'dedupe', script: 'src/stages/dedupe.js' },
    { name: 'mailer', script: 'src/stages/mailer.js', passFlags: true },
  ];

  const results = [];
  for (const stage of stages) {
    const args = [];
    if (stage.passFlags) {
      if (process.argv.includes('--dry-run')) args.push('--dry-run');
      if (process.argv.includes('--skip-email')) args.push('--skip-email');
    }
    const result = await runStage(stage.name, stage.script, args);
    results.push(result);
    if (result.exitCode !== 0) {
      console.error(`[pipeline] FAILURE in ${stage.name} — halting pipeline.`);
      console.log('\n[pipeline] SUMMARY:', JSON.stringify({ status: 'failed', stoppedAt: stage.name, results }, null, 2));
      process.exit(1);
    }
  }

  console.log('\n=== PIPELINE SUMMARY ===');
  console.log(JSON.stringify({
    status: 'ok',
    durationMs: Date.now() - t0,
    stages: results,
  }, null, 2));
}

main().catch((e) => {
  console.error('[pipeline] FATAL:', e);
  process.exit(1);
});
