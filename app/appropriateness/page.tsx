import HelpCard from '@/components/HelpCard';
import AppropriatenessClient from './appropriateness-client';

export const metadata = { title: 'Appropriateness · CAT' };

export default function AppropriatenessPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Appropriateness / Low-Value Care</h1>
      <p className="mt-1 text-sm text-slate-500">
        Check a proposed test or treatment against Choosing Wisely and low-value-care guidance. Advisory only — it never blocks an order.
      </p>
      <HelpCard
        storageKey="appropriateness"
        title="About this tool"
        body="Describe the patient and the order you're considering. The tool extracts the proposed tests/treatments, finds matching society 'don't do this' recommendations (Choosing Wisely USA/Canada and India's National Cancer Grid), and — crucially — checks whether each recommendation's precondition is actually met for this patient before flagging it. It cites the source for every flag and suggests what to consider instead."
        bullets={[
          "It only flags when the recommendation genuinely applies to THIS patient — a flag stays silent if the patient has the red-flag/exception that makes the test appropriate.",
          'Every flag carries its society and a source link — verify before acting.',
          'Absence of a flag is not an endorsement: it means nothing low-value was identified, not that the plan is optimal.',
          'This is decision support, not a directive — it never cancels or blocks an order.',
        ]}
      />
      <div className="mt-6"><AppropriatenessClient /></div>
    </div>
  );
}
