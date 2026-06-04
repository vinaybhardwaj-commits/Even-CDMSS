import './globals.css';
import { Shell } from '@/components/Shell';

export const metadata = {
  title: 'CAT — Clinical Analysis Tool',
  description: 'Clinical Analysis Tool (CAT) — MKSAP/StatPearls-grounded clinical decision support',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
