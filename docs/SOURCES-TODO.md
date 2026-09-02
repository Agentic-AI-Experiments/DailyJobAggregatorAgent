# Sources TODO — long-tail job boards not yet integrated

**Created 2026-09-02** as part of the v2 source-expansion pass.

This doc captures reverse-engineering notes + anti-bot observations for sources
we tried to add but couldn't ship today. Future-me (or future-Sam) can pick
these up without re-doing the investigation.

## Status

| Source | v2 status | Reason deferred |
|---|---|---|
| `hn-whose-hiring` | ✅ **SHIPPED** | Pure HTTP via Algolia. `src/sources/hn-whose-hiring.js`. |
| `yc-directory-rss` | ⚠️ **STUB** | WAA homepage 200 but `/companies` 302→login. Algolia + CSRF. RSS not yet verified. See `src/sources/yc-directory-rss.js` header. |
| Reddit (`r/forhire`, `r/switzerland`, `r/zurich`, `r/RemoteJobs`) | ❌ **DEFERRED** | All anonymous + Playwright paths blocked (303→login, RSS 403). Would need authenticated session. |
| YC Work at a Startup (proper JSON API) | ❌ **DEFERRED** | Same as `yc-directory-rss` stub above. CSRF + session cookie required. |
| Sequoia portfolio jobs | ❌ **DEFERRED** | No public job-listing API. `jobs.sequoiacap.com` is HTML. Low volume, high scraping effort. |
| a16z portfolio jobs | ❌ **DEFERRED** | Same shape as Sequoia. |
| AngelList / Wellfound | ❌ **DEFERRED** | Anti-bot. Would need login. |
| Indie Hackers Jobs | ⚠️ **POTENTIAL** | Public HTML page, no API. Worth a smoke test if needed. |
| Slack/Discord communities (Swiss Founders, Product Tank Zurich, etc.) | ❌ **DEFERRED** | Auth-walled. ToS-grey. |

## Research notes (2026-09-02)

### Reddit

```
$ curl -I https://www.reddit.com/r/forhire/new/.json
HTTP/2 403
... <title>Blocked</title>
```

- All anonymous JSON endpoints return 403 with `<title>Blocked</title>` body.
- Playwright hits `https://old.reddit.com/login/?reason=lor2&dest=...` — full login redirect, no anonymous view.
- RSS feeds (`/r/<sub>/new/.rss`) also 403.
- Would need OAuth token + Reddit API key (separate auth flow).

**Conclusion:** Not feasible without paid SaaS (e.g. Apify Reddit scraper) or user-provided OAuth credentials. Defer.

### YC Work at a Startup

```
$ curl -I https://www.workatastartup.com/companies
HTTP/2 302
location: https://www.workatastartup.com/login?...
```

- Homepage (`/`) returns 200 with HTML shell, but `/companies` 302s to login.
- Algolia-backed per `github.com/rayhanadev/yc-waas-api` reverse-engineering writeup.
- CSRF token required for any data-bearing endpoint.
- Possible RSS: `/companies.rss`, `/feed.rss`, `/companies/feed.rss` — **NOT VERIFIED**. First step before implementing: `curl -I <URL>`.

**Conclusion:** Stub shipped; RSS verification is the cheapest next step. If RSS works, ~30 LOC implementation. If not, remove the source entirely.

### Sequoia / a16z portfolio jobs

- `jobs.sequoiacap.com` — HTML, lists portfolio-company jobs but no public API.
- `jobs.a16z.com` — similar.
- Volume is low (~10-30 PM-relevant roles across both at any time).
- Cost (Playwright sessions, HTML parsing, no stable selectors) > benefit.

**Conclusion:** Defer. If Sam later expresses interest in VC-portfolio PM roles specifically, revisit. Otherwise, drop from the radar.

## How to pick one of these up later

1. Read the relevant section above for prior research.
2. If it's a **stub** (`yc-directory-rss`): verify the RSS endpoint with `curl -I`, then implement in-place.
3. If it's a **deferred** source: decide whether the cost-benefit makes sense today. If yes, write a new scraper module + add a manifest entry. If no, leave this doc alone.
4. **Always** add a test (`tests/test-<source>.js`) per the existing `tests/test-geo-filter.js` pattern.

## See also

- `src/sources/yc-directory-rss.js` — the stub source with inline TODO.
- `src/sources/hn-whose-hiring.js` — the working example to mirror.
- `MEMORY.md` "DailyJobAggregatorAgent v2" — architecture overview.
