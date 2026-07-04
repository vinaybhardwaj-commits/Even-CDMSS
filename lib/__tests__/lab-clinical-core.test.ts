/**
 *   node --experimental-strip-types --test lib/__tests__/lab-clinical-core.test.ts
 * Pure: NDJSON reducers for the Lab MCP lab_ddx / lab_ask probes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNdjson, reduceDdxEvents, reduceAskEvents, extractCitationIds, labSelfBaseUrl,
} from '../lab-clinical-core.ts';

test('parseNdjson tolerates blank + garbled lines', () => {
  const raw = '{"type":"a"}\n\n{bad json}\n{"type":"b","n":2}\n';
  const ev = parseNdjson(raw);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].n, 2);
});

test('reduceDdxEvents folds a full stream', () => {
  const ev = parseNdjson([
    JSON.stringify({ type: 'sources', items: [{ n: 1 }, { n: 2 }], plos: [{ n: 1 }] }),
    JSON.stringify({ type: 'critique', severity: 'minor', issue_count: 2 }),
    JSON.stringify({ type: 'result', data: {
      summary: 'chest pain ddx',
      cannot_miss: [{ diagnosis: 'ACS' }, { diagnosis: 'PE' }],
      most_likely: [{ diagnosis: 'GERD' }],
      other: [{ diagnosis: 'Costochondritis' }],
    } }),
    JSON.stringify({ type: 'done', ms: 1000 }),
  ].join('\n'));
  const p = reduceDdxEvents(ev);
  assert.equal(p.ok, true);
  assert.equal(p.error, null);
  assert.deepEqual(p.cannot_miss, ['ACS', 'PE']);
  assert.deepEqual(p.most_likely, ['GERD']);
  assert.equal(p.n_sources, 2);
  assert.equal(p.n_plos, 1);
  assert.equal(p.critique_severity, 'minor');
  assert.equal(p.critique_issue_count, 2);
});

test('reduceDdxEvents surfaces an error stream as not-ok', () => {
  const ev = parseNdjson(JSON.stringify({ type: 'error', message: 'no excerpts above threshold' }));
  const p = reduceDdxEvents(ev);
  assert.equal(p.ok, false);
  assert.match(p.error || '', /no excerpts/);
});

test('extractCitationIds pulls distinct sorted numeric ids', () => {
  assert.deepEqual(extractCitationIds('foo [2] bar [1] baz [2] and [10]'), [1, 2, 10]);
  assert.deepEqual(extractCitationIds('no cites here'), []);
});

test('reduceAskEvents keeps the revised answer, flags uncited', () => {
  // draft tokens, then superseded, then the revised run — reducer keeps only the revised text
  const ev = parseNdjson([
    JSON.stringify({ type: 'sources', items: [{ n: 1 }], plos: [] }),
    JSON.stringify({ type: 'token', content: 'DRAFT answer no cite' }),
    JSON.stringify({ type: 'draft_superseded', reason: '1 issue' }),
    JSON.stringify({ type: 'token', content: 'Final answer grounded [1].' }),
    JSON.stringify({ type: 'done', ms: 900 }),
  ].join('\n'));
  const p = reduceAskEvents(ev);
  assert.equal(p.ok, true);
  assert.equal(p.revised, true);
  assert.equal(p.answer, 'Final answer grounded [1].');
  assert.deepEqual(p.citation_ids, [1]);
  assert.equal(p.uncited, false);
});

test('reduceAskEvents flags a long uncited answer (cite-or-label canary)', () => {
  const ev = parseNdjson([
    JSON.stringify({ type: 'token', content: 'This is a sufficiently long clinical answer with absolutely no bracketed citations anywhere.' }),
    JSON.stringify({ type: 'done' }),
  ].join('\n'));
  const p = reduceAskEvents(ev);
  assert.equal(p.uncited, true);
  assert.deepEqual(p.citation_ids, []);
});

test('labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost', () => {
  assert.equal(labSelfBaseUrl({ LAB_SELF_BASE_URL: 'https://x.app/' }), 'https://x.app');
  assert.equal(labSelfBaseUrl({ VERCEL_URL: 'even-cdmss.vercel.app' }), 'https://even-cdmss.vercel.app');
  assert.equal(labSelfBaseUrl({}), 'http://localhost:3000');
});
