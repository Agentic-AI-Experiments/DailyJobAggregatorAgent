// src/email/send.js
//
// Resend SDK wrapper for the job-aggregator-v2 digest email.
//
// Ported from v1 (`scripts/daily-job-search.js`):
//   - Resend instantiation: top of v1, `import { Resend } from 'resend'` then
//     `new Resend(<api key>)` inside sendDigestEmail().
//   - Send call: bottom of v1, `resend.emails.send({ from, to, subject, html })`.
//
// v1 wrapped the SDK response in a try/catch and rethrew as
// `new Error(\`Resend ${result.error.statusCode}: ${result.error.message}\`)`,
// which threw away the structured {name, message, statusCode} fields. Per the
// MEMORY.md note on `email-service.js`, v2 surfaces the SDK's raw error shape
// instead so the orchestrator can branch on statusCode (e.g. 422 unverified
// FROM domain vs. 401 bad API key).
//
// Contract:
//   sendDigest({subject, html, to, from, apiKey})
//     -> { data: { id }, error: null }                  on success
//     -> { data: null, error: { name, message, statusCode } }  on failure
//
// No secrets, no email addresses, no OpenClaw paths. `to`, `from`, and `apiKey`
// are runtime parameters — never hard-coded.

// Dynamic import keeps the module loadable even when the `resend` package
// isn't on the resolution path (e.g. local smoke tests on a fresh checkout
// before `npm install`). The package is fetched once per call — cheap.
let resendModulePromise = null;
async function getResend() {
  if (!resendModulePromise) {
    resendModulePromise = import('resend').then(m => m.Resend);
  }
  return resendModulePromise;
}

export async function sendDigest({ subject, html, to, from, apiKey }) {
  if (!apiKey) {
    return { data: null, error: { name: 'MissingApiKey', message: 'apiKey is required', statusCode: 0 } };
  }
  if (!to) {
    return { data: null, error: { name: 'MissingRecipient', message: 'to is required', statusCode: 0 } };
  }
  if (!from) {
    return { data: null, error: { name: 'MissingFrom', message: 'from is required', statusCode: 0 } };
  }

  const Resend = await getResend();
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({ from, to, subject, html });
  return result;
}
