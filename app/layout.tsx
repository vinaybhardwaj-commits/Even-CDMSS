import './globals.css';
import Nav from './nav';

export const metadata = {
  title: 'Even-Tutor',
  description: 'MKSAP-grounded medical study companion',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <Nav />
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        <footer className="mx-auto mt-12 max-w-6xl px-6 pb-8 text-center text-xs text-slate-400">
          MKSAP 19 · 12 books · 275 chapters · 8,790 chunks · Even-Tutor v0.1
        </footer>
      </body>
    </html>
  );
}