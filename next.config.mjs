/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Plan-intelligence (lib/plan-intelligence/extract-text.js) dynamically
    // imports pdfjs-dist/legacy/build/pdf.mjs at runtime. Webpack can't
    // resolve that — externalizing tells Next.js to leave the require to
    // Node at runtime. Same for the other Node-only PDF/Excel libs.
    serverComponentsExternalPackages: [
      'pdfjs-dist',
      'pdf-lib',
      'mammoth',
      'cheerio',
    ],
  },
};

export default nextConfig;
