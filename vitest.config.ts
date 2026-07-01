import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: [
      "src/**/*.test.ts",
      "__tests__/**/*.test.ts",
      "claude-code-plugin/tests/**/*.test.ts",
    ],
    // `_`-prefixed test files are LOCAL-ONLY live-verification harnesses (they hit
    // the real LLM / the live vectors.db) — never run in the normal suite or CI.
    exclude: ["dist/**", "node_modules/**", "**/*.e2e.test.ts", "**/__tests__/_*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts", "index.ts", "claude-code-plugin/lib/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**",
      ],
    },
  },
});
