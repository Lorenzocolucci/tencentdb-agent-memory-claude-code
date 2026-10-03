import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
// @ts-expect-error — plain .mjs script (no declaration file).
import { buildStampText } from "../../scripts/install-cc-plugin.mjs";

describe("install-cc-plugin: buildStampText", () => {
  it("records sha256 of dist/lib/hook.mjs, git short sha and ISO date", () => {
    const src = mkdtempSync(join(tmpdir(), "tdai-stamp-"));
    try {
      mkdirSync(join(src, "dist", "lib"), { recursive: true });
      writeFileSync(join(src, "dist", "lib", "hook.mjs"), "console.log(1)");
      const expected = createHash("sha256").update("console.log(1)").digest("hex");
      const text: string = buildStampText(src, "abc1234", new Date("2026-10-03T10:00:00Z"));
      expect(text).toContain(`sha256=${expected}`);
      expect(text).toContain("git=abc1234");
      expect(text).toContain("date=2026-10-03T10:00:00.000Z");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
