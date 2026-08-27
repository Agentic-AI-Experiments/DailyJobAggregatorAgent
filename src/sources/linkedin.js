// src/sources/linkedin.js
//
// LinkedIn scraper for v2.
//
// Source: adapted from v1 (scripts/daily-job-search.js, scrapeLinkedIn
// function). v1 ran the same 6 keyword URLs serially and emitted raw job
// objects to a flat array; v2 returns the same shape per the v2 raw job
// schema (source: 'linkedin' lowercase, descSnippet intentionally empty
// for the detail-page enricher to fill later).
//
// Why serial: LinkedIn's anti-bot heuristics penalise rapid sequential
// page loads from the same Chromium fingerprint. v1 explicitly serialised
// the 6 keyword URLs to avoid bot-detection escalation; brief parallelism
// experiments in v2 triggered more frequent sign-in walls. Keep serial.
//
// LinkedIn blocks MCP web_fetch and MCP browser tools (anti-bot + sign-in
// wall). Playwright with a real Chromium is the only viable path. The
// orchestrator shares `playwright` from a sibling workspace's node_modules
// via NODE_PATH; if NODE_PATH isn't set, this module will fail at import
// time, which is the intended fail-fast behaviour.

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

export const META = { name: 'linkedin', method: 'playwright_fallback' };

// Minimal date parser for the formats LinkedIn emits on its cards.
// Most reliable: the <time datetime="ISO"> attribute. Fallback heuristics
// cover the human-readable text variant ("3 days ago", "Today", etc.).
function parseDate(value) {
  const today = new Date().toISOString().slice(0, 10);
  if (!value) return today;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const lower = value.toLowerCase().trim();
  if (lower === 'today' || lower === 'just now') return today;
  const m = lower.match(/(\d+)\s+(minute|hour|day|week|month)s?\s+ago/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const d = new Date();
    if (unit === 'day') d.setDate(d.getDate() - n);
    else if (unit === 'week') d.setDate(d.getDate() - n * 7);
    else if (unit === 'month') d.setMonth(d.getMonth() - n);
    else if ((unit === 'minute' || unit === 'hour') && n >= 24) {
      d.setDate(d.getDate() - 1);
    }
    return d.toISOString().slice(0, 10);
  }
  return today;
}

export default async function scrape(ctx) {
  const { logger, manifest, outputPath } = ctx;
  const sourceCfg = manifest.sources.find((s) => s.name === 'linkedin');
  const urls = sourceCfg?.searchUrls || [];
  const log = logger || console;

  const jobs = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const url of urls) {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(5000);
        const cards = await page.$$('.job-search-card');
        log.info?.('linkedin cards', { url, count: cards.length });
        for (const card of cards) {
          try {
            const titleEl = await card.$('h3.base-search-card__title');
            const title = titleEl ? (await titleEl.textContent()).trim() : '';
            if (!title) continue;
            const companyEl = await card.$('h4.base-search-card__subtitle a');
            const company = companyEl
              ? (await companyEl.textContent()).trim()
              : 'Unknown';
            const locEl = await card.$('span.job-search-card__location');
            const location = locEl
              ? (await locEl.textContent()).trim()
              : 'Switzerland';
            const timeEl = await card.$('time.job-search-card__listdate');
            const datetime = timeEl ? await timeEl.getAttribute('datetime') : null;
            const timeText = timeEl ? (await timeEl.textContent()).trim() : null;
            const datePosted = parseDate(datetime || timeText);
            const linkEl = await card.$('a.base-card__full-link');
            let link = linkEl ? await linkEl.getAttribute('href') : '';
            if (link && !link.startsWith('http')) {
              link = 'https://www.linkedin.com' + link;
            }
            jobs.push({
              company,
              title,
              location,
              datePosted,
              link: link || url,
              source: 'linkedin',
              descSnippet: '', // filled by detail-page enricher
            });
          } catch (e) {
            log.warn?.('linkedin card parse failed', { error: e.message });
          }
        }
      } catch (e) {
        log.error?.('linkedin keyword failed', { url, error: e.message });
      } finally {
        await page.close();
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    await browser.close();
  }

  if (outputPath) {
    await writeFile(
      outputPath,
      JSON.stringify(
        { source: 'linkedin', scrapedAt: new Date().toISOString(), jobs },
        null,
        2,
      ),
    );
  }

  return { count: jobs.length, sample: jobs.slice(0, 5) };
}
