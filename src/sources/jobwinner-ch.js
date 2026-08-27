// src/sources/jobwinner-ch.js
// jobwinner.ch scraper for v2.
//
// jobwinner.ch is an SPA — the search results are rendered client-side.
// For an MCP-driven agent (cron / browser MCP available), use the BROWSER
// recipe below; for a CLI invocation (no browser MCP), fall back to raw
// HTTP and accept that we'll only see links that the server pre-rendered
// (typically a small subset, often 0 — the SPA shell doesn't expose them).
//
// v1 behaviour: Playwright + cookie banner click + wait. v2 inherits the
// same recipe but also has a raw-HTTP fallback so the CLI works.
//
// TODO(fix-ticket): date badge unreliable — see MEMORY.md 2026-08-22.
// v1 hard-codes every job to today. Preserved here verbatim.

export const META = { name: 'jobwinner.ch', method: 'mcp_browser' };

const SEARCH_URL = 'https://www.jobwinner.ch/en/jobs';
const SEARCH_TERM = 'product manager';
const NAV_TIMEOUT_MS = 60000;
const MAX_LINKS = 50;

const stripHtml = (s) => (s || '')
  .replace(/<[^>]{1,200}>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

// ── Raw-HTTP fallback (CLI invocation) ───────────────────────────────────────
//
// Server returns a Nuxt SSR shell that already contains /en/job/<numeric-id>
// anchors for the top listings. Match them and produce bare-bones job records.
// Title is taken from the anchor's inner text; company + date are not exposed
// in the listing HTML (they're rendered client-side) — we mark them Unknown
// and let the descSnippet carry whatever parent text we can find.
function extractJobLinks(html) {
  const out = [];
  const re = /<a\s+[^>]*href=["']([^"']*\/en\/job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].startsWith('http') ? m[1] : 'https://www.jobwinner.ch' + m[1];
    const text = stripHtml(m[2]);
    if (!text || text.length < 3) continue;
    const start = Math.max(0, m.index - 400);
    const end = Math.min(html.length, m.index + m[0].length + 400);
    const parentText = stripHtml(html.slice(start, end)).slice(0, 4000);
    out.push({ href, text, parentText });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

async function fetchRawHtml(searchUrl) {
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
  });
  if (!res.ok) throw new Error('fetch failed: ' + res.status);
  return res.text();
}

// ── Browser recipe (MCP-driven agent invocation) ─────────────────────────────
//
// Used when ctx.browser is provided (MCP browser tool). Records the recipe as
// a constant so future integration can call it verbatim.
const BROWSER_RECIPE = [
  { tool: 'browser_navigate', args: { url: SEARCH_URL } },
  { tool: 'browser_wait_for', args: { text: 'Accept', timeoutMs: NAV_TIMEOUT_MS } },
  { tool: 'browser_click', args: { selector: 'button:has-text("Accept"), button:has-text("Akzeptieren")' } },
  { tool: 'browser_type', args: { selector: '#home-search-input', text: SEARCH_TERM, submit: true } },
  { tool: 'browser_wait_for', args: { selector: 'a[href*="/en/job/"]', timeoutMs: NAV_TIMEOUT_MS } },
  { tool: 'browser_extract', args: { selector: 'a[href*="/en/job/"]', fields: ['href', 'innerText'] } },
];

export default async function scrape(ctx) {
  const { logger, manifest, outputPath } = ctx;
  const log = (lvl, msg, extra) => {
    if (typeof logger === 'function') return logger(lvl, msg, { source: META.name, ...(extra || {}) });
    if (logger && typeof logger[lvl] === 'function') return logger[lvl](msg, { source: META.name, ...(extra || {}) });
    return null;
  };

  const myEntry = manifest && manifest.sources && manifest.sources.find((s) => s.name === 'jobwinner.ch');
  const baseUrl = (myEntry && myEntry.searchUrl) || `${SEARCH_URL}?q=${encodeURIComponent(SEARCH_TERM)}`;

  const jobs = [];

  // Path 1: MCP browser if available
  if (typeof ctx.browser === 'function') {
    log('info', 'jobwinner.ch using MCP browser recipe');
    try {
      for (const step of BROWSER_RECIPE) {
        await ctx.browser(step.tool, step.args);
      }
      const links = (await ctx.browser('browser_extract', { selector: 'a[href*="/en/job/"]' })) || [];
      for (const item of links.slice(0, MAX_LINKS)) {
        const text = stripHtml(item.innerText || item.text || '');
        if (!text || text.length < 3) continue;
        const today = new Date().toISOString().split('T')[0];
        jobs.push({
          company: 'Unknown',
          title: text.slice(0, 200),
          location: 'Switzerland',
          datePosted: today, // TODO(fix-ticket): date badge unreliable
          link: item.href,
          source: 'jobwinner.ch',
          descSnippet: text.slice(0, 4000),
        });
      }
    } catch (e) {
      log('error', 'jobwinner.ch browser recipe failed', { error: e.message });
    }
  }

  // Path 2: raw HTTP fallback
  if (jobs.length === 0) {
    log('info', 'jobwinner.ch using raw-HTTP fallback');
    try {
      const html = await fetchRawHtml(baseUrl);
      const links = extractJobLinks(html);
      log('info', 'jobwinner.ch raw-HTTP links found', { count: links.length });
      const today = new Date().toISOString().split('T')[0];
      for (const item of links) {
        jobs.push({
          company: 'Unknown',
          title: item.text.slice(0, 200),
          location: 'Switzerland',
          datePosted: today,
          link: item.href,
          source: 'jobwinner.ch',
          descSnippet: item.parentText.slice(0, 4000),
        });
      }
    } catch (e) {
      log('error', 'jobwinner.ch raw HTTP failed', { error: e.message });
    }
  }

  try {
    if (ctx.fs) {
      await ctx.fs.mkdir(outputPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true }).catch(() => {});
      await ctx.fs.writeFile(outputPath, JSON.stringify({
        source: 'jobwinner.ch',
        scrapedAt: new Date().toISOString(),
        jobs,
      }, null, 2), 'utf8');
    } else {
      const fs = await import('node:fs/promises');
      await fs.mkdir(outputPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify({
        source: 'jobwinner.ch',
        scrapedAt: new Date().toISOString(),
        jobs,
      }, null, 2), 'utf8');
    }
  } catch (e) {
    log('warn', 'jobwinner.ch writeFile failed', { error: e.message });
  }

  log('info', 'jobwinner.ch parsed', { count: jobs.length });
  return { count: jobs.length, sample: jobs.slice(0, 5) };
}