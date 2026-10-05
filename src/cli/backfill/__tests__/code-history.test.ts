import { describe, it, expect } from "vitest";
import { historyToConversations, historyText, transcriptToConversation, transcriptTurns, MAX_PASTED_CHARS } from "../code-history.js";

const T0 = Date.parse("2025-09-27T22:43:18.169Z");
const h = (display: string, ts: number, project: string, pasted?: string) =>
  JSON.stringify({ display, pastedContents: pasted ? { "1": { id: 1, type: "text", content: pasted } } : {}, timestamp: ts, project });

describe("history.jsonl → one conversation per project and day", () => {
  it("groups by project + UTC day, keeps real timestamps, ids are stable", () => {
    const lines = [
      h("fai push su git", T0, "C:\\Tutor-Agent"),
      h("il problema persiste", T0 + 60_000, "C:\\Tutor-Agent"),
      h("controlla il gestionale", T0 + 120_000, "C:\\IMMIGRATO-PAKISTANI"),
      h("giorno dopo", T0 + 86_400_000, "C:\\Tutor-Agent"),
      "not json",
      JSON.stringify({ display: "", timestamp: T0, project: "C:\\X" }),
    ];
    const convs = historyToConversations(lines);
    expect(convs.map((c) => [c.cwd, c.chat_messages.length])).toEqual([
      ["C:\\Tutor-Agent", 2],
      ["C:\\IMMIGRATO-PAKISTANI", 1],
      ["C:\\Tutor-Agent", 1],
    ]);
    expect(convs[0]!.chat_messages[0]).toMatchObject({ sender: "human", text: "fai push su git", created_at: new Date(T0).toISOString() });
    expect(historyToConversations(lines).map((c) => c.uuid)).toEqual(convs.map((c) => c.uuid));
    expect(new Set(convs.flatMap((c) => c.chat_messages.map((m) => m.uuid))).size).toBe(4);
  });

  it("keeps pasted content, bounded", () => {
    const text = historyText(JSON.parse(h("guarda questo log", T0, "C:\\A", "x".repeat(MAX_PASTED_CHARS + 500))));
    expect(text.startsWith("guarda questo log\n\n")).toBe(true);
    expect(text.length).toBe("guarda questo log\n\n".length + MAX_PASTED_CHARS);
  });
});

const u = (content: unknown, ts: string) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } });
const a = (text: string, ts: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });

describe("transcript → the turns the live hook never captured", () => {
  const lines = [
    u("prima domanda", "2026-09-10T10:00:00Z"),
    a("prima risposta", "2026-09-10T10:00:05Z"),
    u([{ type: "tool_result", content: "ok" }], "2026-09-10T10:00:06Z"), // tool result: not a prompt
    a("seguito", "2026-09-10T10:00:09Z"),
    u("seconda domanda", "2026-09-10T11:00:00Z"),
    a("seconda risposta", "2026-09-10T11:00:03Z"),
    u("domanda senza risposta", "2026-09-10T12:00:00Z"),
  ];
  it("same turn boundaries as the plugin: tool results are not prompts, an unanswered prompt is not a turn", () => {
    expect(transcriptTurns(lines).map((t) => [t.user, t.assistant])).toEqual([
      ["prima domanda", "prima risposta\n\nseguito"],
      ["seconda domanda", "seconda risposta"],
    ]);
  });
  it("skips the turns already captured and dates each message", () => {
    const conv = transcriptToConversation("sess-1", "C:\\Sofia-AI", lines, 1)!;
    expect(conv.chat_messages).toEqual([
      { uuid: "cc:sess-1:1:u", sender: "human", text: "seconda domanda", created_at: "2026-09-10T11:00:00Z" },
      { uuid: "cc:sess-1:1:a", sender: "assistant", text: "seconda risposta", created_at: "2026-09-10T11:00:03Z" },
    ]);
    expect(transcriptToConversation("sess-1", "C:\\Sofia-AI", lines, 2)).toBeNull();
  });
});
