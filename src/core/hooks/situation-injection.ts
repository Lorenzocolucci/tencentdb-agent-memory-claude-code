/**
 * File → memory match (Track A 3+4, the "inject" half).
 *
 * Given a file the agent just touched, surface what the associative graph
 * already knows about it: current facts + events referencing it. This is the
 * memory that "comes to you" when you open a file — proactive injection by
 * SITUATION (the file), not by the words of a query.
 *
 * GOLDEN RULE (Lorenzo's choice): silent unless relevant. Unknown file, or a
 * known file with nothing tied to it → return null. No noise, ever.
 *
 * Lessons (Track B / B2b) join here: once the Mistake Notebook is populated, a
 * file's recurring-failure lessons surface ALONGSIDE its facts/events — a lesson
 * resurfaces unbidden the moment the agent touches a file in its trigger pattern.
 */

import type { IMemoryStore, KbLessonHit } from "../store/types.js";
import { canonicalKey } from "../kb/kb-queries.js";
import { classifyStakes } from "../kb/stakes.js";
import { selectStanceToSurface } from "../kb/stance-severity.js";
import { willingnessTier } from "../kb/stance-track-record.js";

const NAMESPACE = "default";
const MAX_FACTS = 6;
const MAX_EVENTS = 4;
const MAX_LESSONS = 2;
const MAX_LINE = 160;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

/**
 * Render the block-before-acting interrupt for a single hard stance (Pilastro A):
 * an attested lesson whose situation is recurring AND the current action crosses
 * a one-way door. Mirrors the Grounded-Trust interrupt priority — it is a block
 * directive in the injected context, the only "stop" a memory can assert.
 *
 * Pilastro B (Strada A): the interrupt now carries the confirm/reject buttons so
 * the stance can LEARN from this fire. After Lorenzo answers, the agent records
 * the verdict against THIS lesson's id — a confirmed fire raises the stance's
 * willingness, a rejected (false-alarm) fire lowers it until a stance that cries
 * wolf silences itself. That feedback is what makes the interrupts grow rarer.
 */
function renderStanceInterrupt(lesson: KbLessonHit, stakesDomain: string | null): string {
  const door = stakesDomain ? ` (${stakesDomain})` : "";
  return (
    '<stance-interrupt priority="block-before-acting">\n' +
    `🛑 You have been burned here before AND this action crosses a one-way door${door}. ` +
    "Stop and confirm this is intentional before acting.\n" +
    `lesson [${lesson.domain}, ${lesson.evidenceCount}× evidence]: ${clip(lesson.lessonText)}\n` +
    `   → se Lorenzo CONFERMA che la frenata era giusta: tdai_stance_confirmed(lesson_id:"${lesson.id}")\n` +
    `   → se Lorenzo dice che era un FALSO ALLARME:        tdai_stance_rejected(lesson_id:"${lesson.id}")\n` +
    "</stance-interrupt>"
  );
}

/** Candidate canonical keys for a touched file: full posix path AND basename. */
function fileKeyCandidates(filePath: string): string[] {
  const full = canonicalKey("file", filePath); // already posix-normalized + lowercased
  // Derive the basename from the NORMALIZED key (always "/"-separated), never
  // from the raw input — Windows backslash paths must not depend on a fragile
  // split of the original string.
  const posixPath = full.startsWith("file:") ? full.slice("file:".length) : full;
  const base = posixPath.split("/").filter(Boolean).pop() ?? posixPath;
  const baseKey = `file:${base}`;
  // The KB stores file entities inconsistently (sometimes the full path,
  // sometimes the basename), so try both; dedupe when they coincide.
  return full === baseKey ? [full] : [full, baseKey];
}

/**
 * Build the proactive memory block for a touched file, or null when there is
 * nothing worth surfacing (the silent-unless-relevant rule).
 */
export function buildFileInjection(
  store: IMemoryStore,
  filePath: string,
  opts?: { sessionId?: string; now?: string; actionContent?: string },
): string | null {
  if (!store.queryEntityByKey || !store.queryHeadFacts || !store.queryEventsForEntity) {
    return null; // backend without KB read primitives → silence
  }

  // Resolve the file entity by full-path key, falling back to basename key.
  let entity = null as ReturnType<NonNullable<IMemoryStore["queryEntityByKey"]>>;
  for (const key of fileKeyCandidates(filePath)) {
    const found = store.queryEntityByKey(NAMESPACE, "file", key);
    if (found) {
      entity = found;
      break;
    }
  }
  if (!entity) return null; // unknown file → silence

  const facts = store.queryHeadFacts(entity.id).slice(0, MAX_FACTS);
  const events = store.queryEventsForEntity(entity.id, NAMESPACE, MAX_EVENTS);
  // Track B (B2b): recurring-failure lessons whose trigger involves this file.
  const allLessons = store.queryHeadLessonsByFile
    ? store.queryHeadLessonsByFile(entity.id, NAMESPACE, MAX_LESSONS)
    : [];
  // Pilastro B tombstone: a stance that cried wolf enough to be SUPPRESSED
  // (willingness < 0.25) does not surface AT ALL — not even as a soft note.
  // Under-attested lessons (low confidence/evidence) are NOT suppressed here;
  // they still resurface softly (B2b), only the willingness tombstone silences.
  const lessons = allLessons.filter(
    (l) => l.willingness === undefined || willingnessTier(l.willingness) !== "suppressed",
  );
  if (facts.length === 0 && events.length === 0 && lessons.length === 0) {
    return null; // nothing tied (or all tombstoned) → silence
  }

  // Graduated stance (Pilastro A): when the CURRENT action crosses a one-way
  // door AND a matched lesson is well-attested, escalate that single lesson to a
  // block-before-acting interrupt (one at a time). Purely additive — a benign or
  // absent action, or an under-attested lesson, leaves the soft notes untouched.
  const actionStakes = classifyStakes({ content: opts?.actionContent ?? "" });
  // Pilastro B: carry each lesson's willingness into the judgment so a stance that
  // cried wolf is suppressed/demoted. undefined (legacy/missing) → trusted.
  const mappedLessons = lessons.map((l) => ({
    ...l,
    evidence_count: l.evidenceCount,
    willingness: l.willingness,
  }));
  const { hard } = selectStanceToSurface(mappedLessons, { stakes: actionStakes.stakes });

  const recordExposure = (lessonId: string): void => {
    // B3: this lesson just resurfaced into a matching situation — record the
    // exposure so session-end can credit a successful avoidance. Best-effort.
    if (opts?.sessionId && store.recordLessonExposure) {
      try {
        store.recordLessonExposure(lessonId, opts.sessionId, opts.now ?? new Date().toISOString());
      } catch { /* off the critical path — never break injection */ }
    }
  };

  const recordStanceFire = (lessonId: string): void => {
    // Pilastro B: this stance just FIRED a hard interrupt — record the fire so the
    // confirm/reject verdict has a denominator. Best-effort, off the critical path.
    if (store.recordStanceFire) {
      try {
        store.recordStanceFire(lessonId, opts?.now ?? new Date().toISOString());
      } catch { /* never break injection */ }
    }
  };

  const lines: string[] = [];
  // Lessons FIRST — a "you've failed here before" warning outranks raw facts.
  for (const l of lessons) {
    if (hard && l.id === hard.id) continue; // the hard one becomes an interrupt, not a soft note
    lines.push(`- ⚠️ lesson [${l.domain}, ${l.evidenceCount}× evidence]: ${clip(l.lessonText)}`);
    recordExposure(l.id);
  }
  for (const f of facts) {
    lines.push(`- ${f.attribute}: ${clip(f.value)}`);
  }
  for (const e of events) {
    lines.push(`- (${e.type}) ${clip(e.text)}`);
  }

  const parts: string[] = [];
  if (hard) {
    recordExposure(hard.id);
    recordStanceFire(hard.id); // Pilastro B: count this hard fire
    parts.push(renderStanceInterrupt(hard, actionStakes.stakes_domain));
  }
  if (lines.length > 0) {
    parts.push(
      "<file-memory>\n" +
        `📌 What memory already knows about ${entity.name} (proactive — reference, not a task):\n` +
        lines.join("\n") +
        "\n</file-memory>",
    );
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Resolve the owner entity id for a touched file (full-path key, basename
 * fallback), or null when the file is unknown. Used by the Context Fingerprint
 * wiring to learn which owner a situation surfaced and to dedup against the
 * single-file block — additive, no change to {@link buildFileInjection}.
 */
export function resolveFileOwnerId(store: IMemoryStore, filePath: string): string | null {
  if (!store.queryEntityByKey) return null;
  for (const key of fileKeyCandidates(filePath)) {
    const found = store.queryEntityByKey(NAMESPACE, "file", key);
    if (found) return found.id;
  }
  return null;
}
