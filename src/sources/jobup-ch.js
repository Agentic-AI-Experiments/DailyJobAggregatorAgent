// ─── jobup.ch source scraper (job-aggregator-v2) ────────────────────────────
//
// LIMITATION: Jobup.ch listing pages only carry the teaser of the description,
// not the full requirements. German-detection accuracy is limited for this
// source. Documented in MEMORY.md 2026-08-22.
//
// jobup.ch is a job-board aggregator (Romandie-heavy). Listing pages carry a
// clean JobPosting JSON-LD list — extract title/description/identifier/pubDate
// straight from the listing, no per-detail fetch required.
//
// IMPORTANT: the JSON-LD has encoding artifacts (e.g. "ZArich" for "Zürich").
// We prefer the JSON-LD title because it's already the canonical posting
// title; we apply a Latin-1 → UTF-8 mojibake fix to the user-facing strings
// (title/company/location/description), same heuristic as v1.

import { writeFile } from 'node:fs/promises';

export const META = { name: 'jobup.ch', method: 'mcp_web_fetch' };

const MAX_PAGES = 5;
const DESC_CAP = 4000;

// Latin-1 → UTF-8 mojibake fix. Adopted only if it reduces the count of
// replacement/stray-high-bit chars (heuristic borrowed from v1).
function fixEncoding(s) {
  if (typeof s !== 'string') return s;
  try {
    const bytes = Buffer.from(s, 'latin1');
    const fixed = bytes.toString('utf8');
    const bad = (str) => (str.match(/\u00c3|\u00c2|\ufffd/g) || []).length;
    return bad(fixed) < bad(s) ? fixed : s;
  } catch { return s; }
}

// Extracts JobPosting JSON-LD nodes from a page body. Accepts both raw HTML
// (with <script type="application/ld+json"> tags) and markdown/mixed output —
// script-tag regex is the primary path; if absent, scans for any object that
// parses as JSON and contains "@type":"JobPosting".
function extractJobPostings(body) {
  if (!body) return [];
  const out = [];
  const seen = new Set();

  // 1) Primary: <script type="application/ld+json"> blocks.
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(body)) !== null) {
    collectJobPostings(decodeScriptText(m[1]), out, seen);
  }
  if (out.length > 0) return out;

  // 2) Fallback: try to JSON.parse any { ... "@type":"JobPosting" ... } blob.
  const blobRe = /\{[^{}]*"@type"\s*:\s*"JobPosting"[^{}]*\}/g;
  while ((m = blobRe.exec(body)) !== null) {
    collectJobPostings(m[0], out, seen);
  }
  return out;
}

function decodeScriptText(raw) {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function collectJobPostings(blob, out, seen) {
  let node;
  try { node = JSON.parse(blob); } catch { return; }
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (n['@type'] === 'JobPosting') {
      const key = n['@id'] || n.url || JSON.stringify(n).slice(0, 200);
      if (!seen.has(key)) { seen.add(key); out.push(n); }
      return;
    }
    if (n['@graph']) visit(n['@graph']);
    for (const k of Object.keys(n)) {
      if (k.startsWith('@')) continue;
      visit(n[k]);
    }
  };
  visit(node);
}

function htmlToText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDescSnippet(text) {
  if (!text) return '';
  return text.length > DESC_CAP ? text.slice(0, DESC_CAP) : text;
}

function normalizeJob(p, fallbackUrl) {
  const title = fixEncoding(p.title || '');
  const rawDesc = htmlToText(p.description || '');
  const descText = fixEncoding(rawDesc);
  const company = fixEncoding(p.hiringOrganization?.name || 'Unknown');
  const loc = p.jobLocation?.address || {};
  const location = fixEncoding(
    [loc.addressLocality, loc.addressRegion, loc.addressCountry].filter(Boolean).join(', ')
  ) || 'Switzerland';
  const datePosted = (p.datePosted || '').split('T')[0] || new Date().toISOString().split('T')[0];
  const link = fixEncoding(p.url || p.sameAs || p['@id'] || fallbackUrl);
  return {
    company, title, location,
    datePosted,
    link,
    source: 'jobup.ch',
    descSnippet: buildDescSnippet(descText),
  };
}

export default async function scrape(ctx) {
  const { logger, manifest, outputPath } = ctx;
  const searchUrl = manifest?.searchUrl
    || 'https://www.jobup.ch/en/job-offers.html?keyword=Product+Manager';
  const log = logger?.info ? logger : {
    info: () => {}, warn: () => {}, error: () => {},
  };
  const fetch = ctx.webFetch || (typeof globalThis.web_fetch === 'function'
    ? globalThis.web_fetch
    : null);

  const jobs = [];
  const seenLinks = new Set();

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = appendQuery(searchUrl, { term: 'product+manager', page: pageNum });
    let body = '';
    try {
      if (fetch) {
        body = await fetch(url, { extractMode: 'text', maxChars: 2_000_000 });
      } else {
        log.warn('jobup.ch: no webFetch available, page skipped', { page: pageNum });
        break;
      }
    } catch (e) {
      log.warn('jobup.ch page fetch failed', { page: pageNum, error: e.message });
      break;
    }

    const postings = extractJobPostings(body);
    if (postings.length === 0) {
      log.info('jobup.ch no postings on page, stopping pagination', { page: pageNum });
      break;
    }
    log.info('jobup.ch parsed posting list', { page: pageNum, count: postings.length });

    for (const p of postings) {
      const job = normalizeJob(p, url);
      if (!job.link || seenLinks.has(job.link)) continue;
      seenLinks.add(job.link);
      jobs.push(job);
    }
  }

  try {
    await writeFile(outputPath, JSON.stringify({
      source: 'jobup.ch',
      scrapedAt: new Date().toISOString(),
      jobs,
    }, null, 2), 'utf8');
  } catch (e) {
    log.warn('jobup.ch writeFile failed', { error: e.message });
  }

  log.info('jobup.ch parsed', { count: jobs.length });
  return { count: jobs.length, sample: jobs.slice(0, 5) };
}

function appendQuery(baseUrl, params) {
  try {
    const u = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return baseUrl + sep + Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }
}
