// src/filters/index.js — Shared filter pipeline (date cutoff + PM relevance + geo scope + German detection)
//
// Used by both src/orchestrate.js (legacy single-process mode) and the new
// stages/evaluate.js sub-agent. Pure functions, no side effects.

import { matchesPMPositive } from './pm-positive.js';
import { matchesHardNo } from './hard-no.js';
import { detectGermanWithBodyFallback } from './german-detector.js';
import { passesGeographicScope } from './geo-scope.js';

const DEFAULT_CUTOFF_DAYS = parseInt(process.env.CUTOFF_DAYS || '14', 10);

function getCutoffStr(days = DEFAULT_CUTOFF_DAYS) {
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

function isRelevant(job) {
  if (matchesHardNo(job.title)) return false;
  if (matchesPMPositive(job.title)) return true;
  if (job.descSnippet && matchesPMPositive(job.descSnippet)) return true;
  return false;
}

function isInGeoScope(job) {
  // Soft variant (parity with v1 daily-job-search.js): unknown locations pass
  // through. Drop only when the job explicitly names a non-EU, non-remote city.
  return passesGeographicScope(job.location || '', job.descSnippet || '');
}

export function applyFilters(jobs, options = {}) {
  const cutoffStr = options.cutoffStr || getCutoffStr();
  const cutoffOk = jobs.filter(j => (j.datePosted || '') >= cutoffStr);
  const pmFiltered = cutoffOk.filter(isRelevant);
  // Geo filter runs after PM-positive (we want to know it's a PM role first)
  // and before evaluate's rateFit (don't waste a rating cycle on US-only roles).
  const geoFiltered = pmFiltered.filter(isInGeoScope);
  const withGerman = geoFiltered.map(j => ({
    ...j,
    germanRequired: detectGermanWithBodyFallback(j.title, j.descSnippet),
  }));
  return withGerman;
}

// Exported for testability + for downstream stages that want to re-check geo
// without re-running the full filter pipeline.
export { isRelevant, isInGeoScope, getCutoffStr };

