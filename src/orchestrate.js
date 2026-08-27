#!/usr/bin/env node
// orchestrate.js
// DailyJobAggregatorAgent — main entry.
//
// Loads sources/manifest.json, runs each source scraper in sequence,
// applies filters, dedups against history, and emails the digest.
//
// Usage:
//   node src/orchestrate.js [--dry-run] [--skip-email] [--source=<name>,<name>]
//
// All secrets are read at runtime via env / secrets.md fallback.
// No secrets, no email addresses, no OpenClaw paths are baked into this file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jobFingerprint } from './utils/fingerprint.js';
import { buildDescSnippet } from './utils/desc-snippet.js';
import { applyFilters } from './filters/index.js';
import { secretFromEnvOrFile } from './utils/secrets.js';
import { renderDigest } from './email/template.js';
import { sendDigest } from './email/send.js';
import { log } from './utils/log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'sources', 'manifest.json');
const HISTORY_FILE = path.join(STATE_DIR, 'job-history.json');
const NEW_JOBS_FILE = path.join(STATE_DIR, 'new-jobs.json');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const SKIP_EMAIL = args.has('--skip-email');
const SKIP_HISTORY = args.has('--skip-history');  // for parallel child processes: do not pollute history
const MERGE_ONLY = args.has('--merge-only');
const sourceArg = [...args].find(a => a.startsWith('--source='));
const SOURCE_FILTER = sourceArg
  ? new Set(sourceArg.slice('--source='.length).split(',').map(s => s.trim()))
  : null;

// ─── Config (env-only; no secrets in tracked files) ───────────────────────────
const CUTOFF_DAYS = parseInt(process.env.CUTOFF_DAYS || '14', 10);
const DEDUP_WINDOW_DAYS = parseInt(process.env.DEDUP_WINDOW_DAYS || '30', 10);
const TODAY = new Date();
const CUTOFF_STR = new Date(TODAY.getTime() - CUTOFF_DAYS * 86400000).toISOString().split('T')[0];
const DEDUP_STR = new Date(TODAY.getTime() - DEDUP_WINDOW_DAYS * 86400000).toISOString().split('T')[0];

// ─── State I/O ────────────────────────────────────────────────────────────────
function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, 'v2-sources'), { recursive: true });
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      const jobs = Array.isArray(data.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      return jobs.filter(j => j.datePosted >= DEDUP_STR);
    }
  } catch (e) { log('warn', 'loadHistory failed', { error: e.message }); }
  return [];
}

function saveHistory(jobs) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ jobs }, null, 2));
}

function saveNewJobs(jobs) {
  fs.writeFileSync(NEW_JOBS_FILE, JSON.stringify({
    jobs,
    searchDate: new Date().toISOString().split('T')[0],
    source: 'job-aggregator-v2',
  }, null, 2));
}

// ─── Source loader ────────────────────────────────────────────────────────────
async function loadManifest() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return raw.sources.filter(s => s.enabled !== false);
}

async function loadSourceModule(manifestEntry) {
  const moduleUrl = pathToFileURL(path.join(PROJECT_ROOT, manifestEntry.module)).href;
  const mod = await import(moduleUrl);
  return mod.default;
}

// ─── Per-source scrape ────────────────────────────────────────────────────────
async function scrapeSource(manifestEntry) {
  const fullManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const ctx = {
    logger: log,
    dryRun: DRY_RUN,
    sourceName: manifestEntry.name,
    outputPath: path.join(STATE_DIR, 'v2-sources', `${manifestEntry.name}.json`),
    // Source modules expect ctx.manifest to be the full manifest file
    // (with a .sources array) so they can look up their own entry by name.
    // This matches the contract the source sub-agents were given.
    manifest: fullManifest,
    thisSource: manifestEntry,        // the single entry for convenience
  };
  log('info', 'source start', { source: manifestEntry.name, method: manifestEntry.method });
  const startedAt = Date.now();
  try {
    const scraper = await loadSourceModule(manifestEntry);
    const result = await scraper(ctx);
    log('info', 'source done', {
      source: manifestEntry.name,
      count: result.count,
      ms: Date.now() - startedAt,
    });
    return { ok: true, count: result.count, sample: result.sample || [] };
  } catch (e) {
    log('error', 'source failed', { source: manifestEntry.name, error: e.message });
    return { ok: false, count: 0, sample: [], error: e.message };
  }
}

// ─── Per-source raw-job load (post-scrape, before filter) ─────────────────────
function loadSourceJobs(sourceName) {
  const file = path.join(STATE_DIR, 'v2-sources', `${sourceName}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch { return []; }
}

// ─── Filter + dedup ───────────────────────────────────────────────────────────

function dedupAgainstHistory(jobs, historyFingerprints) {
  const seen = new Set(historyFingerprints);
  const out = [];
  const newFingerprints = [];
  for (const j of jobs) {
    const fp = jobFingerprint(j);
    if (seen.has(fp)) continue;
    out.push(j);
    newFingerprints.push(fp);
  }
  return { newJobs: out, newFingerprints };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  ensureStateDir();
  log('info', 'orchestrator start', { dryRun: DRY_RUN, skipEmail: SKIP_EMAIL, sourceFilter: SOURCE_FILTER ? [...SOURCE_FILTER] : null });

  const manifest = await loadManifest();
  const sources = SOURCE_FILTER
    ? manifest.filter(s => SOURCE_FILTER.has(s.name))
    : manifest;

  if (sources.length === 0) {
    log('warn', 'no sources to run', { availableInManifest: manifest.map(s => s.name) });
    return;
  }

  const scrapeResults = [];

  // 1) Run each source in parallel (Promise.all over independent scrapers).
  // Each source writes to its own state/v2-sources/<name>.json; the orchestrator
  // loads them all at the end. Parallel execution means LinkedIn's ~66s doesn't
  // block the other 6 sources from finishing in ~3-5s. Wall-clock bound = slowest
  // source, not the sum.
  //
  // --merge-only: skip scraping entirely; load whatever is already in
  // state/v2-sources/*.json and proceed straight to merge/dedup/email. This is
  // how the cron agent uses the orchestrator after spawning 7 parallel sub-agents
  // (one per source) that each ran `node src/orchestrate.js --source=<name>
  // --skip-email` independently.
  if (!MERGE_ONLY) {
    await Promise.all(
      sources.map(async (entry) => {
        const r = await scrapeSource(entry);
        scrapeResults.push({ name: entry.name, ...r });
      })
    );
  } else {
    log('info', 'merge-only mode: skipping scrape, reading state/v2-sources/*.json');
    scrapeResults.push(...sources.map((entry) => {
      const file = path.join(STATE_DIR, 'v2-sources', `${entry.name}.json`);
      if (!fs.existsSync(file)) return { name: entry.name, ok: false, count: 0, sample: [], error: 'no source file' };
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { name: entry.name, ok: true, count: (data.jobs || []).length, sample: (data.jobs || []).slice(0, 5) };
      } catch (e) {
        return { name: entry.name, ok: false, count: 0, sample: [], error: e.message };
      }
    }));
  }

  // 2) Load raw jobs from per-source files
  const allRaw = [];
  for (const r of scrapeResults) {
    if (r.ok) allRaw.push(...loadSourceJobs(r.name));
  }
  log('info', 'raw jobs loaded', { total: allRaw.length });

  // 3) PM filter + German flag
  const filtered = applyFilters(allRaw);
  log('info', 'filtered jobs', { count: filtered.length });

  // 4) Dedup against history
  const history = loadHistory();
  const historyFps = history.map(jobFingerprint);
  const { newJobs, newFingerprints } = dedupAgainstHistory(filtered, historyFps);
  log('info', 'new jobs', { count: newJobs.length });

  // 5) Persist
  if (!SKIP_HISTORY) {
    saveNewJobs(newJobs);
    const updatedHistory = [...history, ...newJobs].slice(-5000); // cap to last 5000
    saveHistory(updatedHistory);
  } else {
    log('info', 'skipping history write (single-source mode)');
  }

  // 6) Email (skip in --dry-run / --skip-email / when 0 new jobs)
  if (newJobs.length === 0) {
    log('info', 'no new jobs to email');
  } else if (DRY_RUN || SKIP_EMAIL) {
    log('info', 'email skipped (dry-run or --skip-email)', { jobs: newJobs.length });
  } else {
    const apiKey = secretFromEnvOrFile('RESEND_API_KEY');
    const from = process.env.EMAIL_FROM || secretFromEnvOrFile('EMAIL_FROM');
    const to = process.env.EMAIL_RECIPIENT || secretFromEnvOrFile('EMAIL_RECIPIENT');

    if (!apiKey || !from || !to) {
      log('error', 'email config missing', { hasApiKey: !!apiKey, hasFrom: !!from, hasTo: !!to });
    } else {
      const { subject, html } = renderDigest(newJobs);
      const res = await sendDigest({ subject, html, to, from, apiKey });
      if (res.error) {
        log('error', 'email send failed', { name: res.error.name, message: res.error.message });
      } else {
        log('info', 'email sent', { msgId: res.data?.id, recipient: to, jobCount: newJobs.length });
      }
    }
  }

  // 7) Summary
  const summary = {
    sources: scrapeResults.map(r => ({ name: r.name, ok: r.ok, count: r.count, error: r.error })),
    raw: allRaw.length,
    pmFiltered: filtered.length,
    newJobs: newJobs.length,
    cutoffStr: CUTOFF_STR,
  };
  log('info', 'orchestrator done', summary);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => {
  log('error', 'orchestrator crashed', { error: e.message, stack: e.stack });
  process.exit(1);
});
