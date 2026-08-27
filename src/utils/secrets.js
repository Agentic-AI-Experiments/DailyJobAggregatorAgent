// src/utils/secrets.js
// Env-first, secrets.md fallback. Pattern documented in secrets.md.
//
// v1 source: scripts/daily-job-search.js, top-of-file (L40–58 per audit):
//   readPersonalMdKey + secretFromEnvOrFile, with a project-scoped secrets
//   file. v2 uses the same env-first / file-fallback contract.
//
// v2 path: this module resolves secrets.md as a sibling of the project root
// (relative to this file via __dirname), NOT via the v1 home-directory
// location. Keeping secrets.md in the project root means the file travels
// with the repo when forked and is covered by the daily personalisation
// backup. The file is gitignored + restored from the backup archive (see
// architecture.md §Security). Requirement: do not hard-code any host or
// workspace path here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// src/utils/secrets.js → ../../ = project root, then secrets.md.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_MD = path.join(PROJECT_ROOT, 'secrets.md');

// Read a single KEY=VALUE line from secrets.md. Case-insensitive key match,
// optional double or single quotes around the value, ignores blank lines
// and # comments. Returns trimmed value or null.
function readSecretsMdKey(key) {
  try {
    if (!fs.existsSync(SECRETS_MD)) return null;
    const content = fs.readFileSync(SECRETS_MD, 'utf8');
    // Anchored on each line so a stray substring match in free text is impossible.
    // The value group excludes ", ', \r, \n so quoted and unquoted forms both parse.
    const re = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"'\\r\\n]+?)"?\\s*$`, 'mi');
    const m = content.match(re);
    return m ? m[1].trim() : null;
  } catch {
    // secrets.md is best-effort. Never throw on a missing/unreadable file —
    // callers handle null as "not configured" and degrade gracefully.
    return null;
  }
}

// Returns process.env[envName] if set & non-empty, else the matching line in
// secrets.md, else null. Mirrors the v1 secretFromEnvOrFile contract.
export function secretFromEnvOrFile(envName) {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return readSecretsMdKey(envName);
}
