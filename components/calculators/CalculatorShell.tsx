'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalculatorConfig, FormField, CalculatorResult } from '@/lib/calculators/types';

// Tooltip cache version sentinel (PRD §3.14). Compared against server's value on app boot.
const TOOLTIP_VERSION_LS_KEY = 'cdmss_tooltip_cache_version';

async function ensureTooltipCacheFresh() {
  if (typeof window === 'undefined') return;
  try {
    const r = await fetch('/api/health');
    const data = await r.json();
    const serverVersion = data?.tooltip_cache_version ?? null;
    if (!serverVersion) return;
    const local = localStorage.getItem(TOOLTIP_VERSION_LS_KEY);
    if (local !== serverVersion) {
      // Clear all tooltip:* keys
      const toClear: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('tooltip:')) toClear.push(k);
      }
      for (const k of toClear) localStorage.removeItem(k);
      localStorage.setItem(TOOLTIP_VERSION_LS_KEY, serverVersion);
    }
  } catch {
    // bridge or health down — leave cache alone
  }
}

async function getTooltip(calc: string, field: string): Promise<string> {
  const key = `tooltip:${calc}:${field}`;
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem(key);
    if (cached) return cached;
  }
  try {
    const r = await fetch(`/api/calculators/tooltip?calc=${calc}&field=${field}`);
    const data = await r.json();
    const text = data?.text ?? '';
    if (text && typeof window !== 'undefined') localStorage.setItem(key, text);
    return text;
  } catch {
    return '';
  }
}

function FieldInput({
  calc,
  field,
  value,
  setValue,
  error,
}: {
  calc: string;
  field: FormField;
  value: unknown;
  setValue: (v: unknown) => void;
  error?: string;
}) {
  const [tip, setTip] = useState<string>(field.staticTooltip);
  const [tipLoaded, setTipLoaded] = useState(false);
  const [showTip, setShowTip] = useState(false);

  async function handleHover() {
    if (!tipLoaded) {
      const fresh = await getTooltip(calc, field.key);
      if (fresh) setTip(fresh);
      setTipLoaded(true);
    }
    setShowTip(true);
  }

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <span>{field.label}</span>
        {field.unit && <span className="text-xs text-slate-500">({field.unit})</span>}
        <button
          type="button"
          aria-label={`Info about ${field.label}`}
          onMouseEnter={handleHover}
          onMouseLeave={() => setShowTip(false)}
          onFocus={handleHover}
          onBlur={() => setShowTip(false)}
          className="ml-1 text-slate-400 hover:text-brand focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-1 rounded"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8 7v4M8 4.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </label>

      {showTip && tip && (
        <div className="relative">
          <div role="tooltip" className="absolute z-10 -mt-1 max-w-xs rounded-md bg-slate-800 px-3 py-2 text-xs leading-relaxed text-white shadow-lg">
            {tip}
          </div>
        </div>
      )}

      {field.type === 'enum' && field.options ? (
        <select
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
      ) : field.type === 'bool' ? (
        <div className="flex gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={value === true} onChange={() => setValue(true)} className="text-brand" />
            <span>Yes</span>
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={value === false} onChange={() => setValue(false)} className="text-brand" />
            <span>No</span>
          </label>
        </div>
      ) : field.type === 'number' || field.type === 'integer' ? (
        <input
          type="number"
          inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
          step={field.type === 'integer' ? '1' : 'any'}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => setValue(e.target.value === '' ? undefined : Number(e.target.value))}
          className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
            error ? 'border-red-400 focus:border-red-500 focus:ring-red-500' : 'border-slate-300 focus:border-brand focus:ring-brand'
          }`}
        />
      ) : (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      )}

      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

export type CalculatorShellProps<TDeterministic = Record<string, unknown>> = {
  config: CalculatorConfig;
  // Override default form rendering (rare — most calcs use the default).
  renderForm?: (props: {
    values: Record<string, unknown>;
    setValue: (k: string, v: unknown) => void;
    errors: Record<string, string>;
  }) => React.ReactNode;
  renderResult: (props: { result: CalculatorResult & { deterministic: TDeterministic } }) => React.ReactNode;
};

export default function CalculatorShell<T = Record<string, unknown>>({ config, renderForm, renderResult }: CalculatorShellProps<T>) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of config.fields) {
      if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
    }
    return init;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CalculatorResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const idemKey = useRef<string>(crypto.randomUUID());

  // Tooltip cache freshness check on mount.
  useEffect(() => { ensureTooltipCacheFresh(); }, []);

  function setValue(k: string, v: unknown) {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (errors[k]) setErrors((prev) => { const next = { ...prev }; delete next[k]; return next; });
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    for (const f of config.fields) {
      const v = values[f.key];
      if (f.required && (v === undefined || v === null || v === '')) {
        e[f.key] = 'Required';
        continue;
      }
      if (typeof v === 'number') {
        if (f.hardMin !== undefined && v < f.hardMin) e[f.key] = `Must be ≥ ${f.hardMin}`;
        if (f.hardMax !== undefined && v > f.hardMax) e[f.key] = `Must be ≤ ${f.hardMax}`;
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const r = await fetch(config.apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey.current },
        body: JSON.stringify({ ...values, idempotency_key: idemKey.current }),
      });
      const data = await r.json();
      if (!r.ok) {
        setServerError(data?.error ?? `HTTP ${r.status}`);
        setSubmitting(false);
        return;
      }
      // If this calc pushes context (eGFR → renal_ctx), write it to sessionStorage.
      if (data.pushed_to_context && data.pushed_to_context.target === 'drugs' && data.pushed_to_context.renal_ctx) {
        try {
          sessionStorage.setItem('cdmss_renal_ctx', JSON.stringify(data.pushed_to_context.renal_ctx));
        } catch {}
      }
      setResult(data);
      // Persist result for navigate-away-and-back per PRD §14.6
      try {
        sessionStorage.setItem(`cdmss_calc_result:${config.name}:${data.trace_id}`, JSON.stringify(data));
      } catch {}
      setSubmitting(false);
      // Fresh idempotency key for next submission
      idemKey.current = crypto.randomUUID();
    } catch (e2) {
      setServerError(String((e2 as Error).message));
      setSubmitting(false);
    }
  }

  function handleReset() {
    setResult(null);
    setServerError(null);
    setValues(() => {
      const init: Record<string, unknown> = {};
      for (const f of config.fields) if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
      return init;
    });
    setErrors({});
    idemKey.current = crypto.randomUUID();
  }

  const formContent = useMemo(() => {
    if (renderForm) return renderForm({ values, setValue, errors });
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {config.fields.map((f) => (
          <FieldInput
            key={f.key}
            calc={config.name}
            field={f}
            value={values[f.key]}
            setValue={(v) => setValue(f.key, v)}
            error={errors[f.key]}
          />
        ))}
      </div>
    );
  }, [config, values, errors, renderForm]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{config.displayTitle}</h1>
      </header>

      {!result ? (
        <form onSubmit={handleSubmit} className="space-y-5">
          {formContent}

          {serverError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {serverError}
            </div>
          )}

          <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-slate-200 bg-white py-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand/90 disabled:opacity-50"
            >
              {submitting ? 'Computing…' : 'Compute'}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-5">
          {renderResult({ result: result as CalculatorResult & { deterministic: T } })}
          <div className="flex gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => { setResult(null); }}
              className="text-sm text-brand hover:underline"
            >
              ← Edit inputs and re-score
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
