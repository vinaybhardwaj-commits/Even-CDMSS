import './globals.css';
import { headers } from 'next/headers';
import { Shell } from '@/components/Shell';

export const metadata = {
  title: 'CAT — Clinical Analysis Tool',
  description: 'Clinical Analysis Tool (CAT) — MKSAP/StatPearls-grounded clinical decision support',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // medaudit.evenos.app (tagged by middleware) renders chrome-free — no CAT shell.
  // The CAT host keeps the full shell (with the audit tool as a nav item).
  const chromeFree = (await headers()).get('x-surface') === 'medaudit';
  return (
    <html lang="en">
      <body>{chromeFree ? children : <Shell>{children}</Shell>}</body>
    </html>
  );
}
