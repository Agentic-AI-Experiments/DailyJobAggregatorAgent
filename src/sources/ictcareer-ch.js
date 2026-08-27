// src/sources/ictcareer-ch.js
// ictcareer.ch scraper for v2.
//
// LIMITATION: detail pages are blocked by Cloudflare Turnstile under
// headless browsers. Listing-only. descSnippet is card text only,
// not full requirements. Documented in MEMORY.md 2026-08-22.
//
// Each card is an <li role="button"> with structure:
//   <h2><a href="/en/job/<numeric-id>">{title}</a></h2>
//   <p class="...">{company}</p>
// followed by some metadata. We extract (title, company, link) per card.

import { writeFile } from 'node:fs/promises';

export const META = { name: 'ictcareer.ch', method: 'mcp_web_fetch' };

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX_PAGES = 3;

const stripHtml = (s) => (s || '')
  .replace(/<[^>]{1,200}>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

// Match each job card <li role="button"> block.
// Capture the title-link URL and the title text in one regex.
const CARD_RE = /<li[^>]+role="button"[^>]*>([\s\S]*?)<\/li>/g;
const TITLE_LINK_RE = /<a[^>]+href="(\/en\/job\/(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/;
const COMPANY_RE = /<p[^>]*class="[^"]*Subtitle[^"]*"[^>]*>([^<]+)<\/p>/;
const DATE_BADGE_RE = /\b(\d+)\s*([WDM])\b/;

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

function extractJobsFromHtml(html) {
  const out = [];
  const seen = new Set();
  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(html)) !== null) {
    const block = m[1];
    const link = TITLE_LINK_RE.exec(block);
    if (!link) continue;
    const id = link[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const cm = block.match(COMPANY_RE);
    const company = cm ? stripHtml(cm[1]) : 'Unknown';
    const titleRaw = stripHtml(link[3]);
    const dm = titleRaw.match(DATE_BADGE_RE);
    const datePosted = relativeDateToIso(dm) || new Date().toISOString().slice(0, 10);
    const title = titleRaw.replace(DATE_BADGE_RE, '').replace(/\s{2,}/g, ' ').trim();

    out.push({
      company,
      title,
      location: 'Switzerland',
      datePosted,
      link: 'https://ictcareer.ch' + link[1],
      source: 'ictcareer.ch',
      descSnippet: stripHtml(block).slice(0, 4000), // see LIMITATION
    });
  }
  return out;
}

export default async function scrape(ctx) {
  const { logger, manifest, outputPath } = ctx;
  const log = (lvl, msg, extra) => {
    if (typeof logger === 'function') return logger(lvl, msg, { source: META.name, ...(extra || {}) });
    if (logger && typeof logger[lvl] === 'function') return logger[lvl](msg, { source: META.name, ...(extra || {}) });
    return null;
  };

  // ctx.manifest is the full manifest file (see orchestrate.js contract).
  const myEntry = manifest && manifest.sources && manifest.sources.find((s) => s.name === 'ictcareer.ch');
  const baseUrl = (myEntry && myEntry.searchUrl) || 'https://ictcareer.ch/en/jobs?q=Product+Manager';

  const jobs = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = pageNum === 1 ? baseUrl : appendPage(baseUrl, pageNum);
    let html;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        log('warn', 'ictcareer.ch fetch non-ok', { page: pageNum, status: res.status });
        break;
      }
      html = await res.text();
    } catch (e) {
      log('warn', 'ictcareer.ch fetch failed', { page: pageNum, error: e.message });
      break;
    }

    const pageJobs = extractJobsFromHtml(html);
    if (pageJobs.length === 0) {
      log('info', 'ictcareer.ch no cards on page, stopping', { page: pageNum });
      break;
    }
    log('info', 'ictcareer.ch cards', { page: pageNum, count: pageJobs.length });
    jobs.push(...pageJobs);
  }

  try {
    await writeFile(outputPath, JSON.stringify({
      source: 'ictcareer.ch',
      scrapedAt: new Date().toISOString(),
      jobs,
    }, null, 2), 'utf8');
  } catch (e) {
    log('warn', 'ictcareer.ch writeFile failed', { error: e.message });
  }

  log('info', 'ictcareer.ch parsed', { count: jobs.length });
  return { count: jobs.length, sample: jobs.slice(0, 5) };
}