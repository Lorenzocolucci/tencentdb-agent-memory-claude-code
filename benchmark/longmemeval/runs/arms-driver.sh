#!/usr/bin/env bash
# Resume-driver for run-arms.ts: the seed can hit a native node crash (exit 127)
# on very large haystacks (known since 2026-06-30). run-arms writes per-question
# JSONL and skips already-done questions, so relaunching resumes. We loop until
# all questions are done, with a stuck-guard: if progress does not advance across
# N consecutive attempts, abort (a consistently-crashing question).
#
# Usage (from repo root, secrets + prompt env already exported):
#   bash benchmark/longmemeval/runs/arms-driver.sh <dataset_rel> <per_type> <types> <expected_total> <base>
# e.g.
#   bash .../arms-driver.sh data/longmemeval_s_cleaned.json 5 multi-session,temporal-reasoning,knowledge-update 15 longmemeval_s_cleaned-15q
set -u
DATASET="${1:?dataset}"; PERTYPE="${2:?per-type}"; TYPES="${3:?types}"; TOTAL="${4:?expected total}"; BASE="${5:?base}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # benchmark/longmemeval
REPO="$(cd "$HERE/../.." && pwd)"
JSONL="$HERE/runs/arms-$BASE.jsonl"
LOG="$HERE/runs/${BASE}.driver.log"
MAX_STUCK=3
prev=0; stuck=0; attempt=0
# One question per run-arms invocation → the process never initialises a second
# question's store in the same process, sidestepping the native seed crash.
export TDAI_ARMS_ONE_PER_RUN=1
cd "$REPO" || exit 1
while :; do
  done_ct=$( [ -f "$JSONL" ] && grep -c '"question_id"' "$JSONL" || echo 0 )
  if [ "$done_ct" -ge "$TOTAL" ]; then echo "DRIVER done: $done_ct/$TOTAL" | tee -a "$LOG"; break; fi
  if [ "$done_ct" -le "$prev" ]; then stuck=$((stuck+1)); else stuck=0; fi
  if [ "$stuck" -ge "$MAX_STUCK" ]; then echo "DRIVER ABORT: stuck at $done_ct/$TOTAL after $MAX_STUCK attempts" | tee -a "$LOG"; break; fi
  prev="$done_ct"; attempt=$((attempt+1))
  echo "DRIVER attempt $attempt: $done_ct/$TOTAL done, launching run-arms" | tee -a "$LOG"
  node --import tsx benchmark/longmemeval/src/run-arms.ts \
    --dataset "$DATASET" --per-type "$PERTYPE" --types "$TYPES" >> "$LOG" 2>&1
  echo "DRIVER: run-arms exited ($?)" | tee -a "$LOG"
  sleep 3
done
