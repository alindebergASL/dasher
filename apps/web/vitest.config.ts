import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` exists to make Next's bundler fail a build that pulls a
      // server module into a client bundle. That guarantee is a build-time
      // one, and `pnpm build` plus `no-model-calls.test.ts`'s bundle scan are
      // where it is actually proven. Here it would only stop the unit tests
      // from importing the module they exist to test, so it resolves to
      // nothing. Enabling the `react-server` condition instead was tried and
      // breaks every component test, which needs the client React build.
      "server-only": fileURLToPath(
        new URL("./test/empty-module.ts", import.meta.url),
      ),
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
