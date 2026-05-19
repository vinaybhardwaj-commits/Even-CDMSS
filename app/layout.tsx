import './globals.css';
import Shell from './shell';

export const metadata = {
  title: 'Even-Tutor',
  description: 'Medical study companion for RMOs',
  applicationName: 'Even-Tutor',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Even-Tutor' },
};

export const viewport = {
  themeColor: '#1F4E79',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Even-Tutor" />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <Shell>{children}</Shell>
        <script src="/register-sw.js" defer />
      </body>
    </html>
  );
}
