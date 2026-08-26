import type { NextConfig } from "next";

/**
 * WHY THE BODY LIMIT IS HERE AND WHAT IT IS NOT.
 *
 * Next bounds a server action's request body before any application code runs,
 * at 1 MB by default. The upload path accepts a 4 MB CSV and refuses a larger
 * one with a sentence a person can act on — so with the default, every file
 * between 1 MB and 4 MB would be rejected by the framework, with a message
 * nobody here wrote, for a reason the product does not hold.
 *
 * This is set ABOVE the upload limit rather than equal to it, so the two never
 * race: a file the product refuses is refused by the product. Above this
 * ceiling the framework refuses, and that is correct rather than a gap —
 * buffering an unbounded body in order to produce a nicer refusal is how a
 * server runs out of memory. `apps/web/app/upload.ts` holds the product limit
 * and says the same thing from the other side.
 */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@dasher/dashboard-schema",
    "@dasher/planner",
    "@dasher/river-domain",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
