import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  experimental: {
    // With a proxy, Next keeps only the first 10 MB of a request body by default and hands the route the cut body.
    // Admin → Competitors → Import pages uploads a zip of up to 30 MB (lib/competitors/bundle-zip.ts MAX_ZIP_BYTES);
    // 32 MB is also the most Cloud Run lets through in production.
    proxyClientMaxBodySize: "32mb",
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
