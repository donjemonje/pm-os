import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Local dev is served as http://app-dev.pm-os.io (hosts entry + port 80 -> 3000; set-up script in
  // pmos-office/claude/pm-os/dev-url). Next blocks dev assets from any origin but localhost without this.
  allowedDevOrigins: ["app-dev.pm-os.io"],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
