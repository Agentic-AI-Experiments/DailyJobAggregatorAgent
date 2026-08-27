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

## Roadmap

- [x] **Phase 1** — Scaffold + gitignore + secrets + README + first commit
- [ ] **Phase 2** — 7 source scrapers via parallel sub-agents + per-source dry-run
- [ ] **Phase 3** — Orchestrator + filters + utils + email (3 parallel sub-agents)
- [ ] **Phase 4** — End-to-end dry-run
- [ ] **Phase 5** — Live send test (1 source, then full)
- [ ] **Phase 6** — Cron registration + first push + memory updates

## License

TBD. Suggested: MIT if Sam wants portfolio-friendly, otherwise unlicensed-private.
