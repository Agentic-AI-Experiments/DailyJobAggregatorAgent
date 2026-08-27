#!/usr/bin/env node
// backup.js
// One-shot backup script for the v2 project.
//
// Run by the laptop's daily personalisation-backup cron (email-personalization-backup.js)
// after the workspace's glob list is extended to include this project root.
//
// What gets backed up (UNENCRYPTED, into the daily tar.gz that the cron sends):
//   - All .md files in the project root
//   - sources/, src/, docs/, tests/ directories (code + config)
//   - scripts/ (this backup script lives there)
//   - secrets.md (the API key file — required for a fresh restore)
//
// What is EXCLUDED from the backup (matches .gitignore for consistency):
//   - node_modules/, state/, logs/, *.tar.gz, *.log, *.bak, .git/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Backup target list ───────────────────────────────────────────────────────
// Keep this in sync with email-personalization-backup.js glob patterns.
const INCLUDE_GLOBS = [
  '*.md',
  'package.json',
  'sources/**/*.json',
  'src/**/*.js',
  'docs/**/*.md',
  'tests/**/*.js',
  'scripts/**/*.js',
  'secrets.md', // CRITICAL — restore path; never gitignored in backup even though gitignored
];

const EXCLUDE_PATTERNS = [
  /node_modules/,
  /^state\//,
  /^logs\//,
  /\.log$/,
  /\.tar\.gz$/,
  /\.bak$/,
  /^\.git\//,
  /^\.tmp\//,
  /^\.openclaw\//,
  /package-lock\.json$/,
];

// ─── Manifest writer (the daily-backup cron consumes this) ────────────────────
//
// The existing daily personalisation backup iterates a hard-coded list of file
// paths and bundles them into a tar.gz. This script outputs a manifest file
// the cron can read, listing every file under this project that should be in
// tomorrow's archive.
//
// If the cron is configured to glob instead of read this manifest, this
// script becomes optional — the cron will still back up the right files
// via the glob pattern in email-personalization-backup.js.

function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (EXCLUDE_PATTERNS.some(rx => rx.test(rel))) continue;
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function main() {
  const allFiles = walk(PROJECT_ROOT);
  // Include secrets.md explicitly even if the walker missed it (it should be at root)
  if (fs.existsSync(path.join(PROJECT_ROOT, 'secrets.md'))) {
    const rel = 'secrets.md';
    if (!allFiles.includes(rel)) allFiles.unshift(rel);
  }

  const manifestPath = path.join(PROJECT_ROOT, 'state', 'backup-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    files: allFiles.sort(),
  }, null, 2));

  console.log(`Backup manifest: ${allFiles.length} files`);
  console.log(`Wrote: ${manifestPath}`);
  for (const f of allFiles.slice(0, 5)) console.log(`  + ${f}`);
  if (allFiles.length > 5) console.log(`  ... and ${allFiles.length - 5} more`);
}

main();
