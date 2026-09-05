import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../cli-args.js";

const env = { home: "C:\\Users\\test" };

describe("parseCliArgs", () => {
  it("defaults to --list with no jsonPath and Argus children excluded", () => {
    const opts = parseCliArgs([], env);
    expect(opts.command).toBe("list");
    if (opts.command === "list") {
      expect(opts.jsonPath).toBeNull();
      expect(opts.includeArgusChildren).toBe(false);
      expect(opts.projectsRoot).toBe("C:\\Users\\test\\.claude\\projects");
      expect(opts.dataDir).toBe("C:\\Users\\test\\.claude\\plugins\\data\\tdai-memory-tdai-local");
    }
  });

  it("parses --list --json <path> --include-argus-children", () => {
    const opts = parseCliArgs(["--list", "--json", "plan.json", "--include-argus-children"], env);
    expect(opts.command).toBe("list");
    if (opts.command === "list") {
      expect(opts.jsonPath).toBe("plan.json");
      expect(opts.includeArgusChildren).toBe(true);
    }
  });

  it("parses --run with defaults for --hook and --pace-ms", () => {
    const opts = parseCliArgs(["--run"], env);
    expect(opts.command).toBe("run");
    if (opts.command === "run") {
      expect(opts.paceMs).toBe(500);
      expect(opts.includeArgusChildren).toBe(false);
      expect(opts.hookPath).toBe(
        "C:\\Users\\test\\.claude\\plugins\\cache\\tdai-local\\tdai-memory\\0.1.0\\dist\\lib\\hook.mjs",
      );
    }
  });

  it("parses --run overrides", () => {
    const opts = parseCliArgs(
      ["--run", "--hook", "C:\\custom\\hook.mjs", "--pace-ms", "100", "--include-argus-children", "--capture-timeout-ms", "45000"],
      env,
    );
    expect(opts.command).toBe("run");
    if (opts.command === "run") {
      expect(opts.hookPath).toBe("C:\\custom\\hook.mjs");
      expect(opts.paceMs).toBe(100);
      expect(opts.includeArgusChildren).toBe(true);
      expect(opts.captureTimeoutMs).toBe(45_000);
    }
  });

  it("--run defaults the capture timeout to 5 minutes (offline replay waits, never floods)", () => {
    const opts = parseCliArgs(["--run"], env);
    if (opts.command === "run") expect(opts.captureTimeoutMs).toBe(300_000);
    expect(opts.command).toBe("run");
  });

  it("parses --digest with default keys=null (derive from state) and default stall/gateway", () => {
    const opts = parseCliArgs(["--digest"], env);
    expect(opts.command).toBe("digest");
    if (opts.command === "digest") {
      expect(opts.keys).toBeNull();
      expect(opts.gatewayUrl).toBe("http://127.0.0.1:8421");
      expect(opts.stallMinutes).toBe(30);
      expect(opts.force).toBe(false);
      expect(opts.tokenFile).toBe(
        "C:\\Users\\test\\.claude\\plugins\\data\\tdai-memory-tdai-local\\token",
      );
    }
  });

  it("parses --digest --keys a,b,c (trims whitespace, drops empties)", () => {
    const opts = parseCliArgs(["--digest", "--keys", "a, b ,,c"], env);
    if (opts.command === "digest") {
      expect(opts.keys).toEqual(["a", "b", "c"]);
    }
  });

  it("respects --data-dir when deriving the default --token-file for --digest", () => {
    const opts = parseCliArgs(["--digest", "--data-dir", "C:\\custom\\data"], env);
    if (opts.command === "digest") {
      expect(opts.dataDir).toBe("C:\\custom\\data");
      expect(opts.tokenFile).toBe("C:\\custom\\data\\token");
    }
  });

  it("parses --digest --force and an explicit --stall-minutes", () => {
    const opts = parseCliArgs(["--digest", "--force", "--stall-minutes", "5"], env);
    if (opts.command === "digest") {
      expect(opts.force).toBe(true);
      expect(opts.stallMinutes).toBe(5);
    }
  });

  it("--run takes precedence over --digest if both are somehow passed", () => {
    const opts = parseCliArgs(["--run", "--digest"], env);
    expect(opts.command).toBe("run");
  });
});
