// Geographic scope filter (added 2026-09-02)
//
// Sam's filter: Switzerland + EU-friendly remote. PM roles only.
//
// Strategy: require an EXPLICIT positive signal (CH/EU city/region OR explicit
// remote token). If neither is found, keep the job so Sam can dismiss it
// manually — but drop only when the location string EXPLICITLY names a non-EU,
// non-remote country. This is the "soft" variant (parity with v1
// daily-job-search.js's passesGeographicScope).
//
// Examples (all "keep"):
//   "Snowflake | ... Menlo Park, CA | Warsaw, Poland | London, UK"
//   "Wikimedia Foundation | ... REMOTE (US + 18 countries)"
//   "Sourcegraph | Remote | Full-Time"
//
// Examples (all "drop"):
//   "Vitalize | San Francisco (hybrid)"   (purely US)
//   "Child Mind Institute | NYC"           (purely US)
//
// The geo filter runs AFTER the PM-positive + hard-no filters and BEFORE the
// rateFit evaluator. We don't want to waste a rateFit cycle on US-only PM
// roles — but we also don't want to drop roles that mention an EU city in
// passing because they're globally remote-friendly.

const EU_CITIES = /\b(berlin|amsterdam|paris|london|dublin|barcelona|madrid|milan|rome|stockholm|copenhagen|helsinki|oslo|vienna|prague|brussels|lisbon|athens|warsaw|budapest|tallinn|riga|vilnius|sofia|zagreb|nicosia|bucharest|belgrade|sarajevo|skopje|tirana|podgorica|pristina|ljubljana|bratislava|reykjavik|geneva|gen[eè]ve|z[uü]rich|z[uü]rcher|basel|bern|lausanne|lugano|lucerne|luzern|winterthur|st\. ?gallen|sankt ?gallen|san ?gallo|fribourg|freiburg|neuch[aâ]tel|sion|aargau|thurgau|ticino|vaud|valais|wallis|graub[üu]nden|grisons|appenzell|schaffhausen|schwyz|uri|obwalden|nidwalden|glarus|jura|solothurn|zug)\b/i;

// Cities/regions that EXPLICITLY indicate non-EU, non-remote. Match against
// description + location combined so a "Remote role, San Francisco" post is
// kept (Remote token wins) but a plain "San Francisco, CA" is dropped.
const HARD_NON_EU_CITIES = /\b(san ?francisco|san ?jose|new ?york|nyc|boston|seattle|austin|chicago|los ?angeles|la\s*,?\s*california|mountain ?view|sunnyvale|palo ?alto|cupertino|menlo ?park|redwood ?city|san ?mateo|santa ?clara|brooklyn|manhattan|toronto|vancouver|montreal|mexico ?city|s[aã]o ?paulo|buenos ?aires|mumbai|bangalore|bengaluru|delhi|hyderabad|pune|chennai|shanghai|beijing|shenzhen|hong ?kong|tokyo|osaka|kyoto|singapore|taipei|sydney|melbourne|brisbane|perth|auckland|wellington|tel ?aviv|jerusalem|seoul|lagos|cape ?town|johannesburg|nairobi|jakarta|bangkok|kuala ?lumpur|manila|ho ?chi ?minh|hanoi)\b/i;

const CH_KEYWORDS = /\b(switzerland|schweiz|suisse|svizzera|svizra|ch[- ]?based|ch[- ]?remote)\b/i;
const REMOTE_KEYWORDS = /\b(anywhere|worldwide|global ?remote|fully ?remote|work ?from ?home|wfh|distributed[- ]first|async[- ]first|timezone[- ]friendly|eu[- ]?remote|europe[- ]?remote|emea[- ]?remote|remote[- ]friendly|remote[- ]ok)\b/i;

/**
 * Returns true if the job passes the geographic scope filter.
 * "Soft" variant: unknown locations pass through (Sam can dismiss in digest).
 *
 * @param {string} location  Job location string (may include city, region, country)
 * @param {string} [description]  Optional full description for additional context
 * @returns {boolean}
 */
function passesGeographicScope(location, description = '') {
  const text = `${location || ''} ${description || ''}`;
  if (REMOTE_KEYWORDS.test(text)) return true;   // explicit remote-friendly
  if (CH_KEYWORDS.test(text)) return true;        // explicit Switzerland
  if (EU_CITIES.test(text)) return true;          // explicit EU/CH city
  if (/\beu[- ]?based|\beuropean ?union|\beurope\b/i.test(text) && !HARD_NON_EU_CITIES.test(text)) return true;  // "EU" without contradiction
  // Hard drop only if explicitly non-EU AND no remote token
  if (HARD_NON_EU_CITIES.test(text) && !REMOTE_KEYWORDS.test(text)) return false;
  return true; // unknown / global - let through, Sam can dismiss in digest
}

export { passesGeographicScope, EU_CITIES, HARD_NON_EU_CITIES, CH_KEYWORDS, REMOTE_KEYWORDS };
