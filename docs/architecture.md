# Architecture

## Overview

The DailyJobAggregatorAgent is a single-process Node.js orchestrator that:

1. Spawns one isolated sub-agent per source (parallel).
2. Each sub-agent scrapes its assigned source via MCP (`web_fetch` / `browser`)
   or Playwright fallback.
3. Sub-agents write results to per-source files; the orchestrator merges.
4. Orchestrator applies PM + German-language filters, dedups against history.
5. If new jobs match, sends a digest email via Resend.

```
                  ┌──────────────────────────┐
                  │     orchestrate.js       │
                  │  (single Node process)   │
                  └────────────┬─────────────┘
                               │ reads
                               ▼
                ┌──────────────────────────┐
                │   sources/manifest.json  │
                └──────────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
   │ sub: jobs.ch   │ │ sub: linkedin  │ │ sub: ictcareer │  (7 in parallel)
   │  MCP web_fetch │ │  Playwright    │ │  MCP web_fetch │
   └────────┬───────┘ └────────┬───────┘ └────────┬───────┘
            │                  │                  │
            ▼                  ▼                  ▼
   ┌─────────────────────────────────────────────────┐
   │  state/v2-sources/<source>.json (per source)    │
   └────────────────────────�────────────────────────┘
                            ▼
                  ┌──────────────────────┐
                  │  orchestrator:       │
                  │  • merge             │
                  │  • dedup (history)   │
                  │  • PM filter         │
                  │  • German flag       │
                  │  • date cutoff       │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  state/new-jobs.json │
                  │  state/job-history.json
                  └──────────┬───────────┘
                             ▼
                  �──────────────────────┐
                  │  Resend send         │
                  │  (env / secrets.md)  │
                  └──────────────────────┘
```

## Components

### Orchestrator (`src/orchestrate.js`)

- CLI: `node orchestrate.js [--dry-run] [--skip-email] [--source=<name>,<name>]`
- Reads `sources/manifest.json`.
- For each enabled source: spawns an isolated sub-agent (via `sessions_spawn`).
- Bounded sub-agent return: `{ count, sample: [first 5 jobs], logPath }` —
  full job list stays in the per-source file.
- Merges, dedups, filters, sends email.

### Sources

Each source has its own module under `src/sources/<name>.js`. Exports:

```js
export default async function scrape(ctx) {
  // ctx = { logger, dryRun, sourceName, outputPath, manifest }
  // Returns { count: number, sample: Array<Job> } (sample ≤ 5)
  // Writes full job list to ctx.outputPath
}
```

The orchestrator never inlines source logic — it calls the sub-agent which
calls this module. This keeps the orchestrator context small and the per-source
code independently testable.

### Filters (`src/filters/`)

- `pm-positive.js` — 16 positive PM title patterns.
- `hard-no.js` — 15 universal-not-PM patterns (card bugs + healthcare + trades).
- `german-detector.js` — 3-tier: explicit-phrase regex + body-language fallback
  (10% stopword ratio or 4/1000 umlaut density).

Copied verbatim from the v1 agent (which has been validated against 100+
real emails). Pattern lists are identical; only the module location is new.

### Utils (`src/utils/`)

- `secrets.js` — env-first / `secrets.md` fallback. Pattern documented in
  `secrets.md`.
- `fingerprint.js` — `company|title|location` lowercased dedup key.
- `desc-snippet.js` — HTML strip + 4000 char cap (bumped from 1500 in v1
  after German-required phrasing got cut off at 1500).
- `enrich.js` — 10-batch parallel HTTP detail-page fetcher.
- `log.js` — structured JSONL logging to `state/run-<timestamp>.jsonl`.

### Email (`src/email/`)

- `send.js` — Resend SDK wrapper. Returns `{ data, error }` per v1 contract;
  surfaces SDK errors (e.g. unverified FROM domain) instead of swallowing.
- `template.js` — HTML digest with same columns as v1 (title, company,
  location, posted date, link, German flag, source).

## node_modules resolution

This project shares `node_modules/` with the OpenClaw workspace to avoid
duplicating `playwright` (~300 MB) on the constrained laptop.

The script sets `NODE_PATH` at the top of `orchestrate.js` (resolved via
`__dirname` so it's OS-independent):

```js
const SHARED_NM = path.resolve(__dirname, '..', '..', '..',
  '.openclaw', 'workspace', 'node_modules');
if (fs.existsSync(SHARED_NM)) process.env.NODE_PATH = SHARED_NM;
Module._initPaths();
```

When forking this repo to a fresh host without a sibling OpenClaw workspace,
`npm install` populates `node_modules/` locally and the `NODE_PATH` line
becomes a no-op.

## Cron integration

When registered with the OpenClaw gateway:

- `sessionTarget: "isolated"` — each run gets a fresh session.
- `delivery: { mode: "none" }` — the script sends its own email.
- `enabled: false` — manual trigger from chat (per established v1 pattern;
  laptop-asleep constraint).
- Schedule: `0 9 * * *` Europe/Zurich (matches v1 cadence for A/B comparison).

Manual trigger: `cron run --id <id> --force`.

## Security boundaries

- `secrets.md` is gitignored + restored from the daily personalisation backup
  archive (not from git).
- All secrets read via `src/utils/secrets.js` env-first / `secrets.md` fallback.
- No environment-specific paths, gateway tokens, or email addresses appear in
  any tracked file.
- `.gitignore` is verified before every `git push` via a `git ls-files | grep`
  pre-push check (CI hook + manual).

## State files

- `state/job-history.json` — dedup history, schema: `{ jobs: Job[] }`.
- `state/new-jobs.json` — today's new jobs, schema:
  `{ jobs: Job[], searchDate, source: "job-aggregator-v2" }`.
- `state/v2-sources/<name>.json` — per-source raw output, schema:
  `{ source, scrapedAt, jobs: Job[] }`.
- `state/run-<timestamp>.jsonl` — append-only log of every run.

`state/` is gitignored; restored from the daily backup archive.
