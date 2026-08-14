import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@dasher/dashboard-schema",
    "@dasher/planner",
    "@dasher/river-domain",
  ],
};

export default nextConfig;
