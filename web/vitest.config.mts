import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside a React Server Components bundle; tests import server modules directly.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    restoreMocks: true,
    projects: [
      // Route handlers and libraries run on the server: Node environment.
      { extends: true, test: { name: "server", environment: "node", include: ["src/**/*.test.ts"] } },
      // Components run in the browser: jsdom.
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
