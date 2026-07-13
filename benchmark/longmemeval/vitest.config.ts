import { defineConfig } from "vitest/config";

// Dedicated config for the LongMemEval benchmark harness — the root config only
// includes the product's own test dirs, so the benchmark needs its own include.
export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["test/**/*.test.ts"],
    exclude: ["data/**", "runs/**", "node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    root: import.meta.dirname,
  },
});
