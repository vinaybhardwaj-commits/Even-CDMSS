import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Even brand palette per locked decision #11 / PRD §7.3
        brand:   { DEFAULT: '#0055ff', dark: '#0044cc', light: '#2d75ff', faint: '#e6eeff' },
        navy:    { DEFAULT: '#002054', dark: '#001838' },
        pink:    { DEFAULT: '#f96eb1', light: '#fde8f2', dark: '#c4356b' },
        off:     '#fcfcfc',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        // Even portal uses generous radii (§18.3 god-tier UX)
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        // Subtle elevation only (§18.4)
        card: '0 4px 16px rgba(0,32,84,0.07)',
      },
    },
  },
  plugins: [],
};
export default config;
