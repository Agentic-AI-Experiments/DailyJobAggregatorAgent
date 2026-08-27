// src/sources/jobscout24-ch.js
//
// jobscout24.ch scraper for v2.
//
// Adapted from v1 (scripts/daily-job-search.js, scrapeScout24Ch function,
// lines ~681–785 of the v1 audit). v1 used Playwright for the listing page
// then dropped to Node's http/https for detail pages; v2 follows the same
// two-phase split but uses MCP web_fetch for Phase A (listing) and raw HTTP
// for Phase B (detail). Regexes for JSON-LD extraction are reused verbatim
// from v1 — they were validated against 100+ real postings.
//
// Two phases:
//   A. web_fetch listing → extract detail page URLs (regex on rendered HTML).
//   B. Raw HTTP in batches of 10, 15s per request, regex over returned HTML.
// The detail page IS the scrape source (needsDetailEnrichment = false per
// manifest): we extract title/company/location/date/description inline, so
// the orchestrator does NOT need to re-enrich this source later.

import * as http from 'node:http';
import * as https from 'node:https';
import { writeFile } from 'node:fs/promises';

export const META = { name: 'jobscout24.ch', method: 'mcp_web_fetch_plus_raw_http' };

const LISTING_URL = 'https://www.jobscout24.ch/de/jobs/productmanager/';
const DETAIL_HREF_RE = /jobscout24.*\/job\/[a-f0-9-]+\//;
const DETAIL_LINK_RE = /https?:\/\/[^\s"'<>]*jobscout24[^\s"'<>]*\/job\/[a-f0-9-]+\//g;

const TITLE_RE = /"title":\s*"([^"]+)"/;
const COMPANY_RE = /"hiringOrganization":\s*\{[^}]*?"name":\s*"([^"]+)"/;
const DATE_RE = /"datePosted":\s*"([^"]+)"/;
const LOC_RE = /"jobLocation":\s*\{[^}]*?"addressLocality":\s*"([^"]+)"[^}]*?"addressRegion":\s*"([^"]+)"/;
const DESC_RE = /"description":\s*"([^"]{100,})/;

const HTML_ENTITIES = [
  ['&#252;', 'ü'], ['&#246;', 'ö'], ['&#228;', 'ä'], ['&#223;', 'ß'],
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'],
  ['\\n', ' '], ['\\"', '"'],
];

function stripHtml(raw) {
  let s = raw;
  for (const [from, to] of HTML_ENTITIES) s = s.split(from).join(to);
  try { s = Buffer.from(s, 'utf-8').toString('utf8'); } catch {}
  s = s.replace(/<br\s*\/?\s*>/gi, ' ')
       .replace(/<[^>]{1,100}>/g, ' ')
       .replace(/\s+/g, ' ')
       .trim();
  return s.slice(0, 4000);
}

// Simple bounded-concurrency runner. Processes `items` via `worker` with at
// most `limit` in-flight. Items complete in submission order (well, almost —
// Promise.all per chunk). Keeps the file self-contained; no external deps.
async function runBatched(items, worker, limit = 10) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const settled = await Promise.all(
      chunk.map((item, j) => Promise.resolve().then(() => worker(item, i + j))),
    );
    for (let k = 0; k < settled.length; k++) out[i + k] = settled[k];
  }
  return out;
}

function fetchRaw(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.7',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ url, status: res.statusCode || 0, data }));
    });
    req.on('error', () => resolve({ url, status: 0, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ url, status: 0, data: '' }); });
  });
}

function extractDetailUrls(listingHtml) {
  const seen = new Set();
  for (const m of listingHtml.match(DETAIL_LINK_RE) || []) {
    const cleaned = m.replace(/&amp;/g, '&').replace(/["'<>]+$/, '');
    if (DETAIL_HREF_RE.test(cleaned)) seen.add(cleaned);
  }
  return [...seen].slice(0, 80);
}

function parseDetail(url, html) {
  const titleMatch = html.match(TITLE_RE);
  if (!titleMatch) return null;
  const companyMatch = html.match(COMPANY_RE);
  const dateMatch = html.match(DATE_RE);
  const locMatch = html.match(LOC_RE);
  const descMatch = html.match(DESC_RE);

  const title = (titleMatch[1] || '').replace(/\\"/g, '"').trim();
  const company = ((companyMatch && companyMatch[1]) || '').replace(/\\"/g, '"').trim() || 'Unknown';
  const datePosted = (dateMatch && dateMatch[1] ? dateMatch[1].slice(0, 10) : '') || new Date().toISOString().slice(0, 10);
  const location = locMatch ? `${locMatch[1]} (${locMatch[2]})` : 'Switzerland';
  const descSnippet = descMatch ? stripHtml(descMatch[1]) : '';

  return { company, title, location, datePosted, link: url, source: 'jobscout24.ch', descSnippet };
}

export default async function scrape(ctx) {
  const { logger, outputPath } = ctx;
  const log = logger || console;

  // Phase A: listing via MCP web_fetch (the sub-agent exposes it on the ctx).
  let listingHtml = '';
  if (typeof ctx.webFetch === 'function') {
    const r = await ctx.webFetch(LISTING_URL);
    listingHtml = (r && (r.markdown || r.html || r.text || (typeof r === 'string' ? r : ''))) || '';
  }
  // Fallback: raw HTTP if the runner didn't wire web_fetch in.
  if (!listingHtml) {
    const r = await fetchRaw(LISTING_URL, 30000);
    listingHtml = r.data || '';
  }

  const detailUrls = extractDetailUrls(listingHtml);
  log.info?.('jobscout24.ch detail URLs', { count: detailUrls.length });

  // Phase B: raw HTTP for each detail page, batches of 10, 15s timeout.
  const fetched = await runBatched(detailUrls, (u) => fetchRaw(u, 15000), 10);

  const jobs = [];
  for (const r of fetched) {
    if (!r || r.status !== 200 || !r.data) continue;
    const job = parseDetail(r.url, r.data);
    if (job) jobs.push(job);
  }

  log.info?.('jobscout24.ch parsed', { count: jobs.length });

  if (outputPath) {
    await writeFile(
      outputPath,
      JSON.stringify(
        { source: 'jobscout24.ch', scrapedAt: new Date().toISOString(), jobs },
        null,
        2,
      ),
    );
  }

  return { count: jobs.length, sample: jobs.slice(0, 5) };
}
