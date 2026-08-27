// src/filters/pm-positive.js
//
// Patterns copied verbatim from the v1 daily-job-search agent
// (PM_POSITIVE_TITLE block, ~L360–378 in that script). The regex strings
// are intentionally duplicated here because the v1 file is outside this
// repo's tracked tree.
//
// Validation history: this pattern set has been validated against 100+ real
// job-board emails (jobs.ch, LinkedIn, ICTcareer.ch, job-room.ch, company
// career pages) over the v1 run period. The "restrictive default" stance
// (no positive match = drop the listing) is deliberate; see architecture.md.
//
// DO NOT EDIT the regex strings here without re-running the validation
// harness. Even one character difference can silently break PM filtering.

export const PM_POSITIVE_TITLE = [
  /\bproduct\s+manager\b/i,
  /\bproduct\s+owner\b/i,
  /\bprogram(?:me)?\s+manager\b/i,
  /\bproduct\s+lead\b/i,
  /\bhead\s+of\s+product\b/i,
  /\bv\.?p\.?\s+(of\s+)?product\b/i,
  /\bvp\s+product\b/i,
  /\bdirector.{0,30}\bproduct\b/i,
  /\bcpo\b/i,                        // chief product officer
  /\bproduct\s+strategy\b/i,
  /\btechnical\s+product\b/i,
  /\bproduct\s+specialist\b/i,
  /\bproduct\s+consultant\b/i,
  /\bproduct\s+analyst\b/i,
  /\bgo[\s-]?to[\s-]?market\b/i,
  /\bgtm\s+(manager|lead|specialist)\b/i,
];

/**
 * Test whether a piece of text matches any PM-positive pattern.
 * Caller is responsible for passing the title first and (optionally)
 * the description as a tie-breaker — see matchesPMWithDescription.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function matchesPMPositive(text) {
  if (!text) return false;
  return PM_POSITIVE_TITLE.some(r => r.test(text));
}

/**
 * Two-pass PM check: title first, description as tie-breaker.
 * Mirrors v1's isRelevantForPM logic but without the HARD_NO gate
 * (that's hard-no.js's job).
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {boolean}
 */
export function matchesPMWithDescription(title, description = '') {
  if (matchesPMPositive(title)) return true;
  if (description && matchesPMPositive(description)) return true;
  return false;
}
