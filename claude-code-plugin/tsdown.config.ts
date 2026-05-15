import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./lib/hook.ts", "./lib/gateway-entry.ts"],
  outDir: "./dist/lib",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  // Bundle internal lib files; do not bundle node builtins.
  deps: {
    neverBundle: (id) => id.startsWith("node:"),
  },
});
