// src/filters/hard-no.js
//
// Patterns copied verbatim from the v1 daily-job-search agent
// (HARD_NO_TITLE block, immediately after PM_POSITIVE_TITLE in the same
// ~L360–378 range). The regex strings are intentionally duplicated here
// because the v1 file is outside this repo's tracked tree.
//
// Validation history: validated against 100+ real job-board emails.
// This is the "universal-not-PM" list — card-bug noise from boards,
// healthcare roles, trades. Independent of source. Short and stable by
// design: do not grow it without re-validation. Anything that
// consistently leaks through should arguably become a positive-pattern
// refinement instead.
//
// DO NOT EDIT the regex strings here without re-running the validation
// harness. Even one character difference can silently break filtering.

export const HARD_NO_TITLE = [
  /^\s*$/,                         // empty title
  /sign\s+in/i, /\blog\s+in/i, /check\s+link/i,  // card-bugs
  /\barzt\b/i, /\bpflegefach/i, /\bpflegehelfer/i,
  /\bapotheker\b/i, /\bzahnarzt\b/i, /\bphysiotherapeut\b/i,
  /\bchauffeur\b/i, /\bkoch\b/i, /\breinigung\b/i, /\bschreiner\b/i, /\bmfa\b/i,
];

/**
 * Test whether a title matches any hard-no pattern.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function matchesHardNo(text) {
  if (!text) return true; // empty title → hard-no
  return HARD_NO_TITLE.some(r => r.test(text));
}
