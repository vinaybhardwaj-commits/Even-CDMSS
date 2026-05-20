'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Brain, Check, AlertCircle, X, MessageCircleQuestion, RotateCcw, BookOpen, Sparkles, FileText } from 'lucide-react';

type Correctness = 'correct' | 'partial' | 'incorrect' | 'clarifying';
type Turn = {
  role: 'coach' | 'user';
  content: string;
  evaluation?: { correctness: Correctness; feedback: string };
  timestamp: string;
};
type Difficulty = 'novice' | 'intermediate' | 'advanced';

type Summary = {
  summary: string;
  concepts_mastered: string[];
  gaps: string[];
  suggested_next: string;
  accuracy: number;
};

const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  novice: 'bg-emerald-100 text-emerald-800',
  intermediate: 'bg-amber-100 text-amber-900',
  advanced: 'bg-rose-100 text-rose-900',
};

const TOPIC_CHIPS = [
  'Atrial fibrillation management',
  'Workup of hyponatremia',
  'Acute pancreatitis severity',
  'COPD exacerbation triage',
  'Approach to syncope',
];

function EvalChip({ ev }: { ev: NonNullable<Turn['evaluation']> }) {
  const map: Record<Correctness, { icon: React.ReactNode; cls: string; label: string }> = {
    correct: { icon: <Check className="h-3 w-3" />, cls: 'bg-emerald-100 text-emerald-800', label: 'Correct' },
    partial: { icon: <MessageCircleQuestion className="h-3 w-3" />, cls: 'bg-amber-100 text-amber-900', label: 'Partial' },
    incorrect: { icon: <X className="h-3 w-3" />, cls: 'bg-rose-100 text-rose-800', label: 'Off-track' },
    clarifying: { icon: <AlertCircle className="h-3 w-3" />, cls: 'bg-slate-100 text-slate-600', label: 'Note' },
  };
  const cfg = map[ev.correctness] || map.clarifying;
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${cfg.cls}`}>
        {cfg.icon}{cfg.label}
      </span>
      {ev.feedback && <span className="italic">{ev.feedback}</span>}
    </div>
  );
}

export default function CoachClient() {
  const [phase, setPhase] = useState<'start' | 'chat' | 'summary'>('start');
  const [startTab, setStartTab] = useState<'topic' | 'case'>('topic');
  const [topic, setTopic] = useState('');
  const [caseText, setCaseText] = useState('');
  const [initialDifficulty, setInitialDifficulty] = useState<Difficulty>('intermediate');

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [currentTopic, setCurrentTopic] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('intermediate');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [difficultyFlash, setDifficultyFlash] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [turns]);

  async function startSession(e?: React.FormEvent) {
    e?.preventDefault();
    const subject = (startTab === 'topic' ? topic : caseText).trim();
    if (!subject) { setError(startTab === 'topic' ? 'Pick a topic' : 'Paste a case'); return; }
    setError(null); setLoading(true);
    try {
      const r = await fetch('/api/coach/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: startTab,
          topic: startTab === 'topic' ? subject : undefined,
          case_text: startTab === 'case' ? subject : undefined,
          difficulty: initialDifficulty,
        }),
      });
      if (!r.ok) { setError(`${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      const d = await r.json();
      setSessionId(d.session_id);
      setCurrentTopic(d.topic);
      setDifficulty(d.difficulty);
      setTurns([d.opener]);
      setPhase('chat');
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!sessionId) return;
    const msg = input.trim();
    if (!msg) return;
    setError(null);
    // Optimistic user turn
    const optimistic: Turn = { role: 'user', content: msg, timestamp: new Date().toISOString() };
    setTurns((t) => [...t, optimistic]);
    setInput('');
    setLoading(true);
    try {
      const r = await fetch('/api/coach/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, user_message: msg }),
      });
      if (!r.ok) { setError(`${r.status}: ${(await r.text()).slice(0, 200)}`); setLoading(false); return; }
      const d = await r.json();
      // Replace optimistic user turn with the server's (which has evaluation), append coach turn
      setTurns((prev) => {
        const without = prev.slice(0, -1);
        return [...without, d.user_turn, d.coach_turn];
      });
      if (d.difficulty !== difficulty) {
        setDifficulty(d.difficulty);
        setDifficultyFlash(true);
        setTimeout(() => setDifficultyFlash(false), 1500);
      }
      if (d.mastered || d.is_summary) {
        await endSession();
      }
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  async function endSession() {
    if (!sessionId) return;
    setLoading(true);
    try {
      const r = await fetch('/api/coach/end', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!r.ok) { setError(`${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      const d = await r.json();
      setSummary({
        summary: d.summary, concepts_mastered: d.concepts_mastered,
        gaps: d.gaps, suggested_next: d.suggested_next, accuracy: d.accuracy,
      });
      setPhase('summary');
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  function reset() {
    setPhase('start'); setSessionId(null); setTurns([]); setInput('');
    setTopic(''); setCaseText(''); setError(null); setSummary(null);
    setCurrentTopic(''); setDifficulty('intermediate');
  }

  if (phase === 'start') {
    return (
      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          <button
            onClick={() => setStartTab('topic')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition ${
              startTab === 'topic' ? 'bg-white text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sparkles className="h-4 w-4" /> Topic
          </button>
          <button
            onClick={() => setStartTab('case')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition ${
              startTab === 'case' ? 'bg-white text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="h-4 w-4" /> Case
          </button>
        </div>

        <form onSubmit={startSession} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {startTab === 'topic' ? (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Topic</label>
              <input
                value={topic} onChange={(e) => setTopic(e.target.value)}
                placeholder="Atrial fibrillation management"
                className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TOPIC_CHIPS.map((t) => (
                  <button type="button" key={t} onClick={() => setTopic(t)}
                    className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:border-brand hover:text-brand">
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Clinical case</label>
              <textarea
                value={caseText} onChange={(e) => setCaseText(e.target.value)}
                rows={5}
                placeholder="58F with new dyspnea, leg swelling, JVP 12cm, S3 gallop, bibasilar crackles. BNP 1450..."
                className="mt-1 w-full resize-none rounded-lg border border-slate-300 p-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Starting difficulty</label>
            <div className="mt-1 flex gap-1.5">
              {(['novice', 'intermediate', 'advanced'] as const).map((d) => (
                <button
                  type="button"
                  key={d}
                  onClick={() => setInitialDifficulty(d)}
                  className={`flex-1 rounded-full px-3 py-1 text-xs font-semibold capitalize transition ${
                    initialDifficulty === d ? DIFFICULTY_COLOR[d] : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
            {loading ? 'Preparing coach…' : 'Start session'}
          </button>
        </form>
      </div>
    );
  }

  if (phase === 'summary' && summary) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-emerald-900">
            <BookOpen className="h-5 w-5" /> Session summary
          </h2>
          <p className="mt-2 text-sm text-emerald-800">{summary.summary}</p>
          <div className="mt-3 flex items-center gap-3 text-xs text-emerald-700">
            <span>Topic: <span className="font-medium">{currentTopic}</span></span>
            <span>·</span>
            <span>Difficulty: <span className="font-medium capitalize">{difficulty}</span></span>
            <span>·</span>
            <span>Accuracy: <span className="font-medium">{(summary.accuracy * 100).toFixed(0)}%</span></span>
          </div>
        </div>

        {summary.concepts_mastered.length > 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Concepts you handled well</h3>
            <ul className="mt-2 ml-4 list-disc space-y-1 text-sm text-slate-800">
              {summary.concepts_mastered.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        )}

        {summary.gaps.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">Gaps still open</h3>
            <ul className="mt-2 ml-4 list-disc space-y-1 text-sm text-amber-900">
              {summary.gaps.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        )}

        {summary.suggested_next && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Suggested next session</h3>
            <p className="mt-1 text-sm text-slate-800">{summary.suggested_next}</p>
          </div>
        )}

        <button
          onClick={reset}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow"
        >
          <RotateCcw className="h-4 w-4" /> New session
        </button>
      </div>
    );
  }

  // phase === 'chat'
  return (
    <div className="flex flex-col">
      <header className="mb-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-sm">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">{currentTopic}</div>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize transition ${DIFFICULTY_COLOR[difficulty]} ${difficultyFlash ? 'ring-2 ring-brand' : ''}`}>
          <Brain className="h-3 w-3" /> {difficulty}
        </span>
      </header>

      <div ref={transcriptRef} className="max-h-[55vh] space-y-4 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
        {turns.map((t, i) => (
          <div key={i}>
            <div className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed ${
                  t.role === 'coach'
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'bg-brand text-white shadow'
                }`}
              >
                {t.content}
              </div>
            </div>
            {t.role === 'user' && t.evaluation && (
              <div className="mt-1 flex justify-end pr-2"><EvalChip ev={t.evaluation} /></div>
            )}
          </div>
        ))}
        {loading && turns[turns.length - 1]?.role === 'user' && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-white px-3.5 py-2 text-sm text-slate-400 shadow-sm">
              <Loader2 className="inline h-3 w-3 animate-spin" /> thinking…
            </div>
          </div>
        )}
      </div>

      {error && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      <form onSubmit={send} className="mt-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="Type your response…"
          className="flex-1 resize-none rounded-lg border border-slate-300 p-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(e as unknown as React.FormEvent); }}
        />
        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={endSession}
            disabled={loading}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:border-brand hover:text-brand"
          >
            End
          </button>
        </div>
      </form>
    </div>
  );
}
