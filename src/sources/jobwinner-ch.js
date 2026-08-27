// jobwinner.ch source scraper
//
// Adapted from v1: scripts/daily-job-search.js (scrapeJobwinnerCh, lines 576-625).
// jobwinner.ch is a SPA — listing cards are rendered client-side, so raw HTTP
// `web_fetch` returns an empty shell. v2 uses the MCP `browser` (Playwright-based)
// tool to render the page, interact with the cookie banner, and run the search.
//
// TODO(fix-ticket): date badge unreliable — see MEMORY.md 2026-08-22.
// v1 hard-codes every job to parseDate('Today'). Preserved here verbatim
// so this PR stays scope-clean; date parsing is tracked separately.

export const META = { name: 'jobwinner.ch', method: 'mcp_browser' };

const SEARCH_URL = 'https://www.jobwinner.ch/en/jobs';
const SEARCH_TERM = 'product manager';
const NAV_TIMEOUT_MS = 60000;
const POST_SEARCH_WAIT_MS = 7000;
const MAX_LINKS = 50;

// TODO: enable the MCP `browser` tool in the OpenClaw config and remove the
// raw-HTTP fallback. Until then, raw HTTP is attempted first (fast, returns
// whatever server-rendered HTML exists) and the SPA-rendered fallback path
// below documents what the MCP browser steps would be.
const RAW_HTTP_QUERY_URL = `${SEARCH_URL}?q=${encodeURIComponent(SEARCH_TERM).replace(/%20/g, '+')}`;

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

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

// Derive a company hint from the card text surrounding the title link.
// Mirrors v1's remainder heuristic (≤80 chars, ≥2 chars, longer than the title).
function deriveCompany(parentText, title) {
  if (!parentText || parentText.length <= (title || '').length) return 'Unknown';
  const remainder = parentText.substring((title || '').length).trim();
  if (remainder.length > 1 && remainder.length < 80) return remainder;
  return 'Unknown';
}

// MCP `browser` interaction plan. The sub-agent invokes the MCP browser tool
// using these tool names; we keep them as a documented recipe rather than
// calling browser_* directly from this module (the MCP tool is provided by
// the host, not by Node).
const MCP_BROWSER_RECIPE = [
  { tool: 'browser_navigate', args: { url: SEARCH_URL } },
  { tool: 'browser_wait_for', args: { selector: '#home-search-input', timeoutMs: NAV_TIMEOUT_MS } },
  { tool: 'browser_click', args: { selector: 'button:has-text("Accept"), button:has-text("Akzeptieren")', optional: true } },
  { tool: 'browser_type', args: { selector: '#home-search-input', text: SEARCH_TERM } },
  { tool: 'browser_press_key', args: { key: 'Enter' } },
  { tool: 'browser_wait_for', args: { selector: 'a[href*="jobwinner.ch/en/job/"]', timeoutMs: NAV_TIMEOUT_MS } },
  { tool: 'browser_sleep', args: { ms: POST_SEARCH_WAIT_MS } },
];

function rawHttpFetch(ctx) {
  // Best-effort fallback: jobwinner.ch is a SPA, so the listing is unlikely
  // to be server-rendered. We still try — a future SSR pass would Just Work.
  // ctx.browser may expose an `httpGet` helper when running under the
  // sub-agent harness; absent that, the orchestrator's transport is used.
  if (ctx.browser && typeof ctx.browser.httpGet === 'function') {
    return ctx.browser.httpGet(RAW_HTTP_QUERY_URL);
  }
  if (typeof ctx.rawFetch === 'function') return ctx.rawFetch(RAW_HTTP_QUERY_URL);
  return null;
}

export default async function scrape(ctx) {
  const jobs = [];
  const log = ctx && typeof ctx.logger === 'function' ? ctx.logger : () => {};

  // ── Path A: MCP browser (preferred) ─────────────────────────────────────
  // The sub-agent driver is expected to execute MCP_BROWSER_RECIPE and
  // hand the rendered HTML back via ctx.renderedHtml. When that contract is
  // wired up, parse it below; until then, fall through to raw HTTP.
  let html = ctx && typeof ctx.renderedHtml === 'string' ? ctx.renderedHtml : null;

  // ── Path B: raw HTTP fallback (current default) ──────────────────────────
  if (!html) {
    log('warn', 'jobwinner.ch: MCP browser not wired, using raw HTTP fallback', {
      recipe: MCP_BROWSER_RECIPE.map((s) => s.tool),
      url: RAW_HTTP_QUERY_URL,
    });
    try {
      html = rawHttpFetch(ctx);
    } catch (e) {
      log('error', 'jobwinner.ch raw HTTP failed', { error: e.message });
      html = null;
    }
  }

  if (!html) {
    log('error', 'jobwinner.ch: no HTML available (browser + raw HTTP both unavailable)', {});
    if (ctx && ctx.outputPath) {
      await writeOutput(ctx.outputPath, { source: 'jobwinner.ch', scrapedAt: new Date().toISOString(), jobs: [], note: 'No HTML available' }, ctx);
    }
    return { count: 0, sample: [] };
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  const links = extractJobLinks(html);

  for (const item of links) {
    const title = (item.text || '').trim();
    if (title.length < 3) continue;
    jobs.push({
      company: deriveCompany(item.parentText, title),
      title,
      location: 'Switzerland',
      // TODO(fix-ticket): date badge unreliable — see MEMORY.md 2026-08-22.
      // v1 hard-codes every job to parseDate('Today'); preserved for now.
      datePosted: todayIso(),
      link: item.href,
      source: 'jobwinner.ch',
      descSnippet: buildDescSnippet(item.parentText),
    });
  }

  log('info', 'jobwinner.ch links parsed', { count: jobs.length });

  if (ctx && ctx.outputPath) {
    await writeOutput(ctx.outputPath, {
      source: 'jobwinner.ch',
      scrapedAt: new Date().toISOString(),
      jobs,
    }, ctx);
  }

  return { count: jobs.length, sample: jobs.slice(0, 5) };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractJobLinks(html) {
  // Lightweight HTML extraction — avoids pulling in a DOM parser dependency.
  // Mirrors v1's selector logic: any <a> whose href contains the job path,
  // capped at MAX_LINKS.
  const out = [];
  const re = /<a\s+[^>]*href=["']([^"']*jobwinner\.ch\/en\/job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = absolutize(m[1]);
    const inner = m[2].replace(/<[^>]{1,200}>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    // Cheap parent-text proxy: take up to 300 chars of the slice around the
    // anchor in the source HTML (sufficient for descSnippet; matches v1 cap).
    const start = Math.max(0, m.index - 400);
    const end = Math.min(html.length, m.index + m[0].length + 400);
    const parentText = html
      .slice(start, end)
      .replace(/<[^>]{1,200}>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    out.push({ href, text: inner, parentText });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

function absolutize(href) {
  if (!href) return href;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return 'https://www.jobwinner.ch' + href;
  return href;
}

async function writeOutput(path, payload, ctx) {
  const fs = ctx && ctx.fs ? ctx.fs : null;
  if (!fs) return; // sub-agent harness owns persistence; nothing to do here
  const dir = path.replace(/[\\/][^\\/]+$/, '');
  if (dir && dir !== path) await fs.mkdir(dir, { recursive: true }).catch(() => {});
  await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}
