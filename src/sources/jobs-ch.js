// src/sources/jobs-ch.js
// jobs.ch scraper for v2. Patterns adapted from v1 (scripts/daily-job-search.js):
//   - scrapeJobsCh (L452–501) for listing-card text extraction
//   - parseDate (verbatim) for "Today" / "1 day ago" / ISO normalisation
//   - scrapeScout24Ch / fetchDetailPages (L681–810) for the 10-batch raw-http
//     detail-page fetcher; parseJobPostingJsonLd for the JSON-LD reader.
// v1 used Playwright for the listing; v2 uses raw node:https because jobs.ch
// returns server-rendered HTML. Listing cards are title-only — descSnippet is
// populated from each detail page so the German detector has text to match.

import * as http from 'node:http';
import * as https from 'node:https';
import { writeFile } from 'node:fs/promises';

export const META = { name: 'jobs.ch', method: 'mcp_web_fetch' };

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const stripHtml = (s) => (s || '')
  .replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]{1,200}>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENT[m])
  .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
const snippet = (html) => stripHtml(html).slice(0, 4000);

// ─── parseDate (verbatim from v1 daily-job-search.js) ───────────────────────
function parseDate(dateStr) {
  const now = new Date();
  const lower = (dateStr || '').toLowerCase().trim();
  if (lower === 'today' || lower === 'heute') return now.toISOString().split('T')[0];
  if (lower === 'yesterday' || lower === 'gestern') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }
  const daysMatch = lower.match(/(\d+)\s+day/);
  if (daysMatch) {
    const d = new Date(now); d.setDate(d.getDate() - parseInt(daysMatch[1]));
    return d.toISOString().split('T')[0];
  }
  const vorTagen = lower.match(/vor\s+(\d+)\s+tage?/);
  if (vorTagen) {
    const d = new Date(now); d.setDate(d.getDate() - parseInt(vorTagen[1]));
    return d.toISOString().split('T')[0];
  }
  if (lower.match(/\d+\s+hour/) || lower.match(/vor\s+\d+\s+std/)) {
    return now.toISOString().split('T')[0];
  }
  const dm = lower.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dm) {
    const d = new Date(`${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  }
  const ym = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (ym) return ym[0];
  const mdy = lower.match(/([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy) {
    const d = new Date(mdy[0]);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  }
  return now.toISOString().split('T')[0];
}

function getHtml(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 15000 },
      (res) => {
        // Follow one redirect level manually — jobs.ch occasionally 301s.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = res.headers.location;
          resolve(getHtml(loc.startsWith('http') ? loc : new URL(loc, url).href));
          return;
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, data }));
      },
    );
    req.on('error', () => resolve({ status: 0, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: '' }); });
  });
}

// First JobPosting JSON-LD on a detail page. Adapted from v1 parseJobPostingJsonLd.
function extractJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, node;
  while ((m = re.exec(html || '')) !== null) {
    const cleaned = m[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&#10;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
    try { node = JSON.parse(cleaned); } catch { continue; }
    const found = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(visit);
      if (n['@type'] === 'JobPosting') found.push(n);
      else if (n['@graph']) visit(n['@graph']);
    };
    visit(node);
    if (found.length) return found[0];
  }
  return null;
}

async function fetchDetailPages(urls, log) {
  const out = {};
  if (!urls.length) return out;
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    const results = await Promise.all(batch.map(getHtml));
    for (let j = 0; j < batch.length; j++) {
      if (results[j].status === 200 && results[j].data) out[batch[j]] = results[j].data;
    }
  }
  log.info?.('jobs.ch detail pages fetched', { ok: Object.keys(out).length, total: urls.length });
  return out;
}

// One listing card <a data-cy="job-link">…</a>. Layout mirrors v1 scrapeJobsCh.
function parseCard(cardHtml, fullLink) {
  const lines = stripHtml(cardHtml).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const dateStr = lines[0] || 'Today';
  const title = lines[1] || lines[0];
  const placeIdx = Math.max(lines.indexOf('Place of work:'), lines.indexOf('Arbeitsort'));
  const location = placeIdx >= 0 && lines[placeIdx + 1] ? lines[placeIdx + 1] : 'Switzerland';
  const skip = new Set(['Easy apply', 'New', 'Open in new tab', '']);
  let company = 'Unknown';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!skip.has(lines[i])) { company = lines[i]; break; }
  }
  return {
    company, title, location,
    datePosted: parseDate(dateStr),
    link: fullLink,
    source: 'jobs.ch',
    descSnippet: '',
  };
}

export default async function scrape(ctx) {
  const { logger, manifest, outputPath } = ctx;
  const log = logger || console;
  const cfg = manifest.sources.find((s) => s.name === 'jobs.ch');
  const url = cfg?.searchUrl;
  if (!url) {
    log.error?.('jobs.ch: no searchUrl in manifest');
    return { count: 0, sample: [] };
  }

  const listing = await getHtml(url);
  if (listing.status !== 200) {
    log.error?.('jobs.ch listing fetch failed', { status: listing.status });
    return { count: 0, sample: [] };
  }
  log.info?.('jobs.ch listing fetched', { bytes: listing.data.length });

  const cards = listing.data.match(/<a[^>]*data-cy=["']job-link["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  log.info?.('jobs.ch cards found', { count: cards.length });

  const jobs = [];
  for (const cardHtml of cards) {
    const hrefMatch = cardHtml.match(/href=["']([^"']+)["']/);
    if (!hrefMatch || !hrefMatch[1].includes('/detail/')) continue;
    const href = hrefMatch[1];
    const fullLink = href.startsWith('http') ? href : 'https://www.jobs.ch' + href;
    const job = parseCard(cardHtml, fullLink);
    if (job) jobs.push(job);
  }
  log.info?.('jobs.ch cards parsed', { count: jobs.length });

  // Detail pages → descSnippet (and better company/location/date when JSON-LD exists).
  const detailHtml = await fetchDetailPages(jobs.map((j) => j.link), log);
  for (const job of jobs) {
    const html = detailHtml[job.link];
    if (!html) continue;
    const ld = extractJsonLd(html);
    if (ld) {
      const d = (ld.datePosted || '').toString().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) job.datePosted = d;
      job.descSnippet = snippet(ld.description || '');
      if (ld.hiringOrganization && ld.hiringOrganization.name) job.company = ld.hiringOrganization.name;
      const addr = ld.jobLocation && ld.jobLocation.address;
      if (addr) {
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
        if (parts.length) job.location = parts.join(', ');
      }
    } else {
      job.descSnippet = snippet(html);
    }
  }

  if (outputPath) {
    await writeFile(
      outputPath,
      JSON.stringify({ source: 'jobs.ch', scrapedAt: new Date().toISOString(), jobs }, null, 2),
    );
  }
  return { count: jobs.length, sample: jobs.slice(0, 5) };
}
