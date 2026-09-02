// src/sources/hn-whose-hiring.js — Hacker News "Who's hiring" monthly thread
//
// HN publishes a monthly "Ask HN: Who is hiring?" megathread on the 1st of each
// month. Each top-level comment is a self-contained job post in the canonical
// format: "Company | Location | FT/PT/etc | Roles | ...".
//
// Strategy:
//   1. Discover the current month's thread via search_by_date (filter on
//      story_title containing "Ask HN: Who is hiring?" + created within last
//      45 days). Catches the 1st-of-month thread + late stragglers.
//   2. For that thread, query Algolia with story_id tag and the keyword
//      "product manager" (returns only comments that mention PM).
//   3. Parse the canonical first-line: split on "|" to get company, location.
//   4. Hand off to geo filter (applied upstream in src/filters/index.js).
//
// Pure HTTP, no Playwright needed. ~3 KB responses, sub-second.
//
// Added 2026-09-02 to expand v2's source coverage into the startup / community
// segment that traditional job boards (jobs.ch, LinkedIn) under-represent.
//
// Module contract (v2): default export is an async function (ctx) => { jobs, sample }.
//   - ctx.manifest: full manifest (other sources + this source entry)
//   - ctx.thisSource: just this source's manifest entry
//   - ctx.logger: log function
//   - ctx.outputPath: where to write state/v2-sources/<name>.json
//   - ctx.dryRun: boolean

import * as https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function httpGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
  });
}

// Strip HTML tags + entities the way HN comment_text comes through. Mirrors the
// cleanup in v1's daily-job-search.js so the two stay consistent.
function cleanHtml(rawHtml) {
  return rawHtml
    .replace(/<p>/gi, ' | ')                  // paragraph breaks become pipes
    .replace(/<br\s*\/?\s*>/gi, ' | ')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Title heuristic: explicit PM role mention in first 500 chars. Avoids
// mid-sentence false matches like "...engineer and product manager..."
function extractPMTitle(text) {
  const m = text.slice(0, 500).match(/(senior|staff|lead|principal|head of|vp|director of|founding)?\s*(product\s+manager|product\s+owner|cpo|head\s+of\s+product|vp\s+of\s+product|product\s+lead)/i);
  return m ? m[0].trim() : null;
}

// Extract company from first pipe segment. If it contains a URL, the company
// is what comes before the URL.
function extractCompany(text) {
  const firstSegment = text.split('|')[0]?.trim() || '';
  const companyRaw = firstSegment.replace(/<[^>]+>/g, '').split('https?')[0].trim();
  return companyRaw.replace(/[,.;:].*$/, '').trim() || 'Unknown';
}

// Extract location: first pipe segment after company that looks location-y.
// Skip segments that are obviously FT/PT/contract tokens or role titles.
function extractLocation(text) {
  const segments = text.split('|').map(s => s.trim()).filter(Boolean);
  for (const seg of segments.slice(1, 5)) {
    if (seg.length > 80) continue;             // skip job description text
    if (/\b(remote|onsite|hybrid|full[- ]time|part[- ]time|contract|fte|equity)\b/i.test(seg) && seg.length < 40) continue;
    return seg;
  }
  return 'See thread';
}

function buildDescSnippet(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

export default async function scrapeHackerNewsHiring(ctx) {
  const log = ctx.logger || console;
  const jobs = [];

  // Step 1: find the latest "Who is hiring?" thread id
  let threadId = null;
  let threadTitle = null;
  try {
    const storyData = await httpGet(
      'https://hn.algolia.com/api/v1/search_by_date?query=Ask%20HN%3A%20Who%20is%20hiring%3F&tags=story&hitsPerPage=10',
      15000
    );
    const stories = JSON.parse(storyData).hits || [];
    const cutoffTs = Math.floor((Date.now() - 45 * 86400000) / 1000);
    const thread = stories.find(s =>
      /Ask HN: Who is hiring\? \(/.test(s.title || '') && s.created_at_i >= cutoffTs
    );
    if (thread) {
      threadId = thread.objectID;
      threadTitle = thread.title;
      log.info?.( 'hn thread discovered', { source: 'hn-whose-hiring', threadId, title: threadTitle });
    }
  } catch (e) {
    log.error?.( 'hn thread lookup failed', { source: 'hn-whose-hiring', error: e.message });
    return writeAndReturn(ctx, jobs);
  }
  if (!threadId) {
    log.warn?.( 'hn no recent thread found, skipping scrape', { source: 'hn-whose-hiring' });
    return writeAndReturn(ctx, jobs);
  }

  // Step 2: query comments of that thread mentioning "product manager"
  let comments = [];
  try {
    const cdata = await httpGet(
      `https://hn.algolia.com/api/v1/search?query=product%20manager&tags=comment,story_${threadId}&hitsPerPage=100`,
      20000
    );
    comments = JSON.parse(cdata).hits || [];
    log.info?.( 'hn comments fetched', { source: 'hn-whose-hiring', threadId, count: comments.length });
  } catch (e) {
    log.error?.( 'hn comment fetch failed', { source: 'hn-whose-hiring', error: e.message });
    return writeAndReturn(ctx, jobs);
  }

  // Step 3: parse each comment per canonical HN-Who's-Hiring format
  for (const c of comments) {
    const text = cleanHtml(c.comment_text || '');
    if (!text) continue;
    const title = extractPMTitle(text);
    if (!title) continue;
    const company = extractCompany(text);
    const location = extractLocation(text);
    const datePosted = c.created_at ? c.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
    const link = `https://news.ycombinator.com/item?id=${c.objectID}`;
    jobs.push({
      company,
      title,
      location,
      datePosted,
      link,
      source: 'hn-whose-hiring',
      descSnippet: buildDescSnippet(text),
      // germanRequired is added by the filter pipeline (applyFilters) so we
      // don't duplicate the regex here. Same pattern as other v2 sources.
    });
  }
  log.info?.( 'hn-whose-hiring parsed', { source: 'hn-whose-hiring', total: jobs.length, thread: threadTitle });
  return writeAndReturn(ctx, jobs);
}

function writeAndReturn(ctx, jobs, log) {
  // Write to state/v2-sources/<name>.json if we have an outputPath (orchestrator
  // mode). For tests / smoke runs without a ctx, just return the array.
  if (!ctx.outputPath) {
    return { jobs, sample: jobs.slice(0, 5), count: jobs.length };
  }
  try {
    fs.mkdirSync(path.dirname(ctx.outputPath), { recursive: true });
    fs.writeFileSync(ctx.outputPath, JSON.stringify({ jobs, scrapedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    log.warn?.( 'hn-whose-hiring write failed', { error: e.message });
  }
  return { jobs, sample: jobs.slice(0, 5), count: jobs.length };
}
