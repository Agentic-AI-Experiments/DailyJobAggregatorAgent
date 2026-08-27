// src/utils/desc-snippet.js
// Strip HTML, collapse whitespace, cap at 4000 chars.
//
// v1 source: scripts/daily-job-search.js, comment block around L300 (buildDescSnippet).
//   - 2026-08-18: cap bumped from 1500 → 4000 in v1 because German-required
//     phrasing ("Du verfügst über sehr gute Deutschkenntnisse...") often lives
//     in the late "What you bring" paragraph. v2 inherits the 4000-char cap
//     per architecture.md §Utils.

const DESC_SNIPPET_CAP = 4000;
const TAG_RE = /<[^>]{1,200}>/g;
const NBSP_RE = /&nbsp;/g;
const ENTITY_RE = /&#?\w+;/g;
const WHITESPACE_RE = /\s+/g;

export function buildDescSnippet(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(TAG_RE, ' ')        // strip HTML tags (capped so a pathological 10MB tag can't OOM us)
    .replace(NBSP_RE, ' ')
    .replace(ENTITY_RE, ' ')     // strip &amp; / &#39; / &#xNN; entities
    .replace(WHITESPACE_RE, ' ') // collapse all whitespace runs (incl. newlines) to a single space
    .trim()
    .slice(0, DESC_SNIPPET_CAP);
}
