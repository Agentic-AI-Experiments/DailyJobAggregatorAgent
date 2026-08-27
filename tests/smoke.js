#!/usr/bin/env node
// smoke.js — per-source smoke test for the v2 aggregator.
//
// Usage:
//   node tests/smoke.js                     # dry-run all enabled sources
//   node tests/smoke.js --source=jobs.ch    # single source
//   node tests/smoke.js --source=jobs.ch,itjobs.ch  # subset
//
// This is a thin wrapper around orchestrate.js with --dry-run + --source filter
// applied. Useful for verifying a single scraper after editing it.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const sourceArg = [...args].find(a => a.startsWith('--source='));
const sourceFilter = sourceArg ? sourceArg.slice('--source='.length) : null;

const cmdArgs = ['src/orchestrate.js', '--dry-run'];
if (sourceFilter) cmdArgs.push(`--source=${sourceFilter}`);

console.log(`Smoke test: node ${cmdArgs.join(' ')}`);
console.log(`Project: ${PROJECT_ROOT}\n`);

const result = spawnSync(process.execPath, cmdArgs, {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

process.exit(result.status ?? 1);
