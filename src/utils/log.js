// src/utils/log.js
// Structured JSONL logger: one line per call, console + append-only file.
//
// v1 source: scripts/daily-job-search.js, around L100 per audit.
//   - log(level, msg, extra) writes to console + appendFileSync(LOG_FILE).
//   - LOG_FILE was at memory/daily-job-search.log.
//
// v2 deviation (per architecture.md §State files):
//   - Path is <project-root>/state/run-<timestamp>.jsonl, derived from __dirname
//     so it's OS-independent. Run-scoped (timestamp embedded in the filename)
//     so a fresh run never grows the previous run's file unbounded.
//   - The file write is best-effort. A read-only state/ directory, a full
//     disk, or a permission error MUST NOT crash the orchestrator. The
//     console line is the canonical output; the file is the audit trail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// src/utils/log.js → ../../ = project root, then state/run-<ts>.jsonl.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');

// One file per process. Computed lazily so the timestamp reflects the first
// log() call, not module load (which may happen well before the run starts).
let currentRunFile = null;

function runFile() {
  if (currentRunFile) return currentRunFile;
  // 2026-08-27T11:36:00.123Z → 20260827T113600123Z (filesystem-safe, sortable).
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  currentRunFile = path.join(STATE_DIR, `run-${ts}.jsonl`);
  return currentRunFile;
}

export function log(level, msg, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    src: 'job-aggregator-v2',
    msg,
    ...extra,
  });
  // Console first — never gated on file write success.
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(runFile(), line + '\n');
  } catch {
    // Best-effort. Swallow ENOENT/EACCES/ENOSPC so a broken state/ dir
    // can't take down the run. The console line is the source of truth.
  }
}
