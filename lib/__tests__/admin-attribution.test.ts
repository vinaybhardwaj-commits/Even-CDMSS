/**
 *   node --test --import tsx lib/__tests__/admin-attribution.test.ts
 *
 * Phase D — attribution (PRD §12.4, decision 16; closes addendum §1.3 B.1-4).
 *
 * THE GAP: admin auth is a shared token with no user identity, so the version history rendered
 * "v3 · 2026-07-27 · Unknown" and reviewer notes had no author. The columns already existed
 * (`scoring_policy_versions.published_by_name`, `ipd_audit_feedback.reviewed_by_name`); nothing
 * wrote them.
 *
 * The properties that decide whether this shipped correctly:
 *   · REQUIRED wherever a rationale is required, and rejected SERVER-SIDE too — a client that skips
 *     the field must not succeed;
 *   · persisted VERBATIM after trimming — no normalisation, no roster;
 *   · ONE localStorage key behind all three prefill points;
 *   · labelled as an ATTESTATION, never as authentication;
 *   · NO migration, NO backfill — existing Unknown/null rows stay exactly as they are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  MIN_ATTRIBUTION_CHARS, MAX_ATTRIBUTION_CHARS,
  ATTRIBUTION_LABEL, ATTRIBUTION_HELP, ATTRIBUTION_REQUIRED_ERROR,
  isValidAttribution, cleanAttribution,
} from '../admin-attribution.ts';

/** Code only — comments legitimately name the storage APIs, to stop anyone re-adding them. */
const codeOf = (src: string) =>
  src.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');

const PUBLISH = readFileSync('app/api/scoring-policy/publish/route.ts', 'utf8');
const IMPORT_ = readFileSync('app/api/scoring-policy/lab-packages/import/route.ts', 'utf8');
const REVIEW = readFileSync('app/api/ipd-audit/review/route.ts', 'utf8');
const UI_WEIGHTS = readFileSync('app/admin/scoring-policy/ui.tsx', 'utf8');
const UI_PACKAGES = readFileSync('app/admin/scoring-policy/lab-packages/ui.tsx', 'utf8');
const UI_REVIEW = readFileSync('app/admin/ipd-audit/[id]/review-panel.tsx', 'utf8');
const HISTORY = readFileSync('app/admin/scoring-policy/nabh-completeness/history/page.tsx', 'utf8');

const ALL_UI = [UI_WEIGHTS, UI_PACKAGES, UI_REVIEW];
const ALL_ROUTES = [PUBLISH, IMPORT_, REVIEW];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE VALIDATOR — verbatim, no normalisation
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a name is required and must survive a trim at >= 2 characters', () => {
  assert.equal(MIN_ATTRIBUTION_CHARS, 2);
  for (const bad of ['', ' ', '  ', 'x', ' a ', null, undefined, 42, {}, []]) {
    assert.equal(isValidAttribution(bad), false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(cleanAttribution(bad), null);
  }
  for (const good of ['VB', 'binita', 'Dr Binita Priyambada', '  Dr B  ']) {
    assert.equal(isValidAttribution(good), true);
  }
});

test('PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster', () => {
  // Both of these are acceptable input; the point is a human-readable record, not a foreign key.
  assert.equal(cleanAttribution('Dr Binita Priyambada'), 'Dr Binita Priyambada');
  assert.equal(cleanAttribution('binita'), 'binita');
  assert.equal(cleanAttribution('  binita  '), 'binita', 'trimmed');
  assert.equal(cleanAttribution('BINITA'), 'BINITA', 'case is preserved exactly');
  assert.equal(cleanAttribution('x'.repeat(500))?.length, MAX_ATTRIBUTION_CHARS, 'capped, not rejected');
  // No normalisation of internal whitespace or punctuation.
  assert.equal(cleanAttribution('Dr.  B.  Priyambada'), 'Dr.  B.  Priyambada');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · NO PREFILL, ANYWHERE (decision 17 — reverses the §12.4 localStorage prefill)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A remembered name offers the LAST person's name to the NEXT one on a shared browser: someone
// publishes without re-reading the field and the governance log confidently names the wrong person.
// A WRONG NAME IS WORSE THAN NO NAME — it reads as authoritative and gets relied on.

test('THE RULE: no browser storage API is referenced from ANY of the three surfaces', () => {
  const BANNED = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches.'];
  for (const [name, src] of [['weights modal', UI_WEIGHTS], ['packages panel', UI_PACKAGES], ['review panel', UI_REVIEW]] as const) {
    const code = codeOf(src);
    for (const api of BANNED) {
      assert.ok(!code.includes(api), `${name} must not touch ${api} — decision 17 forbids any prefill`);
    }
  }
});

test('the storage helpers and the key are GONE from the shared module', () => {
  const src = readFileSync('lib/admin-attribution.ts', 'utf8');
  const code = codeOf(src);
  for (const gone of ['ATTRIBUTION_STORAGE_KEY', 'rememberedAttribution', 'rememberAttribution', 'localStorage']) {
    assert.ok(!code.includes(gone), `${gone} must not survive decision 17`);
  }
  // The module still earns its place: the validator and the shared strings live here.
  assert.ok(code.includes('export function cleanAttribution'));
  assert.ok(code.includes('export function isValidAttribution'));
  assert.ok(code.includes('export const ATTRIBUTION_REQUIRED_ERROR'));
});

test('EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint', () => {
  // The name state is initialised to the empty string, with no effect populating it afterwards.
  assert.ok(UI_WEIGHTS.includes("const [changedBy, setChangedBy] = useState('');"));
  assert.ok(UI_PACKAGES.includes("const [changedBy, setChangedBy] = useState('');"));
  assert.ok(UI_REVIEW.includes("const [reviewedBy, setReviewedBy] = useState('');"));
  // The setter may appear EXACTLY twice: the useState declaration and the field's onChange. A third
  // occurrence means something else writes the name — an effect, a restore, a "last used" hint.
  for (const [name, src, setter] of [
    ['weights modal', UI_WEIGHTS, 'setChangedBy'],
    ['packages panel', UI_PACKAGES, 'setChangedBy'],
    ['review panel', UI_REVIEW, 'setReviewedBy'],
  ] as const) {
    const n = (codeOf(src).match(new RegExp(`${setter}\\(`, 'g')) || []).length;
    assert.equal(n, 1, `${name}: ${setter} must be called ONLY from onChange — nothing may prefill it`);
    assert.ok(codeOf(src).includes(`, ${setter}] = useState('')`), `${name}: declared empty`);
  }
  // The review panel must NOT prefill from the stored author either — same failure mode.
  assert.ok(!UI_REVIEW.includes('useState(initial?.reviewedByName'),
    'prefilling from the existing review would attribute the next editor’s words to the original reviewer');
  // …though the recorded author is still DISPLAYED on the saved header.
  assert.ok(UI_REVIEW.includes("saved.reviewedByName ?? 'Unknown'"));
});

test('the name is still typed fresh and still sent by all three surfaces', () => {
  for (const [name, src] of [['weights modal', UI_WEIGHTS], ['packages panel', UI_PACKAGES], ['review panel', UI_REVIEW]] as const) {
    assert.ok(/from '@\/lib\/admin-attribution'/.test(src), `${name} must use the shared validator`);
    assert.ok(/isValidAttribution\(/.test(src), `${name} must still validate before submitting`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · REQUIRED, AND REJECTED SERVER-SIDE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE SAFETY PROPERTY: every route rejects a missing name, not just the UI', () => {
  for (const [name, src] of [['publish', PUBLISH], ['lab-packages import', IMPORT_], ['review', REVIEW]] as const) {
    assert.ok(/cleanAttribution\(/.test(src), `${name} must validate with the shared helper`);
    assert.ok(/ATTRIBUTION_REQUIRED_ERROR/.test(src), `${name} must reject with the shared message`);
    assert.ok(/status: 400/.test(src), `${name} must reject with 400`);
  }
});

test('the routes persist the CLEANED value, not the raw body field', () => {
  assert.ok(PUBLISH.includes('publishedByName: changedBy,'),
    'publish must persist the validated name, not a re-read of the body');
  assert.ok(IMPORT_.includes('publishedByName: changedBy,'));
  assert.ok(REVIEW.includes('const reviewedByName = cleanAttribution('));
  // The old permissive `typeof … ? slice : null` reads must be gone from the name path.
  for (const src of [PUBLISH, IMPORT_]) {
    assert.ok(!/publishedByName: typeof body\.published_by_name/.test(src),
      'the unvalidated passthrough must be replaced');
  }
});

test('the UI disables the action until BOTH rationale and name are filled', () => {
  assert.ok(UI_WEIGHTS.includes("const ok = rationale.trim().length >= 10 && isValidAttribution(changedBy);"));
  assert.ok(UI_PACKAGES.includes("rationale.trim().length >= 10 && isValidAttribution(changedBy)"));
  assert.ok(UI_REVIEW.includes('if (!isValidAttribution(reviewedBy))'));
});

test('the name is actually SENT by all three surfaces', () => {
  assert.ok(/published_by_name: changedBy\.trim\(\)/.test(UI_WEIGHTS));
  assert.ok(/published_by_name: changedBy\.trim\(\)/.test(UI_PACKAGES));
  assert.ok(/reviewedByName: reviewedBy\.trim\(\)/.test(UI_REVIEW));
});

test('the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing', () => {
  // The name check must sit AFTER the noChange short-circuit, or re-uploading an unmodified export
  // would start failing with "your name is required" instead of quietly creating no version (§7.3).
  const noChangeIdx = IMPORT_.indexOf('if (diff.isEmpty)');
  const nameIdx = IMPORT_.indexOf('const changedBy = cleanAttribution(');
  assert.ok(noChangeIdx > 0 && nameIdx > noChangeIdx,
    'attribution must be checked after the zero-diff short-circuit');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · LABELLED HONESTLY — an attestation, never authentication
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared', () => {
  assert.equal(ATTRIBUTION_LABEL, 'Your name');
  assert.equal(ATTRIBUTION_HELP,
    'Recorded with this change. Self-declared — CDMSS admin access is a shared token.');
  for (const src of ALL_UI) {
    assert.ok(src.includes('ATTRIBUTION_LABEL') && src.includes('ATTRIBUTION_HELP'),
      'every field must use the shared label and helper — not its own wording');
  }
});

test('nothing anywhere implies authentication', () => {
  for (const src of [...ALL_UI, ...ALL_ROUTES, readFileSync('lib/admin-attribution.ts', 'utf8')]) {
    const code = codeOf(src);
    for (const banned of ['Verified by', 'Signed by', 'Authenticated', 'Verified as']) {
      assert.ok(!code.includes(banned), `"${banned}" implies authentication — this is an attestation`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · NO MIGRATION, NO BACKFILL — the history stays honest
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('NO MIGRATION WAS CREATED for Phase D', () => {
  const names = existsSync('migrations') ? readdirSync('migrations') : [];
  for (const f of names) {
    assert.ok(!/attribution|changed_by|published_by_name|reviewed_by_name/i.test(f),
      `migrations/${f} looks like a Phase D migration — §12.4 says none is needed`);
  }
  // The two columns already exist and are simply being written.
  assert.ok(/published_by_name/.test(readFileSync('lib/scoring-policy/store.ts', 'utf8')));
  assert.ok(/reviewed_by_name/.test(REVIEW));
});

test('NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read', () => {
  for (const src of ALL_ROUTES) {
    assert.ok(!/UPDATE .*SET .*(published_by_name|reviewed_by_name) *=.*WHERE .*(IS NULL|= 'Unknown')/is.test(src),
      'no route may backfill historical attribution');
  }
  // Read-side: absent stays "Unknown", it is not defaulted to the current user.
  assert.ok(HISTORY.includes("{v.publishedByName ?? 'Unknown'}"), 'history unchanged for old rows');
  assert.ok(UI_REVIEW.includes("saved.reviewedByName ?? 'Unknown'"), 'review panel reads the same way');
});

test('D-3 KEPT: a name-only edit is savable, so an old review can gain an author', () => {
  // More important now, not less: with no prefill, an existing review's author is never carried
  // into the field, so attributing an old review is always a name-only edit.
  assert.ok(UI_REVIEW.includes('const nameChanged = isValidAttribution(reviewedBy)'),
    'dirty must account for the name, else a pre-§12.4 review could never be attributed');
  assert.ok(UI_REVIEW.includes("const dirty = note.trim() !== (saved?.note ?? '').trim() || nameChanged;"));
  // Gated on validity, so the empty starting state does not read as an unsaved change on mount.
  assert.ok(UI_REVIEW.includes("&& reviewedBy.trim() !== (saved?.reviewedByName ?? '').trim()"));
});

test('the shared error message is the one users actually see, and names no roster', () => {
  assert.match(ATTRIBUTION_REQUIRED_ERROR, /Your name is required/);
  assert.match(ATTRIBUTION_REQUIRED_ERROR, /Self-declared/);
});
