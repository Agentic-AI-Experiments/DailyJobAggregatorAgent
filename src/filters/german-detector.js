// src/filters/german-detector.js
//
// 3-tier German-language requirement detector. Patterns and constants are
// copied verbatim from the v1 daily-job-search agent
// (detectGerman / detectBodyLanguage / detectGermanWithBodyFallback —
// same ~L178–313 range in that script). They are intentionally duplicated
// here because the v1 file is outside this repo's tracked tree.
//
// Validation history: validated against 100+ real job-board emails (jobs.ch,
// LinkedIn, ICTcareer.ch, job-room.ch, company career pages) over the v1
// run period. Tier 1 (explicit-phrase regex) catches ~92% of postings with
// a German language requirement. Tier 2 (body-language fallback) catches
// Swiss postings written entirely in German that never use the explicit
// "Deutschkenntnisse erforderlich" phrase.
//
// 3-tier design rationale:
//   Tier 1 (explicit phrase) — high precision, low recall. We only return
//     true if a strong explicit signal matches; exclusion patterns can
//     override (e.g. "no German required" wins over a stray "German" word).
//   Tier 2 (body-language) — high recall for CH postings, but noisy on
//     short snippets. Gated on desc length >= 200 chars and >= 30 word
//     tokens to avoid false positives on partial scrapes. Does NOT
//     respect exclusion patterns by design: a posting that says
//     "kein Deutsch erforderlich" but is written entirely in German is
//     still a German-language role in practice (just at a company that
//     happens to be OK with English-only candidates). Flagging it as
//     German is the safer default for the email digest — the human
//     reader can skim past a false positive more easily than they can
//     spot a missed German-required role.
//   Tier 3 (wrapper) — composes tiers 1+2. Used by the main pipeline;
//     cheap callers (orchestrator dedup) call detectGerman directly.
//
// DO NOT EDIT the regex strings here without re-running the validation
// harness. The INF/INF_CHARS template-literal constants and the umlaut
// character class /[äöüßÄÖÜ]/g are load-bearing.

// ─── Tier 1: explicit-phrase detector ───────────────────────────────────────

/**
 * Test whether the title/description explicitly states a German
 * language requirement. Returns true if a German/English positive
 * pattern matches AND no exclusion pattern matches.
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {boolean}
 */
export function detectGerman(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();

  // German adjective inflection: covers -e, -es, -er, -em, -en + optionally more
  // trailing characters (e.g. "verhandlungssicherem Deutsch").
  const INF = '(?:e|es|er|em|en)?';
  const INF_CHARS = '(?:e|es|er|em|en)?\\w*';

  const germanPatterns = [
    // Strong level-describing phrases
    new RegExp(`verhandlungssich${INF_CHARS}\\s+deutsch`, 'gi'),
    new RegExp(`verhandlungssich${INF_CHARS}\\s+deutsc\\w*`, 'gi'),
    new RegExp(`ausgezeichnet${INF}\\s+deutsch`, 'gi'),
    new RegExp(`ausgezeichnet${INF}\\s+deutsc\\w*`, 'gi'),
    new RegExp(`perfekt${INF}\\s+deutsch`, 'gi'),
    new RegExp(`perfekt${INF}\\s+deutsc\\w*`, 'gi'),
    new RegExp(`sehr\\s+gute${INF}\\s+deutsch`, 'gi'),
    new RegExp(`sehr\\s+gute${INF}\\s+deutsc\\w*`, 'gi'),
    new RegExp(`gute${INF}\\s+deutsch`, 'gi'),
    new RegExp(`gute${INF}\\s+deutschkenntnis`, 'gi'),
    new RegExp(`gute${INF}\\s+deutsc\\w+`, 'gi'),
    new RegExp(`fundiert${INF}\\s+deutsch`, 'gi'),
    new RegExp(`fundiert${INF}\\s+deutsc\\w*`, 'gi'),
    new RegExp(`solid${INF}\\s+deutsch`, 'gi'),
    new RegExp(`solid${INF}\\s+deutsc\\w*`, 'gi'),
    new RegExp(`sicher${INF}\\s+in\\s+deutsch`, 'gi'),
    new RegExp(`sicher${INF}\\s+deutsch`, 'gi'),
    new RegExp(`muttersprach(?:ler|lich|e|es|er|em|en|in|nen)?\\s+deutsch`, 'gi'),
    /deutsch\s+als\s+muttersprache/gi,
    /muttersprache\s+deutsch/gi,
    /(?:deutscher|deutsche|deutsches|deutschem|deutschen)\s+muttersprachler/gi,
    /muttersprachler(?:in)?\s+(?:deutsch|für\s+deutsch)/gi,
    new RegExp(`muttersprachlich${INF}\\s*deutsch`, 'gi'),
    /native\s+deutsch/gi,
    new RegExp(`flie(?:ß|ss)end${INF}\\s+deutsch`, 'gi'),
    /(?:c1|c2)\s*-?\s*deutsch/gi,
    /deutsch\s+(?:ist\s+)?(?:als\s+)?(?:notwendig|erforderlich|pflicht|voraussetzung)/gi,
    /deutsch\s+kenntnisse/gi,
    /deutschkenntnisse\s+(?:sind\s+)?(?:ein\s+)?(?:muss|must[\s-]?have)/gi,
    /deutschkenntnisse\s+(?:sind\s+)?(?:erforderlich|notwendig|pflicht|vorausgesetzt|gesetzt)/gi,
    /deutsch\s+in\s+wort\s+und\s+schrift/gi,
    /deutsch\s+in\s+wort\s+&\s+schrift/gi,
    /zwingend\s+deutsch|deutsc\s+zwingend/gi,
    /deutsch\s+muss/gi,
    /(?:bringst|hast|habe|haben|verfügt?|verfügst)\s+(?:über\s+)?deutsch/gi,
    /(?:bringst|hast|habe|haben|verfügt?|verfügst)\s+(?:über\s+)?deutsc/gi,
    /beherrsch(?:t|en|t)\s+deutsch/gi,
    /beherrsch(?:t|en|t)\s+deutsc/gi,
    // Conversational / business fluency phrasing
    /(?:umgangssprachliche|konversation|konversations|geschaeftssprachliche|geschäftssprachliche|verhandlungssicher)\w*\s+deutsch/gi,
    /(?:deutschkenntnisse|deutsch\s*-\s*kenntnisse)\s+(?:mit|auf|von)\s+(?:c1|c2|b2|b1)/gi,
    // Bilingual combo phrases often used in CH postings
    /deutsch\s*\+\s*englisch/gi,
    /deutsch\s+und\s+englisch\s+(?:verhandlungssicher|fluent|required|erforderlich|muttersprache)/gi,
    // "You have very good German and English skills" style (English variant)
    /(?:very\s+|really\s+)?(?:good|great|excellent|strong|advanced|fluent)\s+german\b/gi,
  ];

  const englishPatterns = [
    /german\s+(?:language\s+)?required/gi,
    /german\s+proficiency/gi,
    /german\s+(?:language\s+)?skills?\s+(?:required|necessary)/gi,
    /good\s+(?:german|level\s+german)/gi,
    /fluent\s+(?:in\s+)?german/gi,
    /excellent\s+german/gi,
    /advanced\s+german/gi,
    /strong\s+german/gi,
    /solid\s+german/gi,
    /mandatory[:\s]+\s*german/gi,
    /must\s+(?:have|be)\s+german/gi,
    /german\s+(?:is\s+)?(?:essential|crucial|imperative|mandatory)/gi,
    /german\s+\(c1\)|german\s+\(c2\)/gi,
    /german\s+:\s+(?:c1|c2|fluent|professional)/gi,
    /german\s+mother\s+tongue|german\s+native/gi,
    /native\s+german\s+speaker/gi,
    /business\s+(?:english\s+and\s+)?german/gi,
    /english\s+and\s+german/gi,
    /german\s+and\s+english/gi,
  ];
  const exclusionPatterns = [
    /no\s+german|kein\s+deutsch/gi,
    /german\s+not\s+required|german\s+unnecessary/gi,
    /german\s+(?:is\s+)?a\s+plus|deutsc\s+von\s+vorteil/gi,
    /german\s+(?:is\s+)?beneficial|deutsc\s+wünschenswert/gi,
    /german\s+nice\s+to\s+have/gi,
    /german\s+desirable/gi,
  ];

  // Many of these patterns use /g; reset lastIndex after .test() so
  // the same RegExp instance behaves correctly across calls.
  const matchesAny = (arr) => arr.some(p => { const m = p.test(text); p.lastIndex = 0; return m; });
  if (matchesAny(exclusionPatterns)) return false;
  return matchesAny(germanPatterns) || matchesAny(englishPatterns);
}

// ─── Tier 2: body-language fallback ─────────────────────────────────────────
//
// Swiss job postings are sometimes written entirely in German without ever
// saying "Deutschkenntnisse erforderlich" — they just assume you can read
// German. The explicit-phrase detector above misses these. As a fallback
// we look at the language the body itself is written in.
//
// Two signals combined (either trips it):
//   1. Stopword ratio: % of body word tokens that are common German words.
//      Threshold 0.10 — Romer's Hausbäckerei hits ~12%, SBB ~23%, English
//      postings stay below 5%.
//   2. Umlaut/Eszett density: ß/ä/ö/ü per 1000 chars. Threshold 4 — pure
//      German narrative postings have ~10-15, English postings < 1.
//
// Requires description length >= 200 chars to avoid noise on short snippets.

/**
 * Tier 2 body-language fallback. Returns true if the description looks
 * like it was written in German (high stopword ratio or high umlaut
 * density), even without an explicit "Deutschkenntnisse" phrase.
 *
 * @param {string} [description]
 * @returns {boolean}
 */
export function detectBodyLanguage(description = '') {
  if (!description || description.length < 200) return false;
  const tokens = description.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (tokens.length < 30) return false;
  const germanStopwords = new Set([
    'der','die','das','und','mit','du','wir','sind','sich','auch','auf','für','ein','eine',
    'von','dem','den','im','zur','zum','ist','nicht','sowie','werden','kann','mehr','sehr',
    'gut','dass','diese','dieser','diesem','einem','einer','eines','alle','allen','als','aus',
    'bei','durch','gegen','haben','hat','kann','kein','keine','muss','müssen','nach','noch',
    'nur','oder','ohne','sehr','soll','sollte','über','um','und','uns','unser','unsere',
    'unter','viel','vom','von','vor','während','wenn','wer','wie','wieder','will','wird',
    'wurde','wurden','zu','zum','zur','zuständig','zwischen','bist','dann','dort','euch',
    'ihnen','ihre','ihrem','ihren','ihrer','ihres','kannst','machen','macht','sich',
  ]);
  const germanCount = tokens.filter(t => germanStopwords.has(t)).length;
  const ratio = germanCount / tokens.length;
  const umlautCount = (description.match(/[äöüßÄÖÜ]/g) || []).length;
  const umlautDensity = umlautCount / description.length * 1000;
  return ratio >= 0.10 || umlautDensity >= 4;
}

// ─── Tier 3: wrapper ────────────────────────────────────────────────────────
//
// Wrapper: explicit-phrase detection OR body-language fallback.
// (Body-language fallback does NOT trigger exclusions — if a posting says
// "kein Deutsch erforderlich" AND is in German, that's a legit English-only
// role at a German-speaking company. Explicit phrase still wins.)

/**
 * Tier 3 wrapper. Returns true if either the explicit-phrase detector
 * (Tier 1) or the body-language fallback (Tier 2) flags German.
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {boolean}
 */
export function detectGermanWithBodyFallback(title, description = '') {
  if (detectGerman(title, description)) return true;
  return detectBodyLanguage(description);
}
