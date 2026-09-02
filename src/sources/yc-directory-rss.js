// src/sources/yc-directory-rss.js — YC Work at a Startup (stub, TODO)
//
// Status (2026-09-02): NOT IMPLEMENTED. Returns empty results.
//
// Why a stub:
//   Per the 2026-09-02 v2 expansion plan (see MEMORY.md "DailyJobAggregatorAgent
//   v2" + docs/SOURCES-TODO.md), Sam approved Option A: ship a visible stub in
//   the manifest so future readers can see WAA was on our radar, with a clear
//   TODO explaining how to fill it in. Better than silently dropping WAA.
//
// Why WAA is hard (research notes 2026-09-02):
//   - Homepage https://www.workatastartup.com is HTML (200 OK) but the
//     /companies path 302 redirects to login.
//   - WAA uses Algolia + CSRF tokens under the hood (per
//     github.com/rayhanadev/yc-waas-api reverse-engineering writeup).
//   - Without a session cookie, the public JSON search endpoint requires CSRF
//     handling that's brittle to maintain.
//   - Possible shortcut: an RSS endpoint like /companies.rss or /feed.rss.
//     NOT YET VERIFIED. First implementation step below.
//
// To fill this in:
//   1. Verify an RSS endpoint exists:
//        curl -I https://www.workatastartup.com/companies.rss
//        curl -I https://www.workatastartup.com/feed.rss
//        curl -I https://www.workatastartup.com/companies/feed.rss
//   2. If yes: parse the XML, extract title/link/pubDate/description per item,
//      filter on PM keywords (title regex similar to v1 PM_POSITIVE_TITLE).
//   3. If no: remove this file and the manifest entry. WAA drops out of v2
//      entirely. That's an acceptable outcome — Reddit/WAA/Sequoia/a16z are
//      all in the same boat (auth-walled or low-volume). Future expansion
//      should pick the easiest of those to crack, not this one specifically.
//
// Module contract (v2): default export is an async function (ctx) => { jobs, sample }.

export default async function scrapeYCDirectoryRss(ctx) {
  ctx.logger?.warn?.('yc-directory-rss is a stub (TODO) - see src/sources/yc-directory-rss.js header for research notes', {
    source: 'yc-directory-rss',
  });
  return { jobs: [], sample: [], count: 0 };
}
