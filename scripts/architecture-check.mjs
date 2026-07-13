#!/usr/bin/env node
/**
 * scripts/architecture-check.mjs — the CDMSS import-boundary checker (Architecture Governance
 * Slice 1, Part B). Run: `npm run architecture:check` (node --import tsx, matching the scripts
 * idiom — tsx is unused at runtime but keeps the invocation uniform).
 *
 * READS SOURCE AS TEXT — never executes app code. Scans import/export-from/require/dynamic-import
 * statements in the guarded modules and exits non-zero on any violation, printing
 * `file:line — rule N — <what crossed>`.
 *
 * RULES ARE DECLARATIVE CONFIG (below): each rule is { id, name, sourceGlobs, forbid, valueOnly }.
 *   sourceGlobs — which files the rule guards ('**' spans directories, '*' within a segment).
 *   forbid      — RegExps tested against the NORMALISED import path (alias `@/` → repo root;
 *                 relative specifiers resolved against the importing file; extension stripped).
 *   valueOnly   — true ⇒ `import type { … }` and all-`type` specifier imports are ALLOWED;
 *                 only VALUE imports violate (rule 3's type-sharing line). false ⇒ any import form.
 * Adding a rule later is a one-entry change. See docs/architecture/INVENTORY.md for the map.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── the four boundary rules (Slice 1) ────────────────────────────────────────────────────────────
const RULES = [
  {
    id: 1,
    name: 'pure clinical cores must not reach up into the app',
    sourceGlobs: ['lib/clinical-state/**', 'lib/member-state/**', 'lib/opd-note-score-core.ts', 'lib/opd-longitudinal-core.ts'],
    forbid: [/^(app|components)\//],
    valueOnly: false,
  },
  {
    id: 2,
    name: 'advisory must not import score arithmetic (finding types/identity from opd-note-audit-core ARE allowed)',
    sourceGlobs: ['lib/opd-longitudinal*', 'lib/opd-triage-core.ts'],
    forbid: [/(^|\/)opd-note-score-core$/],
    valueOnly: false,
  },
  {
    id: 3,
    name: 'the spine runs no audit/score logic (VALUE imports; `import type` is allowed)',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [
      /(^|\/)opd-note-score-core$/,
      /(^|\/)opd-note-audit(-core)?$/,
      /(^|\/)opd-longitudinal[^/]*$/,
      /(^|\/)formulary[^/]*$/,
    ],
    valueOnly: true,
  },
  {
    id: 4,
    name: 'the spine must not couple to a prediction layer',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [/prediction/],
    valueOnly: false,
  },
];

// ── glob → RegExp ('**' spans segments, '*' within one) ─────────────────────────────────────────
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

// ── repo walk (source files only; skip node_modules/.next/tests' fixtures stay in scope) ─────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

// ── import extraction (text-level, multiline-tolerant) ───────────────────────────────────────────
// Captures: static `import … from '…'`, bare `import '…'`, `export … from '…'`,
// dynamic `import('…')`, and `require('…')`. Records whether the form is type-only.
const IMPORT_RE = /\bimport\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bexport\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]|\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;

function extractImports(text) {
  const found = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8];
    if (!spec) continue;
    let typeOnly = false;
    if (m[1] !== undefined || m[5] !== undefined) typeOnly = true;           // import type / export type … from
    else if (m[3] !== undefined) {
      // `import <clause> from '…'` — type-only when EVERY named specifier carries `type`
      const clause = (m[2] || '').trim();
      const inner = clause.startsWith('{') ? clause.replace(/^\{|\}$/g, '') : null;
      if (inner !== null && inner.trim().length > 0) {
        typeOnly = inner.split(',').map((s) => s.trim()).filter(Boolean)
          .every((s) => /^type\s/.test(s));
      }
    }
    const line = text.slice(0, m.index).split('\n').length;
    found.push({ spec, typeOnly, line });
  }
  return found;
}

// ── specifier → normalised repo-relative module path (no extension) ──────────────────────────────
function normaliseSpec(spec, fromFile) {
  let p = null;
  if (spec.startsWith('@/')) p = spec.slice(2);
  else if (spec.startsWith('.')) p = relative(ROOT, resolve(ROOT, dirname(fromFile), spec));
  else return { path: spec, external: true };                  // bare package — external
  return { path: p.replace(/\.(ts|tsx|mts|js|mjs)$/, ''), external: false };
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────────
const allFiles = walk(join(ROOT, 'lib')).concat(walk(join(ROOT, 'scripts')));
const violations = [];
const evaluated = [];

for (const rule of RULES) {
  const matchers = rule.sourceGlobs.map(globToRegExp);
  const files = allFiles.filter((f) => matchers.some((rx) => rx.test(f)));
  let ruleViolations = 0;
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const imp of extractImports(text)) {
      const { path: target, external } = normaliseSpec(imp.spec, file);
      // externals only matter for rules that pattern-match bare names (rule 4's /prediction/)
      const testable = external ? rule.forbid.filter((rx) => rx.source.includes('prediction')) : rule.forbid;
      if (rule.valueOnly && imp.typeOnly) continue;             // rule 3's `import type` allowance
      for (const rx of testable) {
        if (rx.test(target)) {
          ruleViolations++;
          violations.push(`${file}:${imp.line} — rule ${rule.id} — ${rule.valueOnly ? 'value ' : ''}import of '${imp.spec}' crosses "${rule.name}"`);
        }
      }
    }
  }
  evaluated.push({ id: rule.id, name: rule.name, files: files.length, violations: ruleViolations });
}

for (const r of evaluated) {
  const status = r.violations === 0 ? 'GREEN' : `RED (${r.violations})`;
  console.log(`rule ${r.id} · ${status} · ${r.files} files scanned · ${r.name}`);
}
if (violations.length) {
  console.error('\nBOUNDARY VIOLATIONS:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`\narchitecture:check — all ${RULES.length} rules green.`);
