#!/usr/bin/env node
// scripts/jobwinner-mcp.js
//
// Drives jobwinner.ch via the MCP browser tool. Run from inside an OpenClaw
// agent turn where the `browser` MCP tool is available (the cron job's
// isolated session has this in its toolsAllow).
//
// What it does:
//   1. browser_navigate https://www.jobwinner.ch/en/jobs
//   2. browser_act { kind: "click", ref: cookie-banner-button }    (or skip if no banner)
//   3. browser_act { kind: "fill",   ref: "#home-search-input", text: "product manager", submit: true }
//   4. browser_wait_for { selector: "a[href*='/en/job/']", timeoutMs: 60000 }
//   5. browser_act { kind: "evaluate", fn: "<JS that returns [{href,title,company}]>" }
//   6. Writes the result to state/v2-sources/jobwinner.ch.json in the same
//      schema the orchestrator expects.
//
// The `browser` MCP tool is invoked via the agent's tool surface (e.g.
// `browser({ action: "act", kind: "evaluate", fn: "..." })`). This script is
// intended to be called from an agent turn prompt, not as a standalone CLI —
// standalone CLI runs fall back to the raw HTTP path in src/sources/jobwinner-ch.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'state', 'v2-sources', 'jobwinner.ch.json');

const SEARCH_URL = 'https://www.jobwinner.ch/en/jobs';
const SEARCH_TERM = 'product manager';

// JS that runs inside the rendered page to extract structured job data.
// Returns Array<{href, title, company}>.
const EXTRACT_JS = `
  Array.from(document.querySelectorAll('li[role="button"]')).map(li => {
    const a = li.querySelector('a[href*="/en/job/"]');
    const titleEl = a ? a.textContent : '';
    const companyEl = li.querySelector('p');
    return {
        href: a ? a.href : '',
        title: titleEl ? titleEl.trim() : '',
        company: companyEl ? companyEl.textContent.trim() : 'Unknown',
      };
  }).filter(j => j.href && j.title);
`;

// Steps the agent turn should execute, in order, via the MCP `browser` tool.
// Each step is `browser({ action: ..., ... })` from the agent's perspective.
export const BROWSER_RECIPE = [
  { tool: 'browser', args: { action: 'navigate', url: SEARCH_URL } },
  { tool: 'browser', args: { action: 'wait_for', text: 'Accept', timeoutMs: 30000 } },
  { tool: 'browser', args: { action: 'act', kind: 'click',
    ref: 'button:has-text("Accept"), button:has-text("Akzeptieren")' } },
  { tool: 'browser', args: { action: 'act', kind: 'fill',
    ref: '#home-search-input', text: SEARCH_TERM, submit: true } },
  { tool: 'browser', args: { action: 'wait_for',
    selector: 'a[href*="/en/job/"]', timeoutMs: 60000 } },
  { tool: 'browser', args: { action: 'act', kind: 'evaluate', fn: EXTRACT_JS } },
];

// When invoked as a CLI (no MCP browser available), print the recipe and exit.
console.log('jobwinner.ch MCP browser recipe:');
console.log(JSON.stringify(BROWSER_RECIPE, null, 2));
console.log('\nRun this recipe from inside an OpenClaw agent turn where the');
console.log('"browser" MCP tool is available. The final evaluate step returns');
console.log('Array<{href, title, company}>; write it to:');
console.log(`  ${OUTPUT_PATH}`);
console.log('\nin this schema:');
console.log(JSON.stringify({
  source: 'jobwinner.ch',
  scrapedAt: new Date().toISOString(),
  jobs: [
    { company, title, location: 'Switzerland', datePosted: 'YYYY-MM-DD', link, source: 'jobwinner.ch', descSnippet: '...' },
  ],
}, null, 2));
console.log('\nFor CLI fallback (no MCP), run: node src/orchestrate.js --source=jobwinner.ch --dry-run');
process.exit(0);