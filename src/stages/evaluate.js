// scripts/evaluate.js — Stage 1 of post-merge pipeline
//
// Loads all 7 state/v2-sources/*.json files, applies PM fit + German-language
// flags, and rates each job's PM fit (0-10) using the description snippet +
// title. Writes state/evaluated-jobs.json. Pure offline — no network calls.
//
// Input:  state/v2-sources/*.json
// Output: state/evaluated-jobs.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFilters } from '../filters/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(PROJECT, 'state');
const V2_SOURCES_DIR = path.join(STATE_DIR, 'v2-sources');
const EVALUATED_FILE = path.join(STATE_DIR, 'evaluated-jobs.json');

function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    src: 'job-aggregator-v2.evaluate',
    msg,
    ...fields,
  });
  console.log(line);
  fs.appendFileSync(path.join(STATE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 17)}Z.jsonl`), line + '\n');
}

// ─── PM-fit rating (0-10) ────────────────────────────────────────────────────
// Score components:
//   • title_match  (0-3): PM-positive title pattern strength
//   • seniority    (0-2): senior/principal/director/lead/head signals boost
//   • domain       (0-2): software/SaaS/fintech/healthtech/etc. signals boost
//   • description  (0-2): description contains PM-role responsibilities
//   • penalty      (-3 to 0): hard-no patterns subtract
//
// Total: 0-10. We keep jobs with score >= 5.

const SENIORITY_BOOST = /\b(senior|principal|staff|director|head\s+of|vp|vice\s+president|lead|chief)\b/i;
const PM_TITLE_KEYWORDS = /\b(product\s+manager|product\s+owner|pm\b|po\b|cpo\b|vpo\b)\b/i;
const PM_RESPONSIBILITIES = /\b(roadmap|backlog|stakeholder|user\s+story|product\s+vision|product\s+strategy|mvp|kpi|okr|go-to-market|gtm|a\/b\s+test|user\s+research|discovery|sprint|release|launch|iteration|feature\s+priority|product\s+spec|prd|user\s+persona|product\s+analytics|retention|engagement|monetization|funnel)\b/i;

function rateFit(job) {
  let score = 0;
  const text = `${job.title || ''} ${job.descSnippet || ''}`.toLowerCase();

  // Title match (0-3)
  if (PM_TITLE_KEYWORDS.test(job.title || '')) score += 3;
  else if (/\b(product|pm)\b/i.test(job.title || '')) score += 1;

  // Seniority (0-2)
  if (SENIORITY_BOOST.test(job.title || '')) score += 2;
  else if (SENIORITY_BOOST.test(job.descSnippet || '')) score += 1;

  // Domain (0-2)
  if (/\b(saas|fintech|healthtech|edtech|marketplace|b2b|b2c|startup|scale-?up|enterprise)\b/i.test(job.descSnippet || '')) score += 1;
  if (/\b(software|platform|mobile|web|cloud|api|devops|data\s+science|ai|ml)\b/i.test(job.descSnippet || '')) score += 1;

  // PM responsibilities in description (0-2)
  const matches = (job.descSnippet || '').match(new RegExp(PM_RESPONSIBILITIES.source, 'gi')) || [];
  if (matches.length >= 5) score += 2;
  else if (matches.length >= 2) score += 1;

  // Penalty for hard-no patterns already handled by applyFilters; no extra deduction here.

  return Math.max(0, Math.min(10, score));
}

async function main() {
  const t0 = Date.now();
  log('info', 'evaluator start');

  // Load all 7 v2-sources files
  const allRaw = [];
  if (!fs.existsSync(V2_SOURCES_DIR)) {
    log('error', 'v2-sources dir missing', { dir: V2_SOURCES_DIR });
    process.exit(1);
  }
  const sourceFiles = fs.readdirSync(V2_SOURCES_DIR).filter(f => f.endsWith('.json'));
  for (const f of sourceFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(V2_SOURCES_DIR, f), 'utf8'));
      const jobs = data.jobs || [];
      log('info', 'source loaded', { source: data.source, count: jobs.length });
      allRaw.push(...jobs);
    } catch (e) {
      log('warn', 'source load failed', { file: f, error: e.message });
    }
  }
  log('info', 'raw jobs loaded', { total: allRaw.length });

  // Apply hard filters (PM-positive, hard-no, German detection, cutoff)
  const filtered = applyFilters(allRaw);
  log('info', 'filtered jobs', { count: filtered.length });

  // Rate each surviving job
  const rated = filtered.map(job => ({
    ...job,
    fitScore: rateFit(job),
  }));

  // Keep fitScore >= 5 (configurable via env FIT_THRESHOLD)
  const threshold = parseInt(process.env.FIT_THRESHOLD || '5', 10);
  const kept = rated.filter(j => j.fitScore >= threshold);
  const dropped = rated.filter(j => j.fitScore < threshold);

  log('info', 'rating done', { kept: kept.length, dropped: dropped.length, threshold });

  // Sort by score desc, then by source for stability
  kept.sort((a, b) => {
    if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
    return (a.source || '').localeCompare(b.source || '');
  });

  const output = {
    evaluatedAt: new Date().toISOString(),
    threshold,
    totalRaw: allRaw.length,
    afterFilters: filtered.length,
    kept: kept.length,
    dropped: dropped.length,
    jobs: kept,
  };
  fs.writeFileSync(EVALUATED_FILE, JSON.stringify(output, null, 2));
  log('info', 'evaluated-jobs.json written', { path: EVALUATED_FILE, jobs: kept.length });

  // Summary
  console.log('\n=== EVALUATOR SUMMARY ===');
  console.log(JSON.stringify({
    source: 'evaluator',
    raw: allRaw.length,
    afterFilters: filtered.length,
    kept: kept.length,
    dropped: dropped.length,
    fitThreshold: threshold,
    topSources: Object.fromEntries(
      Object.entries(kept.reduce((acc, j) => {
        acc[j.source] = (acc[j.source] || 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1])
    ),
    durationMs: Date.now() - t0,
  }, null, 2));
}

main().catch((e) => {
  log('error', 'evaluator crashed', { error: e.message, stack: e.stack });
  process.exit(1);
});
