# DailyJobAggregatorAgent

A Switzerland-focused product-manager job aggregator. Scrapes 7 sources, filters
to PM roles, dedups against history, and emails a daily digest.

> **Status:** Phases 1–6 complete. Live end-to-end run sends ~280 PM jobs per
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
**TL;DR:** 6 of 7 sources use raw HTTP (server-rendered HTML, no JS needed).
**jobwinner.ch is the only MCP-driven source** — it's a Nuxt SPA that needs the
MCP `browser` tool to render client-side search results. Raw HTTP against
jobwinner.ch returns ~10 jobs from the SSR shell; MCP browser returns ~50+.

## Sources — what's actually used

| Source | Method (manifest) | What runs | Why |
|---|---|---|---|
| jobs.ch | `raw_https` | Built-in `fetch()` / `node:https` against server-rendered HTML | Static site, raw HTTP is fastest |
| itjobs.ch | `raw_https` | Built-in `fetch()` + HTML regex | Static site |
| **jobwinner.ch** | **`mcp_browser`** | **MCP `browser_navigate` / `browser_click` / `browser_type` / `browser_wait_for` / `browser_extract`** | SPA — needs JS rendering. Raw HTTP fallback returns SSR shell only. |
| linkedin | `playwright_fallback` | `chromium` imported directly from `playwright` | Anti-bot wall blocks MCP too |
| jobscout24.ch | `raw_http_batches` | `node:http` for listing + 10-batch detail fetch | Static site |
| ictcareer.ch | `raw_https` | Built-in `fetch()` + HTML regex | Listing only (detail = Turnstile-blocked) |
| jobup.ch | `raw_https` | Built-in `fetch()` ×5 pages + JSON-LD | Static site |

The `method` field in `sources/manifest.json` reflects the actual implementation
in `src/sources/<name>.js`. The `methodLegend` block at the top of the manifest
documents the meaning of each value.

## Cron

Registered with the OpenClaw gateway as `job-aggregator-v2`:

- **Cron ID:** `100ecddc-38ce-4327-9a08-428fa7c71ba7`
- **Schedule:** `0 9 * * *` Europe/Zurich
- **`sessionTarget`:** `isolated`
- **`enabled`:** `false` (manual trigger from chat, matching the v1 pattern)
- **Manual trigger:** `cron run --id 100ecddc-38ce-4327-9a08-428fa7c71ba7 --force`

The cron agent runs in three phases:
- **Phase A** — runs the orchestrator with `--source=jobs.ch,itjobs.ch,linkedin,jobscout24.ch,ictcareer.ch,jobup.ch --skip-email` to populate `state/v2-sources/*.json` for the 6 raw-HTTP sources
- **Phase B** — runs the `BROWSER_RECIPE` in `src/sources/jobwinner-ch.js` via the MCP `browser` tool to populate `state/v2-sources/jobwinner.ch.json` with SPA-rendered job links
- **Phase C** — runs the orchestrator with no args; merges all 7 source files, dedups against `job-history.json`, sends the email via Resend

The MCP `browser` tool is enabled via `tools.alsoAllow: ["web_fetch", "browser"]`
and a `browser.profiles.openclaw` block in `~/.openclaw/openclaw.json`.

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

| Source | Method | Count | Time | Notes |
|---|---|---|---|---|
| jobs.ch | raw_https | 20 | ~2s | Server-rendered HTML, JSON-LD on detail. |
| itjobs.ch | raw_https | 30 | ~1.5s | Server-rendered, regex on `<a class="job-details-link">`. |
| jobwinner.ch | raw HTTP fallback (MCP browser recipe in code) | 10 | ~0.6s | SPA — server-rendered SSR shell exposes the top 10 only. Full ~50+ requires MCP browser path. |
| linkedin | playwright_fallback | 360 | ~66s | 6 keywords serial. |
| jobscout24.ch | raw_http_batches | 12-13 | ~1s | Two-phase scrape. |
| ictcareer.ch | raw_https | 27 | ~1.3s | Listing only (detail = Turnstile-blocked). |
| jobup.ch | raw_https | 99 | ~0.7s | 5 pages. |
| **Total raw** | | **~558** | **~73s** | |
| **PM-filtered** | | **~278** | | Restrictive default — only PM-positive titles. |

End-to-end live email sent: **278 jobs delivered to the configured recipient**, Resend msgId `c27ad7f1-48e3-4f05-b934-63bcbb84d28e`. (Recipient address lives in `secrets.md`, not in tracked files.)

## Known follow-ups

- **jobwinner.ch via cron agent turn.** The MCP browser recipe runs when the
  cron agent invokes `src/sources/jobwinner-ch.js` via `ctx.browser`. To verify
  the full path works, force-run the cron and check `state/v2-sources/jobwinner.ch.json`
  has ~50+ jobs (vs ~10 from the CLI fallback).
- **German PM titles missed by the filter.** jobscout24.ch returns "Produktmanager"
  (German) which doesn't match `\bproduct\s+manager\b`. Per Sam's call: job-accuracy
  > flag-accuracy. Not blocking.
- **German umlauts are mojibake in the JSON output** (`BA�lach` for `Bällach`,
  etc.). Caused by Node's text-decoding somewhere — needs investigation. Email
  still readable; doesn't break parsing.
- **Linkedin descSnippet is empty** until detail enrichment pass runs. Jobs
  without description text get `germanRequired: false` always. Enrichment is
  next-step.
- **jobs.ch date range goes back ~4 weeks.** Cutoff is 14 days, but jobs.ch
  lists older roles with "4 weeks ago" badges. May want to tune `CUTOFF_DAYS`.

## Roadmap

- [x] **Phase 1** — Scaffold + gitignore + secrets + README + first commit
- [x] **Phase 2** — 7 source scrapers via parallel sub-agents + per-source dry-run
- [x] **Phase 3** — Orchestrator + filters + utils + email (3 parallel sub-agents)
- [x] **Phase 4** — End-to-end dry-run (catches ctx.manifest contract drift)
- [x] **Phase 5** — Live send test (jobs.ch, Resend msgId `0a5c38dc-f9c5-45f0-b433-89895b572d48`, 10 jobs delivered)
- [x] **Phase 6** — Cron registration + first push to public GitHub repo
- [x] **Phase 7** — All 7 sources fixed and live-tested (Resend msgId `c27ad7f1-48e3-4f05-b934-63bcbb84d28e`, 278 PM jobs delivered)
- [x] **Phase 8** — Manifest + README aligned with actual MCP usage (jobwinner.ch = mcp_browser, all others = raw_http*)
- [ ] **Phase 9** — Verify cron agent turn actually exercises jobwinner.ch via MCP browser (next manual trigger)

## License

TBD. Suggested: MIT if Sam wants portfolio-friendly, otherwise unlicensed-private.