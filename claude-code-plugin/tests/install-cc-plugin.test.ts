import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script (no declaration file); typed loosely on purpose.
import { PLUGIN_NAME, collectInstallFiles, findInstallTargets, isInstallTarget, readPluginManifestName } from "../../scripts/install-cc-plugin.mjs";

describe("install-cc-plugin: isInstallTarget (pure)", () => {
  it("accepts a dir whose path carries the plugin name", () => {
    expect(
      isInstallTarget({
        path: "C:/Users/lo/.claude/plugins/cache/tdai-local/tdai-memory/0.1.0",
        hasBundle: true,
        manifestName: null,
      }),
    ).toBe(true);
  });

  it("accepts the marketplace source dir via its manifest name (path lacks the token)", () => {
    expect(
      isInstallTarget({
        path: "C:/Users/lo/.claude/plugins/tdai-mkt/plugin",
        hasBundle: true,
        manifestName: PLUGIN_NAME,
      }),
    ).toBe(true);
  });

  it("rejects a dir with a bundle that belongs to another plugin", () => {
    expect(
      isInstallTarget({
        path: "C:/Users/lo/.claude/plugins/other-mkt/plugin",
        hasBundle: true,
        manifestName: "other-plugin",
      }),
    ).toBe(false);
  });

  it("rejects a dir without a bundle even when the name matches", () => {
    expect(
      isInstallTarget({ path: "/x/tdai-memory", hasBundle: false, manifestName: PLUGIN_NAME }),
    ).toBe(false);
  });
});

describe("install-cc-plugin: filesystem helpers", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tdai-install-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makePlugin(dir: string, opts: { manifestName?: string; bundle?: boolean }) {
    if (opts.bundle !== false) {
      await mkdir(join(dir, "dist", "lib"), { recursive: true });
      await writeFile(join(dir, "dist", "lib", "hook.mjs"), "// bundle\n");
    } else {
      await mkdir(dir, { recursive: true });
    }
    if (opts.manifestName) {
      await mkdir(join(dir, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: opts.manifestName, version: "0.1.0" }),
      );
    }
  }

  it("readPluginManifestName reads the name and never throws", async () => {
    const dir = join(root, "p");
    await makePlugin(dir, { manifestName: "tdai-memory" });
    expect(readPluginManifestName(dir)).toBe("tdai-memory");
    expect(readPluginManifestName(join(root, "missing"))).toBeNull();
    await mkdir(join(root, "broken", ".claude-plugin"), { recursive: true });
    await writeFile(join(root, "broken", ".claude-plugin", "plugin.json"), "{not json");
    expect(readPluginManifestName(join(root, "broken"))).toBeNull();
  });

  it("findInstallTargets finds the cache copy, the marketplace source, and skips data/foreign", async () => {
    const cache = join(root, "cache", "tdai-local", "tdai-memory", "0.1.0");
    const mkt = join(root, "tdai-mkt", "plugin");
    const foreign = join(root, "other-mkt", "plugin");
    const data = join(root, "data", "tdai-memory-tdai-local");
    await makePlugin(cache, {});
    await makePlugin(mkt, { manifestName: "tdai-memory" });
    await makePlugin(foreign, { manifestName: "someone-else" });
    await makePlugin(data, {});

    const targets = findInstallTargets(root).sort();
    expect(targets).toEqual([cache, mkt].sort());
  });

  it("collectInstallFiles includes the bundle, hooks.json and every skill file", async () => {
    const src = join(root, "claude-code-plugin");
    await mkdir(join(src, "skills", "memory-confirm"), { recursive: true });
    await mkdir(join(src, "skills", "memory-search"), { recursive: true });
    await writeFile(join(src, "skills", "memory-confirm", "SKILL.md"), "x");
    await writeFile(join(src, "skills", "memory-search", "SKILL.md"), "y");

    const files = collectInstallFiles(src);
    expect(files).toEqual([
      ["dist/lib/hook.mjs", "dist/lib/hook.mjs"],
      ["hooks/hooks.json", "hooks/hooks.json"],
      ["skills/memory-confirm/SKILL.md", "skills/memory-confirm/SKILL.md"],
      ["skills/memory-search/SKILL.md", "skills/memory-search/SKILL.md"],
    ]);
  });

  it("collectInstallFiles on the real plugin dir lists the new confirm/reject skills", () => {
    const real = join(import.meta.dirname, "..");
    const tos = collectInstallFiles(real).map(([, to]: [string, string]) => to);
    expect(tos).toContain("skills/memory-confirm/SKILL.md");
    expect(tos).toContain("skills/memory-reject/SKILL.md");
    expect(tos).toContain("skills/memory-search/SKILL.md");
  });
});
