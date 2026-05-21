import type { Config } from 'tailwindcss';

/**
 * SP.1.4 (21 May 2026) — brand token unification with Even Staff Portal.
 * Previous CDMSS palette was slate-blue (#1F4E79 / #2E75B6 / #D5E8F0).
 * Now uses the Even brand palette per PRD §18.2 + locked decision #29.
 */
const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Even brand — matches even-staff-portal
        brand: {
          DEFAULT: '#0055ff',
          dark: '#0044cc',
          light: '#2d75ff',    // preserved as a lighter brand tint (was #2E75B6 in CDMSS pre-SP.1.4)
          faint: '#e6eeff',
        },
        navy:    { DEFAULT: '#002054', dark: '#001838' },
        pink:    { DEFAULT: '#f96eb1', light: '#fde8f2', dark: '#c4356b' },
        off:     '#fcfcfc',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 4px 16px rgba(0,32,84,0.07)',
      },
    },
  },
  plugins: [],
};
export default config;
