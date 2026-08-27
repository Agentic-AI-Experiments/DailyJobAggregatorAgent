# Architecture

## Overview

The DailyJobAggregatorAgent is a **two-component pipeline**:

1. **`scripts/run-aggregator.js`** — single Node process that spawns 6 parallel child processes (one per raw-HTTP source) + runs the final merge step. Wall-clock = slowest source (~66s for LinkedIn), not the sum of all sources.
2. **MCP `browser` tool** — driven by the cron agent turn directly, before the script runs. Only used for jobwinner.ch (the one Nuxt SPA that needs JS rendering). Writes `state/v2-sources/jobwinner.ch.json` which the merge step picks up.

The agent turn does **not** use `sessions_spawn` anymore. That pattern yielded after spawning and never reliably woke back up to run the merge step. Replaced with `node:child_process` parallelism inside one script — same wall-clock speedup, deterministic, no yield handling.

```
                ┌─────────────────────────────────────┐
                │  cron agent turn (isolated session) │
                │                                     │
                │  Phase B (this turn):               │
                │   • MCP browser call → jobwinner.ch │
                │   • writes state/v2-sources/         │
                │     jobwinner.ch.json               │
                └────────────────┬────────────────────┘
                                 │ exec
                                 ▼
                ┌─────────────────────────────────────┐
                │  scripts/run-aggregator.js          │
                │                                     │
                │  Promise.all 6 parallel children:   │
                │   • node src/orchestrate.js         │
                │       --source=jobs.ch              │
                │       --source=itjobs.ch            │
                │       --source=linkedin             │
                │       --source=jobscout24.ch        │
                │       --source=ictcareer.ch         │
                │       --source=jobup.ch            │
                │                                     │
                │  Then sequentially:                 │
                │   • node src/orchestrate.js         │
                │       --merge-only                  │
                │     (loads all 7 v2-sources files,   │
                │      dedups, sends email)           │
                └─────────────────────────────────────┘
```

## Why this architecture

**Three reasons to use one parallel-script pattern instead of in-process or sessions_spawn patterns:**

1. **Wall-clock matters.** Sequential source scraping takes ~120s wall-clock (LinkedIn 66s + others serially). Parallel child processes cut that to ~66s (LinkedIn bound). The cron trigger fires once daily; saving ~60s per run is a tiny win, but more importantly: when the laptop is slow or Playwright is having a bad day, the slack matters.
2. **`sessions_spawn` + `sessions_yield` doesn't reliably wake cron-scheduled agents back up after sub-agents complete.** The agent yielded after spawning and the cron runtime treated the run as finished. Phase C never executed. Replacing with `child_process.spawn` inside one Node process eliminates the dependency on wake semantics.
3. **Each source writes to its own JSON file independently.** The 7 source scrapers + email step are stateless + idempotent. Running 6 in parallel inside one process produces the same artefacts as 6 sub-agents, but with deterministic timeouts and exit codes instead of sub-agent-for-runtime-fragility.

**The MCP browser recipe for jobwinner.ch still requires the cron agent turn to drive it directly.** Sub-agents can't share the same browser session and CLI invocations don't have `ctx.browser`. The agent turn executes Phase B (6 browser calls, writes JSON), then calls `node scripts/run-aggregator.js` (Phase A + C). One agent turn, two exec steps.

## Per-source routing (ground truth)

The aggregator uses **one MCP surface** (`browser`) plus raw HTTP / direct Playwright, depending on what each site requires:

| Source | Method (per `sources/manifest.json`) | What actually runs | MCP required? |
|---|---|---|---|
| jobs.ch | `raw_https` | `node src/orchestrate.js --source=jobs.ch --skip-email` (child process) | No (static) |
| itjobs.ch | `raw_https` | `node src/orchestrate.js --source=itjobs.ch --skip-email` (child process) | No (static) |
| **jobwinner.ch** | **`mcp_browser`** | **MCP `browser` actions: `navigate` / `wait_for` / `act:click` / `act:fill` / `act:evaluate`**. Driven by the cron agent turn, before `run-aggregator.js` runs. | **Yes (MCP browser)** |
| linkedin | `playwright_fallback` | `chromium` imported from `playwright` inside a child process. Real Chromium, not via MCP. | No (Playwright direct) |
| jobscout24.ch | `raw_http_batches` | `node src/orchestrate.js --source=jobscout24.ch --skip-email` (child process) | No (static) |
| ictcareer.ch | `raw_https` | `node src/orchestrate.js --source=ictcareer.ch --skip-email` (child process). Listing pages only. | No (static) |
| jobup.ch | `raw_https` | `node src/orchestrate.js --source=jobup.ch --skip-email` (child process). 5 pages + JSON-LD. | No (static) |

### Why only jobwinner.ch uses MCP

Jobwinner.ch is a Nuxt SPA — search results are rendered client-side via JavaScript. Raw HTTP against `/en/jobs` returns the SSR shell only, with ~10 jobs (the count for the query "product manager"; the SPA has no infinite scroll, so this is the full result set for that query). The MCP `browser` tool can render the page client-side and extract data from the real DOM where SPA-only fields (company, location) are populated correctly. Recipe lives in `src/sources/jobwinner-ch.js` as `BROWSER_RECIPE`.

The other 6 sites return server-rendered HTML with all data inline. Forcing them through MCP would add latency without changing the result. Raw HTTP is correct for them.

### jobwinner.ch MCP browser recipe

The cron agent turn must execute these 6 calls **directly**, then write `state/v2-sources/jobwinner.ch.json` before invoking `node scripts/run-aggregator.js`:

```js
1. browser({action: 'navigate', url: 'https://www.jobwinner.ch/en/jobs'})
2. browser({action: 'wait_for', text: 'Accept', timeoutMs: 30000})
3. browser({action: 'act', kind: 'click', selector: 'button:has-text("Accept"), button:has-text("Akzeptieren")'})
4. browser({action: 'act', kind: 'fill', selector: '#home-search-input', text: 'product manager', submit: true})
5. browser({action: 'wait_for', selector: 'a[href*="/en/job/"]', timeoutMs: 60000})
6. browser({action: 'act', kind: 'evaluate', fn: `
     Array.from(document.querySelectorAll('li[role="button"]')).map(li => {
       const a = li.querySelector('a[href*="/en/job/"]');
       return a ? {
         href: a.href,
         title: a.textContent.trim(),
         company: (li.querySelector('p[class*="Subtitle"]')?.textContent || '').trim() || 'Unknown'
       } : null;
     }).filter(Boolean)
   `})
```

Then `fs.writeFileSync('state/v2-sources/jobwinner.ch.json', JSON.stringify({ source: 'jobwinner.ch', scrapedAt: <iso>, jobs: [...] }, null, 2))`.

**Reality check.** The SPA returns 10 jobs for the query "product manager" — the same as the SSR shell. For broader queries ("manager", "product") the count would presumably be higher. The README's earlier "MCP returns ~50+" claim was wrong; the truth is just "MCP gets you the real DOM with company names populated".

### MCP infrastructure setup

In `~/.openclaw/openclaw.json`:
- `tools.profile: "coding"`
- `tools.alsoAllow: ["web_fetch", "browser"]`
- `browser.enabled: true`, `browser.headless: true`, `browser.defaultProfile: "openclaw"`
- `browser.profiles.openclaw: { cdpPort: 18800, color: "#FF4500", headless: true }`

The cron agent turn's `toolsAllow` includes `browser` (auto-included when registering an isolated agent turn with the `coding` profile).

## Components

### `scripts/run-aggregator.js` (entrypoint)

- Single Node process. Imports `child_process.spawn` and a `Promise.all` over the 6 raw-HTTP source scrapers.
- Each child process: `node src/orchestrate.js --source=<name> --skip-email` — writes `state/v2-sources/<name>.json` and exits.
- After all 6 children return, runs `node src/orchestrate.js --merge-only` — loads all 7 `state/v2-sources/*.json` files (including jobwinner.ch from Phase B), PM-filter, dedup against `state/job-history.json`, send email.
- Prints `[run-aggregator]` prefixed logs: per-source timing + total wall-clock.

### `src/orchestrate.js` (CLI; called by run-aggregator.js)

Three modes:

| Flag | Behaviour |
|---|---|
| `--source=<name>` | Scrape only that one source. Used by child processes. |
| `--merge-only` | Skip scraping; load whatever's already in `state/v2-sources/*.json`, merge, dedup, email. |
| (no flag, or only `--dry-run` / `--skip-email`) | Full pipeline: scrape every enabled source, merge, dedup, email. |

Reads `sources/manifest.json` for which sources to enable. Loads each `src/sources/<name>.js` via dynamic `import()`.

### Sources (`src/sources/`)

Each source has its own module. Exports:

```js
export const META = { name, method };
export default async function scrape(ctx) {
  // ctx = { logger, dryRun, sourceName, outputPath, manifest, thisSource, browser? }
  // Returns { count: number, sample: Array<Job> } (sample ≤ 5)
  // Writes full job list to ctx.outputPath
}
```

Filters and utilities are shared across sources:

- `src/filters/pm-positive.js` — 16 positive PM title patterns.
- `src/filters/hard-no.js` — 15 universal-not-PM patterns (card bugs, healthcare, trades).
- `src/filters/german-detector.js` — 3-tier: explicit-phrase regex + body-language fallback (10% German stopword ratio or 4/1000 umlaut density).
- `src/utils/secrets.js` — env-first / `secrets.md` fallback.
- `src/utils/fingerprint.js` — `company|title|location` lowercased dedup key.
- `src/utils/desc-snippet.js` — HTML strip + 4000 char cap (bumped from 1500 in v1 because German-required phrases got cut off at 1500).
- `src/utils/enrich.js` — 10-batch parallel HTTP detail-page fetcher.
- `src/utils/log.js` — structured JSONL logging to `state/run-<timestamp>.jsonl`.

Filter patterns copied verbatim from the v1 agent (validated against 100+ real emails).

### Email (`src/email/`)

- `send.js` — Resend SDK wrapper. Returns `{ data, error }`; surfaces SDK errors (e.g. unverified FROM domain) instead of swallowing.
- `template.js` — HTML digest. Columns: title, company, location, posted date, link, German flag, source. Format matches v1 for A/B comparison.

## node_modules resolution

This project shares `node_modules/` with the OpenClaw workspace to avoid duplicating `playwright` (~300 MB) on the constrained laptop.

A **Windows NTFS junction** at `<project>/node_modules` points to `<workspace>/scripts/node_modules`. Node's module resolution finds `playwright`, `resend`, etc. transparently.

```powershell
# One-time setup on a fresh clone:
New-Item -ItemType Junction -Path "C:\Users\Admin\projects\job-aggregator-v2\node_modules" -Target "C:\Users\Admin\.openclaw\workspace\scripts\node_modules"
```

When forking this repo to a fresh host without a sibling OpenClaw workspace, `npm install` populates `node_modules/` locally and the junction becomes unnecessary (remove it first).

## Cron integration

Registered job `100ecddc-38ce-4327-9a08-428fa7c71ba7` (job-aggregator-v2):
- `sessionTarget: "isolated"` — each run is a fresh session.
- `delivery: { mode: "none" }` — the script sends its own email.
- `enabled: false` — manual trigger from chat (per laptop-asleep pattern in MEMORY.md).
- Schedule: `0 9 * * *` Europe/Zurich.

**Cron payload (agent turn prompt), in two steps:**

1. **Drive the MCP browser for jobwinner.ch** (6 calls, write JSON).
2. **Run `node scripts/run-aggregator.js`** (in one exec call — no breaking into multiple steps).

Manual trigger: `cron run --id 100ecddc-38ce-4327-9a08-428fa7c71ba7 --force`.

## Security boundaries

- `secrets.md` is gitignored + restored from the daily personalisation backup archive (not from git).
- All secrets read via `src/utils/secrets.js` env-first / `secrets.md` fallback.
- No environment-specific paths, gateway tokens, or email addresses appear in any tracked file.
- Pre-push secret scan: `git ls-files | grep -iE 'secret|key|token|credential'` — verified clean.
- Recipient + from addresses are runtime parameters never hard-coded.

## State files

- `state/job-history.json` — dedup history. Schema: `{ jobs: Job[] }`. Persists across runs.
- `state/new-jobs.json` — today's new jobs, schema: `{ jobs: Job[], searchDate, source: "job-aggregator-v2" }`.
- `state/v2-sources/<name>.json` — per-source raw output, schema: `{ source, scrapedAt, jobs: Job[] }`. Regenerated each run.
- `state/run-<timestamp>.jsonl` — append-only log of every run. One line per event from `src/utils/log.js`.

`state/` is gitignored; restored from the daily backup archive.
