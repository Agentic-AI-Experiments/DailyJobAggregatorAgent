#!/usr/bin/env node
/**
 * Unit tests for src/utils/secrets.js — env-first / secrets.md fallback.
 *
 * Run: node tests/test-secrets.js
 *
 * The secrets loader is shared across 2 projects (job-aggregator-v2,
 * daily-news-digest-agent) and 4 cron scripts. Bugs here cause silent
 * "no email" failures. Heavy coverage on the resolution order.
 *
 * Strategy: write a temp secrets.md, point OPENCLAW_SECRETS_MD at it,
 * invoke secretFromEnvOrFile with various permutations.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

function checkTruthy(label, actual) {
  if (actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — expected truthy, got ${JSON.stringify(actual)}`); }
}

function checkFalsy(label, actual) {
  if (!actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — expected falsy, got ${JSON.stringify(actual)}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
const SECRETS_PATH = path.join(TMP, 'secrets.md');

// Helper: dynamically import the loader with the OPENCLAW_SECRETS_MD env pointing at our temp file.
async function withSecrets(envVars, fileContent, fn) {
  // Write secrets file (or leave absent)
  if (fileContent !== null) fs.writeFileSync(SECRETS_PATH, fileContent);
  else if (fs.existsSync(SECRETS_PATH)) fs.unlinkSync(SECRETS_PATH);

  // Save and set env
  const saved = {};
  for (const k of Object.keys(envVars)) {
    saved[k] = process.env[k];
    if (envVars[k] === null) delete process.env[k];
    else process.env[k] = envVars[k];
  }
  process.env.OPENCLAW_SECRETS_MD = SECRETS_PATH;

  // Reload the module to pick up the new env
  const mod = await import(`../src/utils/secrets.js?ts=${Date.now()}`);

  try {
    await fn(mod);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.OPENCLAW_SECRETS_MD;
  }
}

// ─── Env takes precedence ────────────────────────────────────────────────────

console.log('\nEnv takes precedence over secrets.md:');
await withSecrets(
  { RESEND_API_KEY: 'env-key-123' },
  'RESEND_API_KEY=file-key-456',
  async ({ secretFromEnvOrFile }) => {
    check('env value wins', secretFromEnvOrFile('RESEND_API_KEY'), 'env-key-123');
  }
);

// ─── File fallback when env is unset ────────────────────────────────────────

console.log('\nFile fallback when env unset:');
await withSecrets(
  { RESEND_API_KEY: null },
  'RESEND_API_KEY=file-key-456',
  async ({ secretFromEnvOrFile }) => {
    check('file value returned', secretFromEnvOrFile('RESEND_API_KEY'), 'file-key-456');
  }
);

// ─── File fallback when env is empty string ─────────────────────────────────

console.log('\nFile fallback when env is empty string:');
await withSecrets(
  { RESEND_API_KEY: '' },
  'RESEND_API_KEY=file-key-456',
  async ({ secretFromEnvOrFile }) => {
    // Empty string is falsy, so file fallback should kick in
    check('empty env → file', secretFromEnvOrFile('RESEND_API_KEY'), 'file-key-456');
  }
);

// ─── Both missing → null ─────────────────────────────────────────────────────

console.log('\nBoth missing → null:');
await withSecrets(
  { RESEND_API_KEY: null },
  null, // no secrets file
  async ({ secretFromEnvOrFile }) => {
    check('null when both missing', secretFromEnvOrFile('RESEND_API_KEY'), null);
  }
);

// ─── Multiple keys in one file ───────────────────────────────────────────────

console.log('\nMultiple keys in one file:');
await withSecrets(
  { RESEND_API_KEY: null, EMAIL_FROM: null, EMAIL_RECIPIENT: null },
  `RESEND_API_KEY=re_abc123
EMAIL_FROM=onboarding@resend.dev
EMAIL_RECIPIENT=user@example.com
`,
  async ({ secretFromEnvOrFile }) => {
    check('RESEND_API_KEY', secretFromEnvOrFile('RESEND_API_KEY'), 're_abc123');
    check('EMAIL_FROM', secretFromEnvOrFile('EMAIL_FROM'), 'onboarding@resend.dev');
    check('EMAIL_RECIPIENT', secretFromEnvOrFile('EMAIL_RECIPIENT'), 'user@example.com');
  }
);

// ─── Quoted values ──────────────────────────────────────────────────────────

console.log('\nQuoted values:');
await withSecrets(
  { RESEND_API_KEY: null },
  `RESEND_API_KEY="re_double_quoted"
EMAIL_FROM='single_quoted'
`,
  async ({ secretFromEnvOrFile }) => {
    check('double-quoted', secretFromEnvOrFile('RESEND_API_KEY'), 're_double_quoted');
    check('single-quoted', secretFromEnvOrFile('EMAIL_FROM'), 'single_quoted');
  }
);

// ─── Comments and blank lines ───────────────────────────────────────────────

console.log('\nComments and blank lines:');
await withSecrets(
  { RESEND_API_KEY: null },
  `# This is a comment
RESEND_API_KEY=re_after_comment

# Another comment
EMAIL_FROM=after_blank
`,
  async ({ secretFromEnvOrFile }) => {
    check('skips comment lines', secretFromEnvOrFile('RESEND_API_KEY'), 're_after_comment');
    check('skips blank lines', secretFromEnvOrFile('EMAIL_FROM'), 'after_blank');
  }
);

// ─── Substring safety ───────────────────────────────────────────────────────

console.log('\nSubstring safety:');
await withSecrets(
  { RESEND_API_KEY: null },
  `FOO=bar
RESEND_API_KEY=correct
RESEND_API_KEY_WRONG=should_not_match
`,
  async ({ secretFromEnvOrFile }) => {
    check('does not match RESEND_API_KEY_WRONG as RESEND_API_KEY', secretFromEnvOrFile('RESEND_API_KEY'), 'correct');
  }
);

// ─── Missing key in file → null ─────────────────────────────────────────────

console.log('\nMissing key in file:');
await withSecrets(
  { NONEXISTENT_KEY: null },
  'RESEND_API_KEY=re_abc',
  async ({ secretFromEnvOrFile }) => {
    check('null for key not in file', secretFromEnvOrFile('NONEXISTENT_KEY'), null);
  }
);

// ─── Cleanup ─────────────────────────────────────────────────────────────────

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);