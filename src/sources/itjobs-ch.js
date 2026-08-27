// itjobs.ch source scraper (v2 — MCP web_fetch).
// Adapted from v1 Playwright DOM-scan at
//   Daily job-search v1 (read-only reference, sibling workspace) — scrapeItJobsCh
//   scrapeItJobsCh, lines ~502-575.
// v2 feeds Readability-extracted markdown into the same slug-parse +
// date-parse logic; card boundaries are detected by job-detail link
// pairs `[/jobs/<id>-<slug>](/jobs/<id>-<slug>)`.

export const META = { name: 'itjobs.ch', method: 'mcp_web_fetch' };

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TITLE_LINK_RE = /\[([^\]]+)\]\(\/jobs\/(\d{6,})-([^)\s]+)\)/g;
const COMPANY_RE = /\[([^\]]+)\]\(\/companies\/[^)]+\)/;
const LOCATION_LINK_RE = /\[([^\]]+)\]\(\/jobs\/in-([a-z0-9-]+)-switzerland\)/;
const LOCATION_TEXT_RE = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]+),\s*(Kanton\s+[A-Z]{2}|[A-Z]{2}),\s*Schweiz/;
const DATE_RE = /vor\s+(\d+)?\s*(Tg|Std|hours?|days?)/i;

function parseLocation(href) {
  if (!href) return 'Switzerland';
  const slug = href.replace('/jobs/in-', '').replace('-switzerland', '');
  const parts = slug.split('-').filter(Boolean);
  if (parts.length === 0) return 'Switzerland';
  const city = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  if (parts.length === 1) return city;
  return `${city}, Kanton ${parts[1].toUpperCase()}, Switzerland`;
}

function parseDate(block) {
  const m = block.match(DATE_RE);
  if (!m) return new Date().toISOString().split('T')[0];
  const num = parseInt(m[1], 10) || 1;
  const unit = m[2];
  const d = new Date();
  if (/^tg$|^days?$/i.test(unit)) d.setDate(d.getDate() - num);
  return d.toISOString().split('T')[0];
}

function buildDescSnippet(block) {
  const text = block.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  return text.length > 4000 ? text.slice(0, 4000) : text;
}

function parseCards(markdown) {
  // Find every title-link position, then slice the block between
  // consecutive title links — that block is one job card.
  const matches = [];
  let m;
  while ((m = TITLE_LINK_RE.exec(markdown)) !== null) {
    matches.push({
      title: m[1].trim(),
      href: `https://www.itjobs.ch/jobs/${m[2]}-${m[3]}`,
      index: m.index,
      end: m.index + m[0].length,
    });
  }
  const cards = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    cards.push({ ...matches[i], block: markdown.slice(start, end) });
  }
  return cards;
}

function buildJob(card) {
  const company = (card.block.match(COMPANY_RE) || [null, 'Unknown'])[1].trim();
  const locLink = card.block.match(LOCATION_LINK_RE);
  const location = locLink
    ? parseLocation(`/jobs/in-${locLink[2]}-switzerland`)
    : ((card.block.match(LOCATION_TEXT_RE) || [])[0] || 'Switzerland');
  return {
    company,
    title: card.title,
    location,
    datePosted: parseDate(card.block),
    link: card.href,
    source: 'itjobs.ch',
    descSnippet: buildDescSnippet(card.block),
  };
}

export default async function scrape(ctx) {
  const { logger, outputPath, manifest, webFetch } = ctx;
  const log = (lvl, msg, extra) =>
    logger ? logger[lvl](msg, { source: META.name, ...extra }) : null;

  if (typeof webFetch !== 'function') {
    throw new Error('itjobs.ch: ctx.webFetch is required (MCP web_fetch).');
  }
  if (!outputPath) {
    throw new Error('itjobs.ch: ctx.outputPath is required.');
  }

  const searchUrl = manifest && manifest.searchUrl;
  if (!searchUrl) {
    throw new Error('itjobs.ch: manifest.searchUrl missing.');
  }

  log('info', 'fetching listing', { url: searchUrl });
  let markdown;
  try {
    const result = await webFetch({ url: searchUrl, extractMode: 'markdown' });
    markdown = (result && result.text) || '';
  } catch (e) {
    log('error', 'web_fetch failed', { error: e.message });
    return { count: 0, sample: [] };
  }

  if (markdown.length < 200) {
    log('warn', 'listing too short; no cards', { length: markdown.length });
    return { count: 0, sample: [] };
  }

  const cards = parseCards(markdown);
  const jobs = [];
  for (const card of cards) {
    if (card.title.length < 5) continue;
    jobs.push(buildJob(card));
  }

  log('info', 'parsed', { total: cards.length, kept: jobs.length });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify(
      { source: META.name, scrapedAt: new Date().toISOString(), jobs },
      null, 2,
    ),
  );

  return { count: jobs.length, sample: jobs.slice(0, 5) };
}
