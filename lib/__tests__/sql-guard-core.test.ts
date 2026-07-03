/**
 *   node --experimental-strip-types --test lib/__tests__/sql-guard-core.test.ts
 * Pure: read-only SQL guard for the Lab MCP audit_query tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReadOnlySql } from '../sql-guard-core.ts';

test('allows SELECT / WITH and auto-adds LIMIT', () => {
  const a = guardReadOnlySql('SELECT count(*) FROM opd_note_audits');
  assert.ok(a.ok); if (a.ok) assert.match(a.sql, /LIMIT 500$/);
  const b = guardReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x');
  assert.ok(b.ok);
  // a column named "comment" (opd_audit_feedback) must NOT be blocked
  assert.equal(guardReadOnlySql('SELECT comment FROM opd_audit_feedback').ok, true);
  // existing LIMIT under the ceiling is preserved (not doubled)
  const c = guardReadOnlySql('SELECT * FROM opd_note_audits LIMIT 50');
  assert.ok(c.ok); if (c.ok) assert.equal((c.sql.match(/limit/gi) || []).length, 1);
});

test('rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns', () => {
  for (const q of [
    'UPDATE opd_note_audits SET band=\'A\'',
    'DELETE FROM opd_note_audits',
    'DROP TABLE opd_note_audits',
    'SELECT 1; DROP TABLE opd_note_audits',
    'SELECT * INTO evil FROM opd_note_audits',
    'INSERT INTO opd_note_audits VALUES (1)',
    'TRUNCATE opd_note_audits',
    'CREATE TABLE x (a int)',
    'SELECT pg_read_file(\'/etc/passwd\')',
    'SELECT current_setting(\'x\')',
    'VACUUM',
    'EXPLAIN SELECT 1',              // not SELECT/WITH
  ]) {
    assert.equal(guardReadOnlySql(q).ok, false, q);
  }
  const over = guardReadOnlySql('SELECT * FROM opd_note_audits LIMIT 5000');
  assert.equal(over.ok, false);
  assert.equal(guardReadOnlySql('').ok, false);
});

test('honors a smaller caller cap', () => {
  const a = guardReadOnlySql('SELECT 1', 100);
  assert.ok(a.ok); if (a.ok) assert.match(a.sql, /LIMIT 100$/);
  assert.equal(guardReadOnlySql('SELECT 1 LIMIT 300', 100).ok, false); // 300 > caller cap 100
});
