// src/sources/itjobs-ch.js
// itjobs.ch scraper for v2. Patterns adapted from v1 (scripts/daily-job-search.js):
//   - scrapeItJobsCh (L502–575) for DOM-scan card structure
//   - parseDate (verbatim) for "vor 3 Tagen" German date parsing
//
// v2 uses raw fetch() against the listing page (server-rendered HTML).
// Each job card is a <div class="pl-3"> wrapping an <a class="job-details-link">
// + <a href="/companies/..."> + <a href="/jobs/in-...">. We slice the card block
// from one job-details-link to the next and parse fields from the slice.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const META = { name: 'itjobs.ch', method: 'mcp_web_fetch' };

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Match a job-details link anchor — captures the URL slug.
const JOB_LINK_RE = /<a[^>]+class="job-details-link"[^>]+href="(\/jobs\/[0-9]+-[^"]+)"/g;
// Match <h3>title</h3> immediately following the job-details-link.
const TITLE_RE = /<h3[^>]*>([^<]+)/;
// Match company <a> inside the card block.
const COMPANY_RE = /\/companies\/[^"]+"[^>]*>\s*([^<]+?)\s*<\/a/;
// Match location <a href="/jobs/in-<slug>-switzerland"> inside the card.
const LOC_LINK_RE = /\/jobs\/in-([a-z0-9-]+)-switzerland/;
// German date phrase: "vor 3 Tagen" / "vor 5 Std" / "vor 2 hours"
const DATE_RE = /vor\s+(\d+)?\s*(Tg|Std|hours?|days?)/i;

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(text) {
  return stripHtml(text).slice(0, 4000);
}

function parseDate(text) {
  const now = new Date();
  const lower = (text || '').toLowerCase().trim();
  const m = lower.match(DATE_RE);
  if (m) {
    const num = parseInt(m[1]) || 1;
    const unit = m[2].toLowerCase();
    const d = new Date(now);
    if (/^tg|^day/.test(unit)) d.setDate(d.getDate() - num);
    return d.toISOString().split('T')[0];
  }
  return now.toISOString().split('T')[0];
}

function locationFromSlug(slug) {
  // /jobs/in-<city>-<kanton>-switzerland → "City, Kanton XX, Switzerland"
  const parts = slug.split('-');
  if (parts.length >= 3) {
    const city = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const canton = parts[1].toUpperCase();
    return `${city}, Kanton ${canton}, Switzerland`;
  }
  if (parts.length === 2) {
    const city = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    return `${city}, Switzerland`;
  }
  return 'Switzerland';
}

// Slice the HTML into per-card blocks, then parse each.
function parseCards(html) {
  const matches = [];
  let m;
  JOB_LINK_RE.lastIndex = 0;
  while ((m = JOB_LINK_RE.exec(html)) !== null) {
    matches.push({ href: 'https://www.itjobs.ch' + m[1], index: m.index, end: m.index + m[0].length });
  }
  if (!matches.length) return [];
  const cards = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    cards.push({ href: matches[i].href, block: html.slice(start, end) });
  }
  return cards;
}

function buildJob(card) {
  const tm = card.block.match(TITLE_RE);
  const title = tm ? stripHtml(tm[1]) : 'Unknown';
  const cm = card.block.match(COMPANY_RE);
  const company = cm ? stripHtml(cm[1]) : 'Unknown';
  const lm = card.block.match(LOC_LINK_RE);
  const location = lm ? locationFromSlug(lm[1]) : 'Switzerland';
  return {
    company,
    title,
    location,
    datePosted: parseDate(card.block),
    link: card.href,
    source: 'itjobs.ch',
    descSnippet: snippet(card.block),
  };
}

export default async function scrape(ctx) {
  const { logger, outputPath, manifest } = ctx;
  // Orchestrator logger signature is log(level, msg, extra) — adapt to that.
  const log = (lvl, msg, extra) => {
    if (typeof logger === 'function') return logger(lvl, msg, { source: META.name, ...(extra || {}) });
    if (logger && typeof logger[lvl] === 'function') return logger[lvl](msg, { source: META.name, ...(extra || {}) });
    return null;
  };

  if (!outputPath) {
    throw new Error('itjobs.ch: ctx.outputPath is required.');
  }

  // ctx.manifest is the full manifest file (see orchestrate.js contract).
  const myEntry = manifest && manifest.sources && manifest.sources.find((s) => s.name === 'itjobs.ch');
  const searchUrl = myEntry && myEntry.searchUrl;
  if (!searchUrl) {
    throw new Error('itjobs.ch: manifest.sources[*].searchUrl missing.');
  }

  log('info', 'fetching listing', { url: searchUrl });
  let html;
  try {
    const res = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      log('error', 'fetch failed', { status: res.status });
      return { count: 0, sample: [] };
    }
    html = await res.text();
  } catch (e) {
    log('error', 'fetch failed', { error: e.message });
    return { count: 0, sample: [] };
  }

  const cards = parseCards(html);
  const jobs = cards.map(buildJob).filter((j) => j.title && j.title !== 'Unknown' && j.title.length > 3);
  log('info', 'parsed', { cards: cards.length, kept: jobs.length });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify({
    source: META.name, scrapedAt: new Date().toISOString(), jobs,
  }, null, 2));

  return { count: jobs.length, sample: jobs.slice(0, 5) };
}