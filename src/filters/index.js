// src/filters/index.js — Shared filter pipeline (date cutoff + PM relevance + German detection)
//
// Used by both src/orchestrate.js (legacy single-process mode) and the new
// stages/evaluate.js sub-agent. Pure functions, no side effects.

import { matchesPMPositive } from './pm-positive.js';
import { matchesHardNo } from './hard-no.js';
import { detectGermanWithBodyFallback } from './german-detector.js';

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

export function applyFilters(jobs, options = {}) {
  const cutoffStr = options.cutoffStr || getCutoffStr();
  const cutoffOk = jobs.filter(j => (j.datePosted || '') >= cutoffStr);
  const pmFiltered = cutoffOk.filter(isRelevant);
  const withGerman = pmFiltered.map(j => ({
    ...j,
    germanRequired: detectGermanWithBodyFallback(j.title, j.descSnippet),
  }));
  return withGerman;
}
