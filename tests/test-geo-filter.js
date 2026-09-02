// tests/test-geo-filter.js — Geographic scope filter (added 2026-09-02)
//
// Tests for src/filters/geo-scope.js passesGeographicScope(). Soft variant:
// unknown locations pass through; only explicit non-EU + non-remote drops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passesGeographicScope } from '../src/filters/geo-scope.js';

const KEEP = (loc, desc = '') => assert.equal(passesGeographicScope(loc, desc), true, `expected KEEP: ${loc}`);
const DROP = (loc, desc = '') => assert.equal(passesGeographicScope(loc, desc), false, `expected DROP: ${loc}`);

test('CH tokens (German + French + Italian + Romansh)', () => {
  KEEP('Switzerland');
  KEEP('Zürich');
  KEEP('Zurich');
  KEEP('Geneva');
  KEEP('Genève');
  KEEP('Bern');
  KEEP('Basel');
  KEEP('Lausanne');
  KEEP('Lugano');
  KEEP('Sankt Gallen');
  KEEP('St. Gallen');
  KEEP('CH-based');
  KEEP('Schweiz');
  KEEP('Suisse');
  KEEP('Svizzera');
  KEEP('Svizra');
  KEEP('Thurgau');
  KEEP('Ticino');
  KEEP('Graubünden');
});

test('explicit EU cities (27 EU + EFTA + UK)', () => {
  KEEP('Berlin');
  KEEP('Amsterdam');
  KEEP('Paris');
  KEEP('London');
  KEEP('Dublin');
  KEEP('Barcelona');
  KEEP('Madrid');
  KEEP('Milan');
  KEEP('Rome');
  KEEP('Stockholm');
  KEEP('Copenhagen');
  KEEP('Helsinki');
  KEEP('Oslo');
  KEEP('Vienna');
  KEEP('Prague');
  KEEP('Brussels');
  KEEP('Lisbon');
  KEEP('Athens');
  KEEP('Warsaw');
  KEEP('Budapest');
  KEEP('Tallinn');
  KEEP('Riga');
  KEEP('Vilnius');
});

test('explicit remote tokens', () => {
  KEEP('Remote');
  KEEP('Fully remote');
  KEEP('Remote-friendly');
  KEEP('Remote OK');
  KEEP('Anywhere');
  KEEP('Worldwide');
  KEEP('EU-remote');
  KEEP('Europe remote');
  KEEP('EMEA remote');
  KEEP('Work from home');
  KEEP('WFH');
  KEEP('Distributed-first');
  KEEP('Async-first');
  KEEP('Timezone-friendly');
});

test('explicit non-EU cities drop (unless remote token)', () => {
  DROP('San Francisco');
  DROP('San Francisco, CA');
  DROP('New York');
  DROP('NYC');
  DROP('Boston');
  DROP('Seattle');
  DROP('Austin');
  DROP('Chicago');
  DROP('Los Angeles');
  DROP('Mountain View');
  DROP('Sunnyvale');
  DROP('Palo Alto');
  DROP('Cupertino');
  DROP('Menlo Park');
  DROP('Brooklyn');
  DROP('Manhattan');
  DROP('Toronto');
  DROP('Vancouver');
  DROP('Montreal');
  DROP('São Paulo');
  DROP('Buenos Aires');
  DROP('Mumbai');
  DROP('Bangalore');
  DROP('Bengaluru');
  DROP('Delhi');
  DROP('Hyderabad');
  DROP('Pune');
  DROP('Chennai');
  DROP('Shanghai');
  DROP('Beijing');
  DROP('Shenzhen');
  DROP('Hong Kong');
  DROP('Tokyo');
  DROP('Singapore');
  DROP('Sydney');
  DROP('Melbourne');
  DROP('Auckland');
  DROP('Tel Aviv');
  DROP('Seoul');
});

test('non-EU + remote token = KEEP (remote wins)', () => {
  KEEP('San Francisco', 'Fully remote, work from anywhere in EU');
  KEEP('NYC', 'Remote-friendly');
  KEEP('Mountain View', 'EMEA remote');
});

test('description-derived geo signals', () => {
  // Snowflake example: locations mixed US/EU
  KEEP('See thread', 'Snowflake | Forward Deployed Engineer, Product Manager | Menlo Park, CA | Warsaw, Poland | London, UK | ONSITE');
  // Sourcegraph remote
  KEEP('See thread', 'Sourcegraph | Remote | Full-Time | Security Engineer, SWE, Tech Lead, Agent Engineer, Product Manager');
  // Wikimedia "REMOTE (US + 18 countries)" - the "remote" keyword wins
  KEEP('See thread', 'Wikimedia Foundation | Lead Product Manager, Security | REMOTE (US + 18 countries) | Full-time');
});

test('unknown / global / empty = KEEP (soft variant)', () => {
  KEEP('');
  KEEP(undefined);
  KEEP(null);
  KEEP('See thread');
  KEEP('Remote (no city specified)');
  KEEP('Europe');
});

test('EU mention with no contradiction', () => {
  KEEP('EU', 'Looking for a product manager to join our EU team');
  KEEP('Europe', 'European Union');
});

test('hard cases', () => {
  // Just "Remote" with no city - KEEP (soft)
  KEEP('Remote');
  // "Zurich" alone
  KEEP('Zurich');
  // "Zurich, Switzerland"
  KEEP('Zurich, Switzerland');
  // "Zürich, CH"
  KEEP('Zürich, CH');
  // Multi-city with US + EU
  KEEP('Menlo Park / Warsaw / London');
});
