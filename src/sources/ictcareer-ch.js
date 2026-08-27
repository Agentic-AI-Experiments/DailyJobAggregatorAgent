// ─── ictcareer.ch source scraper (job-aggregator-v2) ────────────────────────
//
// LIMITATION: Detail pages blocked by Cloudflare Turnstile under headless.
// Listing-only. German-detection accuracy for this source is limited —
// descSnippet will be card text only, not full requirements.
// Documented in MEMORY.md 2026-08-22.
//
// v1 (daily-job-search.js, scrapeIctcareer ~902–991) scraped the listing via
// Playwright + DOM eval. v2 uses MCP web_fetch (Cloudflare passes on the
// agent's egress IP; Turnstile only blocks headless detail pages). We parse
// the same card pattern v1 used (`li[role="button"]` + `a[href*="/en/job/"]`)
// from the markdown body instead of the live DOM. Max 5 pages, same as v1.

import { writeFile } from 'node:fs/promises';

export const META = { name: 'ictcareer.ch', method: 'mcp_web_fetch' };

// see LIMITATION: needsDetailEnrichment: false (Cloudflare Turnstile).
const MAX_PAGES = 5;

// Title text in the listing carries a relative-date badge ("1W", "3D", "2M")
// glued onto the end of the title. We strip it so the title field stays clean.
const DATE_BADGE_RE = /\b(\d+)\s*([WDM])\b/;

// Canonical per-job URL pattern observed in v1: /en/job/<numeric-id>.
const JOB_HREF_RE = /https?:\/\/(?:www\.)?ictcareer\.ch\/en\/job\/(\d+)(?:[^\s)\]]*)?/g;

function relativeDateToIso(match) {
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const d = new Date();
  if (unit === 'W') d.setDate(d.getDate() - n * 7);
  else if (unit === 'D') d.setDate(d.getDate() - n);
  else if (unit === 'M') d.setDate(d.getDate() - n * 30);
  return d.toISOString().slice(0, 10);
}

function stripBadge(title) {
  return title.replace(DATE_BADGE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// Parse job cards out of the markdown/text body returned by web_fetch.
// Strategy: find every /en/job/<id> link; the title is the surrounding
// line/text; the company is the next non-empty short line that isn't
// the same as the title (v1 pulled it from a sibling <p> in the DOM).
function extractJobs(body) {
  if (!body) return [];
  const out = [];
  const seen = new Set();
  JOB_HREF_RE.lastIndex = 0;
  let m;
  while ((m = JOB_HREF_RE.exec(body)) !== null) {
    const link = m[0].replace(/[)\]]+$/, '');
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // Look at the ~200 chars around the link for the title text. Strip the
    // link URL out and clean markdown artefacts.
    const start = Math.max(0, m.index - 250);
    const end = Math.min(body.length, m.index + m[0].length + 250);
    const window = body.slice(start, end);
    const cleaned = window
      .replace(link, ' ')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // unwrap [text](url)
      .replace(/[*_`>#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // First non-trivial chunk is the title; next non-trivial chunk is company.
    const chunks = cleaned
      .split(/\s{2,}|\n/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);
    let title = '';
    let company = '';
    for (const c of chunks) {
      if (!title) {
        if (c.length > 200) continue;
        title = c;
        continue;
      }
      if (c.toLowerCase() === title.toLowerCase()) continue;
      if (c.length > 80) break;
      company = c;
      break;
    }
    if (!title) continue;

    const badge = title.match(DATE_BADGE_RE);
    const datePosted = relativeDateToIso(badge) || new Date().toISOString().slice(0, 10);

    out.push({
      company: company || 'Unknown',
      title: stripBadge(title),
      location: 'Switzerland',
      datePosted,
      link,
      source: 'ictcareer.ch',
      descSnippet: cleaned.slice(0, 400), // see LIMITATION: card text only
    });
  }
  return out;
}

export default async function scrape(ctx) {
  const { logger, manifest, outputPath } = ctx;
  const baseUrl = manifest?.searchUrl
    || 'https://ictcareer.ch/en/jobs?q=Product+Manager';
  const log = logger?.info ? logger : {
    info: () => {}, warn: () => {}, error: () => {},
  };
  const fetch = ctx.webFetch || (typeof globalThis.web_fetch === 'function'
    ? globalThis.web_fetch
    : null);

  const jobs = [];
  if (!fetch) {
    log.warn('ictcareer.ch: no webFetch available, aborting');
  } else {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = pageNum === 1
        ? baseUrl
        : appendPage(baseUrl, pageNum);
      let body = '';
      try {
        body = await fetch(url, { extractMode: 'text', maxChars: 2_000_000 });
      } catch (e) {
        log.warn('ictcareer.ch page fetch failed', { page: pageNum, error: e.message });
        break;
      }

      const pageJobs = extractJobs(body);
      if (pageJobs.length === 0) {
        log.info('ictcareer.ch no cards on page, stopping pagination', { page: pageNum });
        break;
      }
      log.info('ictcareer.ch cards', { page: pageNum, count: pageJobs.length });
      jobs.push(...pageJobs);
    }
  }

  try {
    await writeFile(outputPath, JSON.stringify({
      source: 'ictcareer.ch',
      scrapedAt: new Date().toISOString(),
      jobs,
    }, null, 2), 'utf8');
  } catch (e) {
    log.warn('ictcareer.ch writeFile failed', { error: e.message });
  }

  log.info('ictcareer.ch parsed', { count: jobs.length });
  // see LIMITATION: descSnippet is card text only, full requirements not fetched.
  return { count: jobs.length, sample: jobs.slice(0, 5) };
}

function appendPage(baseUrl, pageNum) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('page', String(pageNum));
    return u.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}page=${pageNum}`;
  }
}
