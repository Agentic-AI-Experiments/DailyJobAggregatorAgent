// src/utils/secrets.js
// Env-first, secrets.md fallback. Pattern documented in secrets.md.
//
// SHARED SECRETS FILE: as of 2026-08-27, secrets live in ONE neutral file at
//   ~/.openclaw/workspace/secrets.md
// (OpenClaw workspace root, alongside other .md files). Both this project
// and the daily-news-digest-agent read from it. Override with
// OPENCLAW_SECRETS_MD env var for tests / multi-host setups.
//
// Why share: same value of RESEND_API_KEY, EMAIL_FROM, EMAIL_RECIPIENT is
// needed across all OpenClaw crons on this host. Duplicating across each
// project's secrets.md is a security liability (easy to leak on fork) and
// a maintenance pain (rotating one key requires N edits). One canonical
// file at a neutral location is simpler.
//
// v1 source: scripts/daily-job-search.js, top-of-file (L40–58 per audit):
//   readPersonalMdKey + secretFromEnvOrFile, with a project-scoped secrets
//   file. v2 uses the same env-first / file-fallback contract — only the
//   resolved path changed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default: the shared secrets file at the OpenClaw workspace root.
// Override via OPENCLAW_SECRETS_MD env var for tests / multi-host setups.
function getSecretsMdPath() {
  return process.env.OPENCLAW_SECRETS_MD
    || path.join(os.homedir(), '.openclaw', 'workspace', 'secrets.md');
}

// Read a single KEY=VALUE line from secrets.md. Case-insensitive key match,
// optional double or single quotes around the value, ignores blank lines
// and # comments. Returns trimmed value or null.
function readSecretsMdKey(key) {
  const secretsPath = getSecretsMdPath();
  try {
    if (!fs.existsSync(secretsPath)) return null;
    const content = fs.readFileSync(secretsPath, 'utf8');
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