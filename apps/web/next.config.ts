import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@dasher/dashboard-schema",
    "@dasher/planner",
    "@dasher/workbook",
  ],
  // Server actions are bounded by Next before any product code runs; this sits
  // above the 4 MB upload limit so the product, not the framework, refuses.
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
