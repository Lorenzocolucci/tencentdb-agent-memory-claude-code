import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, replayCandidates } from "../build-plan.js";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

function userLine(content: string, cwd: string, sessionId: string): string {
  return line({ type: "user", message: { role: "user", content }, cwd, sessionId });
}
function assistantLine(content: string, cwd: string, sessionId: string): string {
  return line({ type: "assistant", message: { role: "assistant", content }, cwd, sessionId });
}

describe("buildPlan (integration of enumerate + header + cursor + classify)", () => {
  let projectsRoot: string;
  let dataDir: string;

  beforeEach(async () => {
    projectsRoot = await mkdtemp(join(tmpdir(), "backfill-cc-plan-projects-"));
    dataDir = await mkdtemp(join(tmpdir(), "backfill-cc-plan-data-"));
  });

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("classifies a mixed corpus and lists exactly the replay candidates", async () => {
    // 1. never-captured: one real turn, no cursor.
    await mkdir(join(projectsRoot, "C--Sofia-AI"), { recursive: true });
    await writeFile(
      join(projectsRoot, "C--Sofia-AI", "never.jsonl"),
      userLine("hi", "C:\\Sofia-AI", "sess-never") + assistantLine("hello", "C:\\Sofia-AI", "sess-never"),
      "utf-8",
    );

    // 2. captured-complete: cursor already covers both turns.
    await mkdir(join(projectsRoot, "C--Sofia-AI-2"), { recursive: true });
    await writeFile(
      join(projectsRoot, "C--Sofia-AI-2", "complete.jsonl"),
      userLine("q1", "C:\\Sofia-AI-2", "sess-complete") + assistantLine("a1", "C:\\Sofia-AI-2", "sess-complete"),
      "utf-8",
    );
    await mkdir(join(dataDir, "cursors"), { recursive: true });
    await writeFile(
      join(dataDir, "cursors", "sess-complete.json"),
      JSON.stringify({ lastSentIndex: 1, updatedAt: new Date().toISOString() }),
      "utf-8",
    );

    // 3. captured-partial: cursor behind turn count.
    await writeFile(
      join(projectsRoot, "C--Sofia-AI-2", "partial.jsonl"),
      userLine("q1", "C:\\Sofia-AI-2", "sess-partial") +
        assistantLine("a1", "C:\\Sofia-AI-2", "sess-partial") +
        userLine("q2", "C:\\Sofia-AI-2", "sess-partial") +
        assistantLine("a2", "C:\\Sofia-AI-2", "sess-partial"),
      "utf-8",
    );
    await writeFile(
      join(dataDir, "cursors", "sess-partial.json"),
      JSON.stringify({ lastSentIndex: 1, updatedAt: new Date().toISOString() }),
      "utf-8",
    );

    // 4. argus-child: single turn, Argus dir, marker.
    await mkdir(join(projectsRoot, "C--Argus"), { recursive: true });
    await writeFile(
      join(projectsRoot, "C--Argus", "child.jsonl"),
      userLine("Sei Argus e stai scrivendo a Lorenzo.", "C:\\Argus", "sess-argus") +
        assistantLine("ok", "C:\\Argus", "sess-argus"),
      "utf-8",
    );

    // 5. unreadable: no cwd/sessionId anywhere.
    await writeFile(join(projectsRoot, "C--Sofia-AI", "broken.jsonl"), line({ type: "queue-operation" }), "utf-8");

    const plan = await buildPlan({ projectsRoot, dataDir });

    expect(plan.totals["never-captured"].count).toBe(1);
    expect(plan.totals["captured-complete"].count).toBe(1);
    expect(plan.totals["captured-partial"].count).toBe(1);
    expect(plan.totals["argus-child"].count).toBe(1);
    expect(plan.totals["unreadable"].count).toBe(1);
    expect(plan.rows).toHaveLength(5);

    const withoutArgus = replayCandidates(plan, false).map((r) => r.sessionId).sort();
    expect(withoutArgus).toEqual(["sess-never", "sess-partial"]);

    const withArgus = replayCandidates(plan, true).map((r) => r.sessionId).sort();
    expect(withArgus).toEqual(["sess-argus", "sess-never", "sess-partial"]);
  });

  it("returns an empty plan for an empty projects root", async () => {
    const plan = await buildPlan({ projectsRoot, dataDir });
    expect(plan.rows).toEqual([]);
    for (const totals of Object.values(plan.totals)) {
      expect(totals.count).toBe(0);
      expect(totals.bytes).toBe(0);
    }
  });
});
