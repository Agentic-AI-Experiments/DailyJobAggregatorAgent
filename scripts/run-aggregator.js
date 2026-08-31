#!/usr/bin/env node
// scripts/run-aggregator.js
//
// One-call entry point for the cron agent turn. Runs ALL sources (including
// jobwinner.ch via raw-HTTP fallback) as parallel child processes, then chains
// into scripts/run-pipeline.js (evaluate → dedupe → mailer). One shell call.
//
// jobwinner.ch is a Nuxt SPA. The MCP browser recipe in src/sources/jobwinner-ch.js
// returns ~50 jobs but requires 6 browser() tool calls from inside an agent turn.
// The raw-HTTP fallback (default path here) uses Nuxt's SSR shell and returns ~10
// jobs — fewer, but enough for dedup. Pass --browser-jobwinner from a cron agent
// turn that has the MCP browser tool in toolsAllow to upgrade to the SPA path.
//
// Usage (from cron agent or CLI):
//   node scripts/run-aggregator.js                 # full pipeline: scrape + evaluate + dedupe + mail
//   node scripts/run-aggregator.js --skip-merge    # scrape only, leave state/v2-sources/*.json
//   node scripts/run-aggregator.js --dry-run       # scrape + evaluate + dedupe, no email
//   node scripts/run-aggregator.js --skip-scrape   # merge-only: read existing state/v2-sources/*.json
//   node scripts/run-aggregator.js --browser-jobwinner  # upgrade jobwinner.ch to MCP browser path
//
// DO NOT call scripts that don't exist (e.g. scripts/scrape-jobwinner.cjs).
// This file is the ONE script the cron agent should invoke. If you need
// jobwinner.ch via MCP browser, call scripts/jobwinner-mcp.js from inside an
// agent turn where the `browser` MCP tool is available — it prints a recipe.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

// Sources that work over raw HTTP / Playwright / nuxt SSR without any MCP.
// jobwinner.ch is included by default via its raw-HTTP fallback (~10 jobs).
const RAW_HTTPS_SOURCES = [
  'jobs.ch',
  'itjobs.ch',
  'linkedin',
  'jobscout24.ch',
  'ictcareer.ch',
  'jobup.ch',
  'jobwinner.ch',
];

const ARGS = new Set(process.argv.slice(2));
const SKIP_MERGE = ARGS.has('--skip-merge');
const SKIP_SCRAPE = ARGS.has('--skip-scrape');
const DRY_RUN = ARGS.has('--dry-run');
// --browser-jobwinner: opt-in to MCP browser path for jobwinner.ch.
// Only valid from an agent turn where the `browser` MCP tool is available;
// the agent must run scripts/jobwinner-mcp.js's recipe itself (this script
// cannot call MCP tools). See scripts/jobwinner-mcp.js.
const BROWSER_JOBWINNER = ARGS.has('--browser-jobwinner');

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

function runChild(scriptRelPath, extraArgs = []) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      'node',
      [scriptRelPath, ...extraArgs],
      { cwd: PROJECT, stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      resolve({ script: scriptRelPath, ms: Date.now() - startedAt, exitCode: code });
    });
    child.on('error', (err) => {
      console.error(`[${scriptRelPath}] spawn error:`, err.message);
      resolve({ script: scriptRelPath, ms: Date.now() - startedAt, exitCode: 1, error: err.message });
    });
  });
}

async function main() {
  const t0 = Date.now();
  const sourcesToScrape = BROWSER_JOBWINNER
    ? RAW_HTTPS_SOURCES.filter((s) => s !== 'jobwinner.ch')
    : RAW_HTTPS_SOURCES;

  if (SKIP_SCRAPE) {
    console.log(`[run-aggregator] --skip-scrape: reading existing state/v2-sources/*.json`);
  } else {
    console.log(`[run-aggregator] Starting ${sourcesToScrape.length} parallel source scrapers${BROWSER_JOBWINNER ? ' (jobwinner.ch via MCP browser — must be invoked separately by agent)' : ''}...`);
    const results = await Promise.all(sourcesToScrape.map(scrapeOne));
    for (const r of results) {
      console.log(`[run-aggregator] ${r.source}: exit=${r.exitCode} in ${r.ms}ms`);
    }
    const ok = results.filter(r => r.exitCode === 0).length;
    console.log(`[run-aggregator] ${ok}/${sourcesToScrape.length} sources succeeded (${Date.now() - t0}ms wall-clock)`);
  }

  // If BROWSER_JOBWINNER was requested, the calling agent should have already
  // run scripts/jobwinner-mcp.js's recipe and written state/v2-sources/jobwinner.ch.json.
  // We just verify it's present; if not, we run the raw-HTTP fallback so the
  // pipeline still completes.
  const jwFile = path.join(PROJECT, 'state', 'v2-sources', 'jobwinner.ch.json');
  console.log(`[run-aggregator] jobwinner.ch state file: ${existsSync(jwFile) ? 'present' : 'absent'}`);
  if (BROWSER_JOBWINNER && !existsSync(jwFile)) {
    console.warn(`[run-aggregator] --browser-jobwinner requested but no jobwinner.ch.json found — running raw-HTTP fallback so the pipeline can complete.`);
    const fallback = await scrapeOne('jobwinner.ch');
    console.log(`[run-aggregator] jobwinner.ch (raw-HTTP fallback): exit=${fallback.exitCode} in ${fallback.ms}ms`);
  }

  if (SKIP_MERGE) {
    console.log(`[run-aggregator] --skip-merge: skipping pipeline step`);
    console.log(`[run-aggregator] Done in ${Date.now() - t0}ms wall-clock total (no merge).`);
    return;
  }

  console.log(`[run-aggregator] Running pipeline (evaluate → dedupe → mailer)...`);
  const pipelineArgs = DRY_RUN ? ['--dry-run'] : [];
  const pipeline = await runChild('scripts/run-pipeline.js', pipelineArgs);
  console.log(`[run-aggregator] pipeline: exit=${pipeline.exitCode} in ${pipeline.ms}ms`);
  if (pipeline.exitCode !== 0) {
    console.error(`[run-aggregator] pipeline failed with exit=${pipeline.exitCode}`);
    process.exit(pipeline.exitCode ?? 1);
  }

  console.log(`[run-aggregator] Done in ${Date.now() - t0}ms wall-clock total.`);
}

main().catch((e) => {
  console.error('[run-aggregator] FATAL:', e);
  process.exit(1);
});
