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

import type { IMemoryStore, KbEntity, KbLessonHit } from "../store/types.js";
import {
  canonicalKey,
  isAbsoluteFilePath,
  normalizeProjectTag,
  FILE_KEY_PROJECT_SEP,
} from "../kb/kb-queries.js";
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

/**
 * Candidate canonical keys for a touched file, strongest first.
 *
 * The KB stores file entities inconsistently (sometimes the full path, often
 * just the basename the extractor saw), so we try both shapes — and, when the
 * current project is known, their project-scoped forms first.
 *
 * The basename shapes are the dangerous ones: `file:readme.md` matches the
 * README of EVERY repo. They stay in the list (that is how most of the real
 * corpus is keyed) but {@link fileEntityBelongsHere} refuses any match that
 * cannot be proven to belong to the project we are actually in.
 */
function fileKeyCandidates(filePath: string, project?: string): string[] {
  const full = canonicalKey("file", filePath); // already posix-normalized + lowercased
  // Derive the basename from the NORMALIZED key (always "/"-separated), never
  // from the raw input — Windows backslash paths must not depend on a fragile
  // split of the original string.
  const posixPath = full.startsWith("file:") ? full.slice("file:".length) : full;
  const base = posixPath.split("/").filter(Boolean).pop() ?? posixPath;
  const proj = normalizeProjectTag(project);

  const keys: string[] = [];
  if (proj) {
    // Project-scoped shapes (what NEW file entities are keyed on).
    if (!isAbsoluteFilePath(posixPath)) {
      keys.push(`file:${proj}${FILE_KEY_PROJECT_SEP}${posixPath}`);
    }
    keys.push(`file:${proj}${FILE_KEY_PROJECT_SEP}${base}`);
  }
  keys.push(full, `file:${base}`);
  return [...new Set(keys)];
}

/**
 * Is this stored file entity allowed to speak while we are working in
 * `project` on `posixPath`?
 *
 * THE GUARD THIS MODULE EXISTS FOR. Facts about a FILE are local to a project:
 * "README.md was given the argus canary line" is true of ONE repo's README and
 * is misleading — read as a current instruction — in every other repo. (Lessons
 * and principles stay cross-project; they travel through the recall path, not
 * through here. Associativity is not what leaks: file identity is.)
 *
 * A match is allowed only when it is PROVABLY this project's file:
 *   1. the matched key is project-scoped (the project is inside the key), or
 *   2. the entity carries a project tag equal to the current one, or
 *   3. the key is an absolute path identical to the file we just touched
 *      (self-identifying — no project tag needed).
 * Everything else — above all an unattributed bare basename — stays silent.
 */
function fileEntityBelongsHere(
  entity: KbEntity,
  matchedKey: string,
  posixPath: string,
  project?: string,
): boolean {
  const proj = normalizeProjectTag(project);
  if (proj && matchedKey.startsWith(`file:${proj}${FILE_KEY_PROJECT_SEP}`)) return true;
  if (proj && normalizeProjectTag(entity.project) === proj) return true;
  const keyPath = matchedKey.startsWith("file:") ? matchedKey.slice("file:".length) : matchedKey;
  return isAbsoluteFilePath(keyPath) && keyPath === posixPath;
}

/**
 * Resolve the file entity for a touched path, or null when nothing that
 * provably belongs to this project is known about it.
 */
function resolveFileEntity(
  store: IMemoryStore,
  filePath: string,
  project?: string,
): KbEntity | null {
  if (!store.queryEntityByKey) return null;
  const full = canonicalKey("file", filePath);
  const posixPath = full.startsWith("file:") ? full.slice("file:".length) : full;
  for (const key of fileKeyCandidates(filePath, project)) {
    const found = store.queryEntityByKey(NAMESPACE, "file", key);
    if (found && fileEntityBelongsHere(found, key, posixPath, project)) return found;
  }
  return null;
}

/**
 * Build the proactive memory block for a touched file, or null when there is
 * nothing worth surfacing (the silent-unless-relevant rule).
 */
export function buildFileInjection(
  store: IMemoryStore,
  filePath: string,
  opts?: { sessionId?: string; now?: string; actionContent?: string; project?: string },
): string | null {
  if (!store.queryEntityByKey || !store.queryHeadFacts || !store.queryEventsForEntity) {
    return null; // backend without KB read primitives → silence
  }

  // Resolve the file entity — project-scoped key, then legacy shapes, and only
  // ever a match that provably belongs to THIS project (see fileEntityBelongsHere).
  const entity = resolveFileEntity(store, filePath, opts?.project);
  if (!entity) return null; // unknown file (here) → silence

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
export function resolveFileOwnerId(
  store: IMemoryStore,
  filePath: string,
  project?: string,
): string | null {
  return resolveFileEntity(store, filePath, project)?.id ?? null;
}
