# DailyJobAggregatorAgent

A Switzerland-focused product-manager job aggregator. Scrapes 7 sources, filters
to PM roles, dedups against history, and emails a daily digest.

> **Status:** Phase 1 scaffold. Not yet wired end-to-end. See `docs/architecture.md`
> for the design and the `Roadmap` section below for build progress.

## Quick start (local dev)

```bash
# 1. Clone
git clone git@github.com:Agentic-AI-Experiments/DailyJobAggregatorAgent.git
cd DailyJobAggregatorAgent

# 2. Install (uses sibling OpenClaw workspace's node_modules; see below)
npm install

# 3. Restore secrets
#    Copy `secrets.md` from your personalisation backup archive into the
#    project root. This file is gitignored. NEVER commit it.
cp /path/to/backup/secrets.md ./secrets.md

# 4. Dry-run (no email sent)
node src/orchestrate.js --dry-run

# 5. Live run
node src/orchestrate.js
```

## node_modules sharing

This project intentionally does not vendor its own `node_modules/`. It runs
against the OpenClaw workspace's node_modules at `C:\Users\Admin\.openclaw\workspace\`
via Node's module resolution + `NODE_PATH`. Documented in `docs/architecture.md`.

Rationale: `playwright` is a ~300 MB install; duplicating it per project is
wasteful on a constrained laptop. If you fork this repo to a fresh host,
`npm install` will populate `node_modules/` locally.

## Architecture

See [`docs/architecture.md`](./docs/architecture.md).

## Security

This is a **public** GitHub repository. **No secrets, credentials, or
environment-specific details are committed.**

- `secrets.md` is gitignored. Restore from the personalisation backup archive.
- No email addresses, API keys, gateway tokens, or paths to OpenClaw internals
  appear in any tracked file.
- All secrets are read at runtime via env-first / `secrets.md` fallback
  (`src/utils/secrets.js`).

If you find a security issue, open a GitHub issue with `[SECURITY]` prefix
or contact the project owner through a non-public channel.

## Sources

| Source | Method | Notes |
|---|---|---|
| jobs.ch | MCP `web_fetch` | JSON-LD on listing |
| itjobs.ch | MCP `web_fetch` | DOM scan |
| jobwinner.ch | MCP `browser` | SPA search |
| LinkedIn | Playwright fallback | Anti-bot wall |
| jobscout24.ch | MCP `web_fetch` + raw HTTP | JSON-LD on detail |
| ictcareer.ch | MCP `web_fetch` listing only | Detail pages Turnstile-blocked |
| jobup.ch | MCP `web_fetch` | Inline JSON-LD |

## Cron

Registered with the OpenClaw gateway as `job-aggregator-v2`:

- **Cron ID:** `100ecddc-38ce-4327-9a08-428fa7c71ba7`
- **Schedule:** `0 9 * * *` Europe/Zurich
- **`sessionTarget`:** `isolated`
- **`enabled`:** `false` (manual trigger from chat, matching the v1 pattern)
- **Manual trigger:** `cron run --id 100ecddc-38ce-4327-9a08-428fa7c71ba7 --force`

The cron agent reads the README, runs `node src/orchestrate.js`, and reports a brief summary. It does not modify files.

## Roadmap

- [x] **Phase 1** — Scaffold + gitignore + secrets + README + first commit
- [x] **Phase 2** — 7 source scrapers via parallel sub-agents + per-source dry-run
- [x] **Phase 3** — Orchestrator + filters + utils + email (3 parallel sub-agents)
- [x] **Phase 4** — End-to-end dry-run (catches ctx.manifest contract drift)
- [x] **Phase 5** — Live send test (jobs.ch, Resend msgId `0a5c38dc-f9c5-45f0-b433-89895b572d48`, 10 jobs delivered)
- [x] **Phase 6** — Cron registration + first push to public GitHub repo

## Live test results (2026-08-27, end-to-end full run)

| Source | Method | Count | Time | Notes |
|---|---|---|---|---|
| jobs.ch | raw `node:https` | 20 | ~2s | Server-rendered HTML, JSON-LD on detail. |
| itjobs.ch | built-in `fetch()` | 30 | ~1.5s | Server-rendered, regex on `<a class="job-details-link">`. |
| jobwinner.ch | raw HTTP fallback (MCP browser recipe in code) | 10 | ~0.6s | SPA — server-rendered SSR shell exposes the top 10 only. |
| linkedin | Playwright subprocess | 360 | ~66s | 6 keywords serial. |
| jobscout24.ch | raw `node:http` (listing) + JSON-LD regex (detail) | 12-13 | ~1s | Two-phase scrape. |
| ictcareer.ch | built-in `fetch()` | 27 | ~1.3s | Listing only (detail = Turnstile-blocked). |
| jobup.ch | built-in `fetch()` + JSON-LD | 99 | ~0.7s | 5 pages. |
| **Total raw** | | **~558** | **~73s** | |
| **PM-filtered** | | **~278** | | Restrictive default — only PM-positive titles. |

End-to-end live email sent: **278 jobs delivered to sam.premium.token@gmail.com, Resend msgId `c27ad7f1-48e3-4f05-b934-63bcbb84d28e`**.

## Known follow-ups

- **German PM titles missed by the filter.** jobscout24.ch returns "Produktmanager" (German) which doesn't match `\bproduct\s+manager\b`. Per Sam's call: job-accuracy > flag-accuracy. Not blocking.
- **MCP architecture gap.** All sources currently use raw HTTP because the standalone CLI doesn't have access to the MCP `web_fetch` / `browser` tools (those are exposed only in agent-turn contexts). The MCP browser recipe for jobwinner.ch is documented in code as a constant; an agent turn can execute it.
- **jobwinner.ch SPA limit.** Only the top 10 server-rendered jobs are reachable via raw HTTP. Full coverage requires the MCP browser path.
- **jobs.ch title fix landed** — the title is now pulled from the `<span class="...lc_4...">` element directly, not from line-split of stripped text.
- **German umlauts are mojibake in the JSON output** (`BA�lach` for `Bällach`, etc.). Caused by Node's text-decoding somewhere — needs investigation. Email still readable; doesn't break parsing.
- **Linkedin descSnippet is empty** until detail enrichment pass runs. Jobs without description text get `germanRequired: false` always. Enrichment is documented as next-step.

## Known follow-ups (not blockers)

- jobs.ch title field is concatenated (multi-field string). Caused by the listing-card `<a>` wrapping multiple `<div>`s without `<br>`s between them. Fix: parse the `<span class="...lc_4">` title element directly instead of splitting card text. Link/company/location/date all parse correctly.
- 6 remaining sources (`itjobs.ch`, `jobwinner.ch`, `linkedin.js`, `jobscout24.ch`, `ictcareer.ch`, `jobup.ch`) have not been live-tested yet. Phase 2/3 only verified `node --check` + per-source dry-run on jobs.ch.
- jobs.ch date range goes back ~4 weeks (cutoff is 14 days, but jobs.ch lists older roles with "4 weeks ago" badges). May want to tune `CUTOFF_DAYS` if too many stale jobs come through.
- `node_modules/` is a Windows junction to `~/.openclaw/workspace/scripts/node_modules/` (the v1 scripts dir). If forking to a fresh host, run `npm install` to replace the junction with a real `node_modules/`.

## License

TBD. Suggested: MIT if Sam wants portfolio-friendly, otherwise unlicensed-private.
