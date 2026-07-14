#!/usr/bin/env node
/**
 * scripts/reasoning-governance-check.mjs — the governed-layer reporter (Reasoning
 * Observability Stage 1). Run: `npm run reasoning:governance`.
 *
 * READS SOURCE AS TEXT (mirrors scripts/architecture-check.mjs — declarative config,
 * main-guarded, exported for tests). Lists every model call that BYPASSES the governed
 * envelope (lib/trace.ts tracedChat over lib/llm.ts routing) plus the concordance_runs
 * parallel store that is invisible to `traces`.
 *
 * ⚠️ WARN ONLY THIS STAGE (PRD D3): the check prints the ungoverned sites and EXITS 0 —
 * it becomes a hard gate (exit 1) only in Stage 4, after those sites are migrated
 * through tracedChat. Scope: lib/ + app/ (runtime surface); scripts/ are offline
 * harnesses and __tests__ are fixtures — both out of scope.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, walk } from './lib/import-scan.mjs';

// ── declarative config ───────────────────────────────────────────────────────────────────────────
/** The governed layer: the ONLY files allowed to touch a model client directly. */
export const GOVERNED_FILES = new Set(['lib/trace.ts', 'lib/llm.ts']);

/** A direct model CALL (import lines don't match — each pattern requires the call paren). */
export const DIRECT_CALL_PATTERNS = [
  { id: 'chat.completions.create', rx: /\.chat\.completions\.create\s*\(/ },
  { id: 'chatWithFallback', rx: /\bchatWithFallback\s*\(/ },
  { id: 'getGeminiChatClient', rx: /\bgetGeminiChatClient\s*\(/ },
];

/** Run stores parallel to `traces` (results invisible to the trace spine). */
export const PARALLEL_STORE_PATTERNS = [
  { id: 'concordance_runs', rx: /\bconcordance_runs\b/ },
];

// ── the scan (exported for lib/__tests__/reasoning-envelope.test.ts) ─────────────────────────────
export function scanUngoverned() {
  const files = walk(join(ROOT, 'lib'))
    .concat(walk(join(ROOT, 'app')))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'));

  const sites = [];   // { file, line, pattern }
  const stores = [];  // { file, line, pattern }
  for (const file of files) {
    const governed = GOVERNED_FILES.has(file);
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!governed) {
        for (const p of DIRECT_CALL_PATTERNS) {
          if (p.rx.test(lines[i])) sites.push({ file, line: i + 1, pattern: p.id });
        }
      }
      for (const p of PARALLEL_STORE_PATTERNS) {
        if (p.rx.test(lines[i])) stores.push({ file, line: i + 1, pattern: p.id });
      }
    }
  }
  return { sites, stores };
}

// ── run (main-guarded) ───────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { sites, stores } = scanUngoverned();
  const byFile = new Map();
  for (const s of sites) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }

  console.log(`reasoning governance — WARN mode (Stage 1; hard-fail arrives in Stage 4)\n`);
  console.log(`ungoverned model calls (bypass tracedChat): ${sites.length} sites in ${byFile.size} files`);
  for (const [file, list] of [...byFile.entries()].sort()) {
    for (const s of list) console.log(`  WARN ${file}:${s.line} — direct ${s.pattern}`);
  }
  console.log(`\nparallel run stores (invisible to traces): ${stores.length} references`);
  for (const s of stores) console.log(`  WARN ${s.file}:${s.line} — ${s.pattern}`);
  console.log(`\nreasoning:governance — reported ${sites.length + stores.length} warnings; exit 0 (WARN-only this stage).`);
  process.exit(0);
}
