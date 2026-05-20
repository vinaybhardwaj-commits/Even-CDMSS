import ReviewClient from './review-client';

export const metadata = { title: 'Review · Even-Tutor' };

export default function ReviewPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Shift Review</h1>
      <p className="mt-1 text-sm text-slate-500">
        Generate a digest of your recent queries, then work through the flashcards on your own schedule.
      </p>
      <div className="mt-6"><ReviewClient /></div>
    </div>
  );
}
