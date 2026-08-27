// src/utils/fingerprint.js
// Dedup key for a job: "company|title|location" lowercased.
//
// v1 source: scripts/daily-job-search.js, around L420 per audit.
//   - jobFingerprint(job) — verbatim except for an extra .trim() at the end
//     so leading/trailing whitespace in scraped fields can't shift the key.

export function jobFingerprint(job) {
  const company = (job && job.company) || '';
  const title = (job && job.title) || '';
  const location = (job && job.location) || '';
  return `${company}|${title}|${location}`.toLowerCase().trim();
}
