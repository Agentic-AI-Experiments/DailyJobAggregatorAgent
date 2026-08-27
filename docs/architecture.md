# Architecture

## Overview

The DailyJobAggregatorAgent is a single-process Node.js orchestrator that:

1. Spawns one isolated sub-agent per source (parallel, where the source supports it).
2. Each source uses the right method for the site (MCP `browser` for SPAs, raw HTTP for static, Playwright for anti-bot).
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
   │ sub: jobs.ch   │ │ sub: linkedin  │ │ sub: jobwinner │
   │  raw_https     │ │  Playwright    │ │  mcp_browser   │
   └────────┬───────┘ └────────┬───────┘ └────────┬───────┘
            │                  │                  │
            ▼                  ▼                  ▼
   ┌─────────────────────────────────────────────────┐
   │  state/v2-sources/<source>.json (per source)    │
   └─────────────────────────────────────────────────┘
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
                  │  Resend send         │
                  │  (env / secrets.md)  │
                  └──────────────────────┘
```

## MCP architecture (ground truth)

The aggregator uses **one MCP surface** plus raw HTTP / direct Playwright, depending on what each source site requires:

| Source | Method (per `sources/manifest.json`) | What actually runs | MCP required? |
|---|---|---|---|
| jobs.ch | `raw_https` | Built-in `fetch()` / `node:https` against server-rendered HTML | No (static) |
| itjobs.ch | `raw_https` | Built-in `fetch()` + HTML regex | No (static) |
| **jobwinner.ch** | **`mcp_browser`** | **MCP `browser_navigate` / `browser_click` / `browser_type` / `browser_wait_for` / `browser_extract`. Raw HTTP fallback when MCP isn't available (CLI runs).** | **Yes (MCP browser)** |
| linkedin | `playwright_fallback` | `chromium` imported directly from `playwright`. Real Chromium, not via MCP. | No (Playwright direct) |
| jobscout24.ch | `raw_http_batches` | `node:http` for listing + 10-batch detail fetch | No (static) |
| ictcareer.ch | `raw_https` | Built-in `fetch()` + HTML regex (listing only — detail pages are Turnstile-blocked) | No (static) |
| jobup.ch | `raw_https` | Built-in `fetch()` ×5 pages + JSON-LD extraction | No (static) |

### Why only jobwinner.ch uses MCP

Jobwinner.ch is a Nuxt SPA — its search results are rendered client-side via JavaScript. Raw HTTP only sees the SSR shell, which contains ~10 of the 50+ jobs that would be visible after JS execution. To get the full list, we need a real browser. The MCP `browser` tool (Playwright-backed, exposed via OpenClaw) can drive that interaction. Recipe lives in `src/sources/jobwinner-ch.js` as `BROWSER_RECIPE`.

The other 6 sites return server-rendered HTML with all data inline. Forcing them through MCP would add latency without changing the result. Raw HTTP is correct for them.

### MCP browser invocation flow (jobwinner.ch only)

```
cron agent turn (isolated session)
  → orchestrator.js
       → src/sources/jobwinner-ch.js
            → ctx.browser('browser_navigate', { url: SEARCH_URL })
            → ctx.browser('browser_wait_for', { text: 'Accept', timeoutMs: 60000 })
            → ctx.browser('browser_click', { selector: 'button:has-text("Accept")...' })
            → ctx.browser('browser_type', { selector: '#home-search-input', text: 'product manager', submit: true })
            → ctx.browser('browser_wait_for', { selector: 'a[href*="/en/job/"]', timeoutMs: 60000 })
            → ctx.browser('browser_extract', { selector: 'a[href*="/en/job/"]', fields: ['href', 'innerText'] })
       ← jobs[]
  → merge, dedup, email
```

`ctx.browser` is provided by the orchestrator when invoked from a cron agent turn (the `isolated` session has access to the MCP tool). CLI invocations do not — they fall back to the raw HTTP path in the same source module.

### MCP infrastructure setup (already done in `~/.openclaw/openclaw.json`)

- `tools.profile: "coding"`
- `tools.alsoAllow: ["web_fetch", "browser"]`
- `browser.enabled: true`
- `browser.profiles.openclaw: { cdpPort: 18800, color: "#FF4500", headless: true }`

The cron agent turn's `toolsAllow` includes `web_fetch` and `browser` (added automatically by the cron tool when registering an isolated agent turn with the `coding` profile).

---

## Components

### Orchestrator (`src/orchestrate.js`)

- CLI: `node orchestrate.js [--dry-run] [--skip-email] [--source=<name>,<name>]`
- Reads `sources/manifest.json`.
- For each enabled source: dynamically imports `src/sources/<name>.js`.
- Bounded sub-agent return: `{ count, sample: [first 5 jobs] }` — full job list stays in the per-source file.
- Merges, dedups, filters, sends email.
- The orchestrator doesn't spawn sub-sessions itself; each source is a synchronous `import()`. Cron-driven parallelization is achieved by the cron agent turn calling each source module in turn (single Node process keeps the context footprint low).

### Sources

Each source has its own module under `src/sources/<name>.js`. Exports:

```js
export const META = { name, method };
export default async function scrape(ctx) {
  // ctx = { logger, dryRun, sourceName, outputPath, manifest, thisSource, browser? }
  // Returns { count: number, sample: Array<Job> } (sample ≤ 5)
  // Writes full job list to ctx.outputPath
}
```

The orchestrator never inlines source logic — it calls the module directly. This keeps the orchestrator context small and the per-source code independently testable.

### Filters (`src/filters/`)

- `pm-positive.js` — 16 positive PM title patterns.
- `hard-no.js` — 15 universal-not-PM patterns (card bugs + healthcare + trades).
- `german-detector.js` — 3-tier: explicit-phrase regex + body-language fallback (10% stopword ratio or 4/1000 umlaut density).

Copied verbatim from the v1 agent (which has been validated against 100+ real emails). Pattern lists are identical; only the module location is new.

### utils (`src/utils/`)

- `secrets.js` — env-first / / `secrets.md` fallback. Pattern documented in `secrets.md`.
- `fingerprint.js` — `company|title|location` lowercased dedup key.
- `desc-snippet.js` — HTML strip + 4000 char cap (bumped from 1500 in v1 after German-required phrasing got cut off at 1500).
- `enrich.js` — 10-batch parallel HTTP detail-page fetcher.
- `log.js` — structured JSONL logging to `state/run-<timestamp>.jsonl`.

### Email (`src/email/`)

- `send.js` — Resend SDK wrapper. Returns `{ data, error }` per v1 contract; surfaces SDK errors (e.g. unverified FROM domain) instead of swallowing.
- `template.js` — HTML digest with same columns as v1 (title, company, location, posted date, link, German flag, source).

## node_modules resolution

This project shares `node_modules/` with the OpenClaw workspace to avoid duplicating `playwright` (~300 MB) on the constrained laptop.

The script creates a **Windows NTFS junction** at `<project>/node_modules` pointing to `<workspace>/scripts/node_modules`. Node's module resolution then finds `playwright`, `resend`, etc. transparently.

```powershell
# One-time setup on a fresh clone:
New-Item -ItemType Junction -Path "C:\Users\Admin\projects\job-aggregator-v2\node_modules" -Target "C:\Users\Admin\.openclaw\workspace\scripts\node_modules"
```

When forking this repo to a fresh host without a sibling OpenClaw workspace, `npm install` populates `node_modules/` locally and the junction becomes unnecessary (remove it first).

## Cron integration

When registered with the OpenClaw gateway:

- `sessionTarget: "isolated"` — each run gets a fresh session.
- `delivery: { mode: "none" }` — the script sends its own email.
- `enabled: false` — manual trigger from chat (per established v1 pattern; laptop-asleep constraint).
- Schedule: `0 9 * * *` Europe/Zurich (matches v1 cadence for A/B comparison).

Manual trigger: `cron run --id <id> --force`.

Cron payload (prompt given to the agent turn) tells it to run `node src/orchestrate.js` and report a tight summary. The agent turn has `web_fetch` and `browser` in its `toolsAllow` (per the registered cron job) — these are the MCP surfaces that `jobwinner-ch.js` consumes via `ctx.browser`.

## Security boundaries

- `secrets.md` is gitignored + restored from the daily personalisation backup archive (not from git).
- All secrets read via `src/utils/secrets.js` env-first / `secrets.md` fallback.
- No environment-specific paths, gateway tokens, or email addresses appear in any tracked file.
- `.gitignore` is verified before every `git push` via a `git ls-files | grep` pre-push check.
- The recipient + from addresses are runtime parameters never hard-coded.

## State files

- `state/job-history.json` — dedup history, schema: `{ jobs: Job[] }`.
- `state/new-jobs.json` — today's new jobs, schema:
  `{ jobs: Job[], searchDate, source: "job-aggregator-v2" }`.
- `state/v2-sources/<name>.json` — per-source raw output, schema:
  `{ source, scrapedAt, jobs: Job[] }`.
- `state/run-<timestamp>.jsonl` — append-only log of every run.

`state/` is gitignored; restored from the daily backup archive.