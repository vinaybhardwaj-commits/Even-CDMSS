'use client';

// Care-manager entry: type/paste a prescription uid and open its brief. (Pre-batch, this is how
// a CM pulls a member; the daily worklist (P2.2) will populate the table proactively.)
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';

export default function PullMember() {
  const [uid, setUid] = useState('');
  const [err, setErr] = useState('');
  const router = useRouter();

  function go(e: React.FormEvent) {
    e.preventDefault();
    const u = uid.trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(u)) { setErr('Enter a valid prescription id'); return; }
    router.push(`/care/${encodeURIComponent(u)}`);
  }

  return (
    <form onSubmit={go} className="flex items-center gap-2">
      <input value={uid} onChange={(e) => { setUid(e.target.value); setErr(''); }} placeholder="Prescription id (uid)"
        className="w-64 rounded-lg border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-teal-400" />
      <button type="submit" className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-teal-700">
        Pull brief <ArrowRight className="h-3.5 w-3.5" />
      </button>
      {err && <span className="text-[12px] text-red-600">{err}</span>}
    </form>
  );
}
