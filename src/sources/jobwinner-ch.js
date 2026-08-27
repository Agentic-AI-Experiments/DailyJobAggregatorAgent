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
function extractJobCards(html) {
  // Each card is a <li role="button"> containing:
  //   <h2><a href="/en/job/<id>">{title}</a></h2>
  //   <p class="styled__Subtitle...">{company}</p>
  // (plus footer with location, etc.)
  const out = [];
  const seen = new Set();
  const cardRe = /<li[^>]+role="button"[^>]*>([\s\S]*?)<\/li>/g;
  const titleLinkRe = /<a[^>]+href="(\/en\/job\/(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/;
  const companyRe = /<p[^>]+class="[^"]*Subtitle[^"]*"[^>]*>([^<]+)<\/p>/;
  let m;
  cardRe.lastIndex = 0;
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1];
    const link = titleLinkRe.exec(block);
    if (!link) continue;
    const id = link[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const cm = block.match(companyRe);
    const company = cm ? stripHtml(cm[1]) : 'Unknown';
    out.push({
      id,
      href: 'https://www.jobwinner.ch' + link[1],
      title: stripHtml(link[3]).slice(0, 200),
      company,
    });
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

  // Path 1: MCP browser (PRIMARY when ctx.browser is provided — i.e. cron agent turn).
  // Jobwinner.ch is a Nuxt SPA; raw HTTP only sees the SSR shell (~10 jobs).
  // MCP browser drives the SPA's client-side rendering and extracts ~50+.
  if (typeof ctx.browser === 'function') {
    log('info', 'jobwinner.ch using MCP browser (primary path)');
    try {
      for (const step of BROWSER_RECIPE) {
        await ctx.browser(step.tool, step.args);
      }
      const extract = await ctx.browser('browser_extract', {
        selector: 'a[href*="/en/job/"]',
        fields: ['href', 'innerText'],
      });
      const links = Array.isArray(extract) ? extract : (extract && extract.results) || [];
      log('info', 'jobwinner.ch browser_extract returned', { count: links.length });
      const today = new Date().toISOString().split('T')[0];
      for (const item of links.slice(0, MAX_LINKS)) {
        const text = stripHtml(item.innerText || item.text || '');
        if (!text || text.length < 3) continue;
        // The MCP browser extract may also surface the company name as a sibling
        // element; if the orchestrator's browser MCP returns it, use it.
        const company = stripHtml(item.company || '');
        jobs.push({
          company: company || 'Unknown',
          title: text.slice(0, 200),
          location: 'Switzerland',
          datePosted: today, // TODO(fix-ticket): date badge unreliable
          link: item.href,
          source: 'jobwinner.ch',
          descSnippet: text.slice(0, 4000),
        });
      }
    } catch (e) {
      log('error', 'jobwinner.ch browser recipe failed; falling back to raw HTTP', { error: e.message });
    }
  }

  // Path 2: raw HTTP fallback. Used when:
  //   - CLI invocation (no ctx.browser)
  //   - MCP browser failed and jobs.length === 0
  if (jobs.length === 0) {
    log('info', 'jobwinner.ch using raw-HTTP fallback (SSR shell; expect ~10 jobs but with company names)');
    try {
      const html = await fetchRawHtml(baseUrl);
      const cards = extractJobCards(html);
      log('info', 'jobwinner.ch raw-HTTP cards found', { count: cards.length });
      const today = new Date().toISOString().split('T')[0];
      for (const item of cards) {
        jobs.push({
          company: item.company,
          title: item.title,
          location: 'Switzerland',
          datePosted: today,
          link: item.href,
          source: 'jobwinner.ch',
          descSnippet: `${item.title} — ${item.company}`.slice(0, 4000),
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