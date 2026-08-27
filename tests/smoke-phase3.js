// Smoke tests for Phase 3 modules. Run with: node tests/smoke-phase3.js
import { PM_POSITIVE_TITLE } from '../src/filters/pm-positive.js';
import { HARD_NO_TITLE } from '../src/filters/hard-no.js';
import { detectGerman, detectGermanWithBodyFallback } from '../src/filters/german-detector.js';
import { jobFingerprint } from '../src/utils/fingerprint.js';
import { buildDescSnippet } from '../src/utils/desc-snippet.js';
import { renderDigest } from '../src/email/template.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

console.log('Pattern counts:');
check('PM_POSITIVE_TITLE.length', PM_POSITIVE_TITLE.length, 16);
check('HARD_NO_TITLE.length', HARD_NO_TITLE.length, 15);

console.log('\nGerman detector:');
check('(m/w/d) → false', detectGerman('(m/w/d)', 'irrelevant'), false);
check('Verhandlungssichere → true', detectGerman('Verhandlungssichere Deutschkenntnisse', ''), true);
check('Good German required → true', detectGerman('Good German required', ''), true);
check('no German required → false', detectGerman('PM', 'no German required'), false);

console.log('\nBody-language fallback:');
const germanBody = 'Du verfügst über sehr gute Deutschkenntnisse und kannst dich fliessend auf Deutsch unterhalten. Wir suchen einen erfahrenen Product Manager mit nachweislicher Erfahrung in der agilen Softwareentwicklung und einem tiefen Verständnis für die Schweizer Marktbedingungen. Du arbeitest eng mit dem Engineering-Team zusammen und übersetzt Kundenfeedback in klare Anforderungen. Du bringst deine Erfahrung im Bereich B2B-SaaS mit und hast bereits erfolgreich Produkte von der Idee bis zur Markteinführung begleitet. Du bist ein echter Teamplayer und kommunizierst offen und transparent mit allen Stakeholdern. Du verfügst über sehr gute Englischkenntnisse und kannst auch in einem internationalen Umfeld sicher agieren. Wir bieten dir ein dynamisches Umfeld mit viel Gestaltungsspielraum und attraktiven Anstellungsbedingungen.';
check('long German body → true', detectGermanWithBodyFallback('PM', germanBody), true);

console.log('\nFingerprint:');
check('Acme|PM|Zurich → acme|pm|zurich', jobFingerprint({ company: 'Acme', title: 'PM', location: 'Zurich' }), 'acme|pm|zurich');

console.log('\nDesc-snippet:');
const longSnippet = '<p>x</p>'.repeat(3000);
check('over-cap string → ≤4000 chars', buildDescSnippet(longSnippet).length <= 4000, true);
check('HTML stripped', buildDescSnippet('<p>Hello <b>world</b></p>'), 'Hello world');

console.log('\nTemplate:');
const oneJob = [{ company: 'Acme', title: 'Senior PM', location: 'Zurich', datePosted: '2026-08-27', link: 'https://x.com', source: 'jobs.ch', germanRequired: false }];
const t = renderDigest(oneJob);
check('subject includes count', t.subject.includes('1 new job'), true);
check('subject includes date', t.subject.includes('2026-08-27'), true);
check('html is non-empty string', typeof t.html === 'string' && t.html.length > 100, true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
