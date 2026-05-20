import EgfrCalculator from '@/components/calculators/EgfrCalculator';

export const metadata = { title: 'eGFR · Drugs · Even CDMSS' };

export default function EgfrPage() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/drugs" className="hover:text-brand">Drugs</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">eGFR</li>
        </ol>
      </nav>
      <EgfrCalculator />
    </div>
  );
}
