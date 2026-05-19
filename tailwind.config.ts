import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#1F4E79', light: '#2E75B6', faint: '#D5E8F0' },
      },
    },
  },
  plugins: [],
};
export default config;
