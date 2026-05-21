/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  async redirects() {
    return [
      // CALC v1 restructure (20 May 2026): calculators moved from inline-within-module
      // routes to a unified /calculators/* namespace with a sidebar entry. Old URLs
      // still work via these 308 redirects (any bookmark, in-trace URL, or hardcoded
      // link continues to resolve).
      { source: '/drugs/egfr',         destination: '/calculators/egfr',         permanent: true },
      { source: '/ask/news2',          destination: '/calculators/news2',        permanent: true },
      { source: '/ask/abg',            destination: '/calculators/abg',          permanent: true },
      { source: '/ask/hyponatremia',   destination: '/calculators/hyponatremia', permanent: true },
      { source: '/coach/sepsis-bundle',destination: '/calculators/sepsis-bundle',permanent: true },
    ];
  },
};
export default nextConfig;
