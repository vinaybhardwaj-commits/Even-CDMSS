// Deterministic demographic guard for the DDx engine.
// Belt-and-suspenders behind the prompt rules: even if the model slips, an
// anatomically/physiologically impossible diagnosis for the patient's stated sex
// is removed before it can reach the clinician. Sex must be clearly known; when
// sex is unknown/ambiguous, nothing is filtered. Age is handled in the prompt
// (prevalence weighting), not hard-filtered here.

export type DdxParsed = {
  summary?: string;
  missing_info?: string[];
  cannot_miss?: unknown[];
  most_likely?: unknown[];
  other?: unknown[];
};

type DdxItem = { diagnosis?: string };

// Female-only conditions — impossible in a male patient.
// NOTE: deliberately NOT matching bare "cervical" (that means neck — cervical
// spine / cervical lymphadenopathy) or "breast" (males get breast disease too).
const FEMALE_ONLY: RegExp[] = [
  /\bovar(y|ian|ies)\b/, /\btubo-?ovarian\b/, /\buter(us|ine)\b/, /\bendometri/,
  /\bcervix\b/, /\bcervical (cancer|carcinoma|dysplasia|intraepithelial)\b/, /\bcervicitis\b/,
  /\bectopic\b/, /\bpregnan/, /\b(pre)?eclampsia\b/, /\bplacenta/, /\bmiscarriage\b/, /\babortion\b/,
  /\bvagin/, /\bvulv/, /\bsalping/, /\bpelvic inflammatory\b/, /\bpid\b/,
  /\bmenstru/, /\bmenorrhagia\b/, /\bdysmenorrh/, /\bmittelschmerz\b/, /\buterine fibroid/,
];

// Male-only conditions — impossible in a female patient.
const MALE_ONLY: RegExp[] = [
  /\btestic(le|les|ular)\b/, /\btestis\b/, /\btestes\b/, /\bscrot/, /\bprostat/,
  /\bpenile\b/, /\bpenis\b/, /\bepididym/, /\bvaricocele\b/, /\bhydrocele\b/, /\bspermatic\b/,
  /\bbenign prostatic\b/, /\bbph\b/, /\bcryptorchid/, /\bbalanitis\b/, /\bphimosis\b/,
];

export function normSex(s?: string | null): 'male' | 'female' | null {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  if (!t) return null;
  if (/^(m\b|male|man|boy|♂)/.test(t) || t === 'm') return 'male';
  if (/^(f\b|female|woman|girl|♀)/.test(t) || t === 'f') return 'female';
  return null;
}

/**
 * Remove sex-impossible diagnoses from the parsed DDx. Returns the filtered
 * object (same shape) plus a list of "diagnosis [bucket]" strings that were
 * dropped, for audit logging.
 */
export function filterByDemographics(parsed: DdxParsed, sexRaw?: string | null): { filtered: DdxParsed; removed: string[] } {
  const sex = normSex(sexRaw);
  if (!sex) return { filtered: parsed, removed: [] };
  const banned = sex === 'male' ? FEMALE_ONLY : MALE_ONLY;
  const removed: string[] = [];

  const scrub = (arr: unknown, bucket: string): unknown[] => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((it) => {
      const name = String((it as DdxItem)?.diagnosis || '').toLowerCase();
      if (!name) return true;
      if (banned.some((rx) => rx.test(name))) {
        removed.push(`${(it as DdxItem).diagnosis || '?'} [${bucket}]`);
        return false;
      }
      return true;
    });
  };

  return {
    filtered: {
      ...parsed,
      cannot_miss: scrub(parsed.cannot_miss, 'cannot_miss'),
      most_likely: scrub(parsed.most_likely, 'most_likely'),
      other: scrub(parsed.other, 'other'),
    },
    removed,
  };
}
