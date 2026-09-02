# DailyJobAggregatorAgent

A Switzerland-focused product-manager job aggregator. Scrapes 9 sources in
parallel, filters to PM roles, dedups against history, and emails a daily digest.

> **Status:** Phases 1–11 complete. End-to-end live run delivers ~280 PM jobs per
> invocation. See [`docs/architecture.md`](./docs/architecture.md) and the
> live test results below.

## Quick start (local dev)

```bash
# 1. Clone
git clone git@github.com:Agentic-AI-Experiments/DailyJobAggregatorAgent.git
cd DailyJobAggregatorAgent

# 2. Install (uses sibling OpenClaw workspace's node_modules; see below)
npm install
# OR if you're on the laptop with the v1 OpenClaw workspace, create a junction:
#   New-Item -ItemType Junction -Path node_modules -Target C:\Users\Admin\.openclaw\workspace\scripts\node_modules

# 3. Restore secrets (gitignored)
cp /path/to/backup/secrets.md ./secrets.md

# 4. Dry-run (no email sent)
node src/orchestrate.js --dry-run

# 5. Live run
node src/orchestrate.js
```

## Architecture overview

See [`docs/architecture.md`](./docs/architecture.md) for the full picture.

**TL;DR:** Two execution surfaces, six sources in parallel inside one Node process.

- **`scripts/run-aggregator.js`** — single Node process that spawns 6 parallel child processes (one per raw-HTTP source), then runs the merge step. Wall-clock = slowest source (~66s for LinkedIn), not the sum.
- **MCP `browser` tool** — driven directly by the cron agent turn, before the script runs. Only used for jobwinner.ch (Nuxt SPA, needs JS rendering). Writes `state/v2-sources/jobwinner.ch.json` which the merge step picks up.

**Earlier `sessions_spawn` approach was abandoned** for parallel source scraping (yielded after spawning and never reliably woke back up). The current architecture uses `node:child_process.spawn` inside `scripts/run-aggregator.js` — same wall-clock speedup, deterministic, no wake semantics.

**Three sub-agents handle the post-merge pipeline** (each in `src/stages/`):
1. **`evaluate.js`** — PM-fit rating. Reads `state/v2-sources/*.json`, applies filters, rates each job 0-10, writes `state/evaluated-jobs.json`. Drops jobs scoring < FIT_THRESHOLD (default 5).
2. **`dedupe.js`** — Cross-source + cross-run dedup. Reads `state/evaluated-jobs.json`, dedups against `state/job-history.json`, writes `state/new-jobs.json` + updates history.
3. **`mailer.js`** — Email dispatch. Reads `state/new-jobs.json`, sends via Resend.

Run all three in sequence via `scripts/run-pipeline.js` (one exec), OR spawn them as three separate `sessions_spawn` sub-agents from the cron agent turn. The single-script path is the recommended default — same outcome, deterministic, no sub-agent wake-timing risk.

**Wall-clock:** ~66s for the source-scraping step (LinkedIn bound), then ~1s for the 3-stage pipeline (rating + dedup + email). Total: ~67s per run.

## Sources — what's actually used

| Source | Method (manifest) | What runs in production | Why |
|---|---|---|---|
| jobs.ch | `raw_https` | `node src/orchestrate.js --source=jobs.ch --skip-email` (child process) | Static site, raw HTTP is fastest |
| itjobs.ch | `raw_https` | `node src/orchestrate.js --source=itjobs.ch --skip-email` (child process) | Static site |
| **jobwinner.ch** | **`mcp_browser`** | **MCP `browser` actions (`navigate` / `wait_for` / `act:click` / `act:fill` / `act:evaluate`)** driven by the cron agent turn. Real DOM, real company names. | Nuxt SPA — needs JS rendering. Raw-HTTP fallback extracts the SSR shell but returns fewer fields and `company: "Unknown"` everywhere. |
| linkedin | `playwright_fallback` | `node src/orchestrate.js --source=linkedin --skip-email` (child process). Imports `chromium` from `playwright` directly. | Anti-bot wall blocks MCP too |
| jobscout24.ch | `raw_http_batches` | Child process. `node:http` for listing + 10-batch detail fetch. | Static site |
| ictcareer.ch | `raw_https` | Child process. Listing only (detail = Turnstile-blocked). | Static site |
| jobup.ch | `raw_https` | Child process. 5 pages + JSON-LD. | Static site |
| **hn-whose-hiring** (added 2026-09-02) | `raw_https` | Child process. Pure HTTP via `hn.algolia.com` — discover current month's "Who's hiring?" thread, then fetch PM-tagged comments. No Playwright. | Startup / community segment that traditional boards under-represent. PM density ~6/month. |
| **yc-directory-rss** (added 2026-09-02) | `raw_https` | **STUB — returns empty jobs.** YC Work at a Startup. Algolia + CSRF under the hood. RSS endpoint not yet verified. See `src/sources/yc-directory-rss.js` header. | Highest potential startup-PM density. Implementation blocked on RSS / CSRF verification. |

Deferred sources (Reddit, WAA proper, Sequoia/a16z): see [`docs/SOURCES-TODO.md`](./docs/SOURCES-TODO.md).

The `method` field in `sources/manifest.json` reflects the actual implementation
in `src/sources/<name>.js`. The `methodLegend` block at the top of the manifest
documents the meaning of each value.

## Cron

Registered with the OpenClaw gateway as `job-aggregator-v2`:

- **Cron ID:** `100ecddc-38ce-4327-9a08-428fa7c71ba7`
- **Schedule:** `0 9 * * *` Europe/Zurich
- **`sessionTarget`:** `isolated`
- **`enabled`:** `false` (manual trigger from chat, matching the v1 laptop-asleep pattern)
- **Manual trigger:** `cron run --id 100ecddc-38ce-4327-9a08-428fa7c71ba7 --force`

**Cron agent turn does exactly 2 things, in order:**

1. **Phase B** — drive the MCP browser for jobwinner.ch. Six calls (`navigate` → `wait_for` → `act:click` cookie banner → `act:fill` "product manager" + submit → `wait_for` job links → `act:evaluate` to extract `{href, title, company}`). Then `fs.writeFileSync` to `state/v2-sources/jobwinner.ch.json`.
2. **Phase A+C** — single exec: `cd C:\Users\Admin\projects\job-aggregator-v2 && node scripts/run-aggregator.js`. The script spawns 6 parallel child processes for the raw-HTTP sources, waits for all of them, then runs `node src/orchestrate.js --merge-only` to load all 7 `state/v2-sources/*.json` files, dedup against `state/job-history.json`, and send the email.

The MCP `browser` tool is enabled via `tools.alsoAllow: ["web_fetch", "browser"]`
and a `browser.profiles.openclaw` block in `~/.openclaw/openclaw.json`.

The cron agent's `toolsAllow` includes `browser`, `sessions_spawn` (unused), `web_fetch`, and the standard tool set.

## Security

This is a **public** GitHub repository. **No secrets, credentials, or
environment-specific details are committed.**

- `secrets.md` is gitignored. Restore from the personalisation backup archive.
- No email addresses, API keys, gateway tokens, or paths to OpenClaw internals
  appear in any tracked file.
- All secrets are read at runtime via env-first / `secrets.md` fallback
  (`src/utils/secrets.js`).
- Pre-push verification: `git ls-files | grep -iE 'secret|key|token|credential'`
  returns empty.

If you find a security issue, open a GitHub issue with `[SECURITY]` prefix
or contact the project owner through a non-public channel.

## Live test results (2026-08-27, end-to-end full run)

Per-source timings from the latest production run (single Node script, parallel children):

| Source | Method | Count | Wall-clock (parallel) | Notes |
|---|---|---|---|---|
| jobs.ch | raw_https | 20 | ~2s | Server-rendered HTML, JSON-LD on detail. |
| itjobs.ch | raw_https | 30 | ~1.5s | Server-rendered, regex on `<a class="job-details-link">`. |
| jobwinner.ch | mcp_browser | 9-10 | ~5s (browser recipe) | Nuxt SPA, company names populated. For query "product manager", SPA returns ~10 results — no infinite scroll. |
| linkedin | playwright_fallback | 360 | ~66s (bound) | 6 keywords serial. Slowest source. |
| jobscout24.ch | raw_http_batches | 12-13 | ~1s | Two-phase scrape. |
| ictcareer.ch | raw_https | 27 | ~1.3s | Listing only (detail = Turnstile-blocked). |
| jobup.ch | raw_https | 99 | ~0.7s | 5 pages. |
| **Total raw** | | **~558** | **~66s** | **Wall-clock bound by LinkedIn, not sum.** |
| **PM-filtered** | | **~278** | | Restrictive default — only PM-positive titles. |

End-to-end live email: msgId `438a1b0d-b087-42da-9042-09f175ba44b3`,
278 PM jobs delivered to the configured recipient. (Recipient address lives in
`secrets.md`, not in tracked files.)

Subsequent runs found `newJobs: 0` against history (dedup correctly suppressing).
On 2026-08-27 13:25 with cleared history, all 296 PM-filtered jobs were treated as new → candidate for a single digest.

## Known follow-ups

- **German PM titles missed by the filter.** jobscout24.ch returns "Produktmanager"
  (German) which doesn't match `\bproduct\s+manager\b`. Per Sam's call: job-accuracy
  > flag-accuracy. Not blocking.
- **German umlauts are mojibake in the JSON output** (`BAlach` for `Bällach`,
  etc.). Caused by Node's text-decoding somewhere — needs investigation. Email
  still readable; doesn't break parsing.
- **Linkedin descSnippet is empty** until detail enrichment pass runs. Jobs
  without description text get `germanRequired: false` always. Enrichment is
  next-step.
- **jobs.ch date range goes back ~4 weeks.** Cutoff is 14 days, but jobs.ch
  lists older roles with "4 weeks ago" badges. May want to tune `CUTOFF_DAYS`.
- **jobwinner.ch SPA returns 10 jobs (not the README's earlier "~50+")** for
  the query "product manager". No infinite scroll, no "load more" button. For
  broader queries ("manager", "product") the count is presumably higher.

## Roadmap

- [x] **Phase 1** — Scaffold + gitignore + secrets + README + first commit
- [x] **Phase 2** — 7 source scrapers + per-source dry-run
- [x] **Phase 3** — Orchestrator + filters + utils + email (smoke tests passing)
- [x] **Phase 4** — End-to-end dry-run (catches ctx.manifest contract drift)
- [x] **Phase 5** — Live send test (10 jobs delivered, msgId `0a5c38dc-f9c5-45f0-b433-89895b572d48`)
- [x] **Phase 6** — Cron registration + first push to public GitHub repo
- [x] **Phase 7** — All 7 sources fixed and live-tested (278 PM jobs delivered, msgId `c27ad7f1-48e3-4f05-b934-63bcbb84d28e`)
- [x] **Phase 8** — Manifest + README aligned with actual MCP usage (`method` field per source)
- [x] **Phase 9** — MCP browser end-to-end verified for jobwinner.ch (msgId `438a1b0d-b087-42da-9042-09f175ba44b3`)
- [x] **Phase 10** — `sessions_spawn` abandoned for parallel sources; `scripts/run-aggregator.js` runs 6 raw-HTTP sources as parallel `child_process` instances, then merges via `--merge-only`. Wall-clock bound by slowest source (~66s).
- [x] **Phase 11** — Three sequential sub-agents for post-merge pipeline: `evaluate.js` (PM-fit rating 0-10), `dedupe.js` (cross-source + cross-run), `mailer.js` (email dispatch). Run via `scripts/run-pipeline.js` (one exec) or via 3 `sessions_spawn` sub-agents.

## License

TBD. Suggested: MIT if Sam wants portfolio-friendly, otherwise unlicensed-private.
