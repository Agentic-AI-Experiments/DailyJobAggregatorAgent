// src/utils/enrich.js
// Bounded-parallel HTTP fetcher for job detail pages + JSON-LD parser.
//
// v1 source: scripts/daily-job-search.js, added 2026-08-22 (per MEMORY.md).
//   - fetchDetailPages       (L786): batchSize 10, 15s per-request timeout,
//                                 no retries, raw node http/https (no Playwright).
//   - parseJobPostingJsonLd  (L817): regex scan for <script type="application/ld+json">,
//                                 HTML-entity unescape, recursive @type === 'JobPosting'
//                                 lookup, returns first match.
//   - htmlToText             (L851): block-element-aware strip (br/p/li/h)
//                                 + entity decode + whitespace collapse.

import * as http from 'node:http';
import * as https from 'node:https';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BATCH = 10;
const PER_REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap so a misbehaving server can't OOM the run

function fetchOne(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      // Follow one redirect. Many ATS detail pages 301 to a canonical URL;
      // without this we'd silently treat the redirect as status 0 and drop
      // the page. A single hop is enough for the boards we scrape; deeper
      // redirect chains are a board-config bug, not our problem.
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!settled) { settled = true; resolve(fetchOne(next, timeoutMs)); }
        return;
      }
      let data = '';
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          if (!settled) { settled = true; resolve({ url, data: '', status: 0 }); }
          return;
        }
        data += c;
      });
      res.on('end', () => {
        if (!settled) { settled = true; resolve({ url, data, status: res.statusCode || 0 }); }
      });
      res.on('error', () => {
        if (!settled) { settled = true; resolve({ url, data: '', status: 0 }); }
      });
    });
    req.on('error', () => { if (!settled) { settled = true; resolve({ url, data: '', status: 0 }); } });
    req.on('timeout', () => {
      req.destroy();
      if (!settled) { settled = true; resolve({ url, data: '', status: 0 }); }
    });
  });
}

// Concurrency-bounded (≤BATCH) map over urls. Returns Map<url, html> for
// successful (status 200, non-empty body) responses only. Failures are
// silently dropped — one-pass, no retries, per the v1 contract.
//
// options.batch    — override the concurrency cap (1..BATCH). Raising above
//                    BATCH is intentionally not supported: boards rate-limit
//                    above ~10 concurrent requests.
// options.timeoutMs — per-request timeout in ms. Default 15000.
export async function fetchDetailPages(urls, options = {}) {
  const out = new Map();
  if (!Array.isArray(urls) || urls.length === 0) return out;
  const limit = Math.max(1, Math.min(BATCH, options.batch ?? BATCH));
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PER_REQUEST_TIMEOUT_MS;
  let cursor = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const myIdx = cursor++;
      const url = urls[myIdx];
      const r = await fetchOne(url, timeoutMs);
      if (r.status === 200 && r.data) out.set(r.url, r.data);
    }
  };

  const workers = Array.from({ length: Math.min(limit, urls.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

// Extract the first JobPosting JSON-LD object from an HTML page, decoding
// HTML-entity-encoded JSON before parse. Returns the parsed object or null.
export function parseJobPostingJsonLd(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const cleaned = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&#10;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
    try {
      const node = JSON.parse(cleaned);
      const found = [];
      const visit = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) visit(x); return; }
        if (n['@type'] === 'JobPosting') { found.push(n); return; }
        if (n['@graph']) visit(n['@graph']);
      };
      visit(node);
      if (found.length > 0) return found[0];
    } catch {
      // Malformed JSON-LD — try the next <script> block.
    }
  }
  return null;
}

// Strip HTML tags from a JSON-LD description, decode common entities, collapse
// whitespace. Block elements (p, li, h*) become newlines so the German detector
// sees sentence boundaries instead of a single run-on string.
const BR_RE = /<br\s*\/?\s*>/gi;
const P_END_RE = /<\/p\s*>/gi;
const LI_END_RE = /<\/li\s*>/gi;
const H_END_RE = /<\/h[1-6]\s*>/gi;
const TAG_RE = /<[^>]{1,200}>/g;
const NBSP_RE = /&nbsp;/g;
const ENTITY_RE = /&#?\w+;/g;
const WHITESPACE_RE = /[ \t]+/g;
const NEWLINE_RUN_RE = /\n{2,}/g;

export function htmlToText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(BR_RE, ' ')
    .replace(P_END_RE, '\n')
    .replace(LI_END_RE, '\n')
    .replace(H_END_RE, '\n')
    .replace(TAG_RE, ' ')
    .replace(NBSP_RE, ' ')
    .replace(ENTITY_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .replace(NEWLINE_RUN_RE, '\n')
    .trim();
}
