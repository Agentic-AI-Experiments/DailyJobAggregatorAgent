// src/email/template.js
//
// HTML digest template for the job-aggregator-v2 email.
//
// Ported from v1 (`scripts/daily-job-search.js`, `buildDigestHtml` function).
// v1 columns: # | Company | Job Title | Location | Date Posted | German | Link.
// v2 keeps the same column order so existing muscle memory and "open in
// inbox, scan top-to-bottom" workflows still work.
//
// Inline styles only — email clients (Gmail, Outlook) strip <style> blocks.
// Mobile-friendly via max-width:100% on tables and stack-friendly row widths.
//
// renderDigest(jobs, options?) -> { subject, html }
//   - jobs: Array<{ company, title, location, datePosted, link, source, germanRequired }>
//   - options.date    : overrides the date in the subject/header (defaults to today, ISO YYYY-MM-DD)
//   - options.recipient: optional, currently unused by HTML body but reserved for
//                        future "Hi {{recipient}}" personalisation. Never log this.
//
// Subject format: "Daily PM digest — N new job(s) — YYYY-MM-DD"
// Singular "job" when N === 1, "jobs" otherwise (per task requirement #6).
//
// No secrets, no email addresses, no OpenClaw paths. Recipient is never
// hard-coded.

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

export function renderDigest(jobs, options = {}) {
  const date = options.date || todayIso();
  const count = Array.isArray(jobs) ? jobs.length : 0;
  const noun = count === 1 ? 'job' : 'jobs';
  const subject = `Daily PM digest \u2014 ${count} new ${noun} \u2014 ${date}`;

  const rows = (Array.isArray(jobs) ? jobs : []).map((j, i) => `
    <tr style="border-bottom:1px solid #eee;">
      <td style="padding:10px 8px;font-size:13px;color:#222;vertical-align:top;width:140px;"><strong>${htmlEscape(j.company || 'Unknown')}</strong></td>
      <td style="padding:10px 8px;font-size:13px;color:#222;vertical-align:top;">
        <a href="${htmlEscape(j.link)}" style="color:#1a73e8;text-decoration:none;font-weight:600;">${htmlEscape(j.title || '')}</a>
      </td>
      <td style="padding:10px 8px;font-size:12px;color:#555;vertical-align:top;width:140px;">${htmlEscape(j.location || 'Switzerland')}</td>
      <td style="padding:10px 8px;font-size:12px;color:#555;vertical-align:top;width:90px;white-space:nowrap;">${htmlEscape(j.datePosted || '')}</td>
      <td style="padding:10px 8px;font-size:12px;vertical-align:top;width:70px;white-space:nowrap;">
        <a href="${htmlEscape(j.link)}" style="color:#1a73e8;text-decoration:none;">Apply &rarr;</a>
      </td>
      <td style="padding:10px 8px;font-size:12px;vertical-align:top;width:80px;white-space:nowrap;">
        ${j.germanRequired
          ? '<span style="background:#fef3c7;color:#92400e;padding:3px 8px;border-radius:3px;font-size:11px;white-space:nowrap;">Yes</span>'
          : '<span style="color:#999;font-size:11px;">No</span>'}
      </td>
      <td style="padding:10px 8px;font-size:12px;color:#555;vertical-align:top;width:90px;">${htmlEscape(j.source || '')}</td>
    </tr>`).join('');

  const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily PM digest</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;"><tr><td style="padding:20px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:980px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
<tr><td style="padding:24px 20px;background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);border-radius:8px 8px 0 0;">
<h1 style="margin:0;font-size:20px;color:#fff;text-align:center;">Daily PM digest</h1>
<p style="margin:6px 0 0 0;text-align:center;color:rgba(255,255,255,0.9);font-size:13px;">${htmlEscape(date)} &middot; ${count} new ${noun}</p>
</td></tr>
<tr><td style="padding:0 0 4px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;">
  <thead>
    <tr style="background:#f8f9fa;border-bottom:2px solid #e0e0e0;">
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:140px;">Company</th>
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Title</th>
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:140px;">Location</th>
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:90px;">Posted</th>
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:70px;">Link</th>
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:80px;">German?</th>
      <th style="padding:10px 8px;text-align:left;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:90px;">Source</th>
    </tr>
  </thead>
  <tbody>${rows || '<tr><td colspan="7" style="padding:24px;text-align:center;color:#999;font-size:13px;">No new jobs today.</td></tr>'}</tbody>
</table>
</td></tr>
<tr><td style="padding:16px 20px;text-align:center;border-top:1px solid #eee;background:#fafafa;border-radius:0 0 8px 8px;">
<p style="margin:0;color:#999;font-size:11px;">job-aggregator-v2 &middot; daily PM digest</p>
</td></tr>
</table></td></tr></table>
</body></html>`.trim();

  return { subject, html };
}
