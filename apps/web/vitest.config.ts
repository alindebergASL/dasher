import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The app imports its own modules as `@/…`, which Next resolves from
      // `tsconfig.json`. Vitest does not read that, so a component importing a
      // server action was unresolvable here — which is why the first component
      // test to render one failed on the import rather than on its assertions.
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
