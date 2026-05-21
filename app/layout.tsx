import './globals.css';
import Shell from './shell';
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata = {
  title: 'Even CDMSS',
  description: 'Even CDMSS — Clinical Decision Making Support System for RMOs',
  applicationName: 'Even CDMSS',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Even CDMSS' },
};

export const viewport = {
  themeColor: '#0055ff',  // SP.1.4 — Even brand (was #1F4E79 slate)
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Even CDMSS" />
      </head>
      <body className="min-h-screen bg-[#f2f4f8] text-[#1a1a2e] font-sans">
        <Shell>{children}</Shell>
        <script src="/register-sw.js" defer />
      </body>
    </html>
  );
}
