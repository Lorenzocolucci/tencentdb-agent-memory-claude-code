#!/usr/bin/env bash
# Run the OFFICIAL LongMemEval GPT-4o judge (evaluate_qa.py) over every arm's
# hypothesis JSONL for a given run base, and print a compact per-arm comparison.
#
# Usage:
#   bash benchmark/longmemeval/judge-arms.sh <base> <ref_dataset.json>
#   e.g. bash benchmark/longmemeval/judge-arms.sh longmemeval_oracle-30q data/longmemeval_oracle.json
#
# Requires OPENAI_API_KEY in env (source gateway.secrets.env first).
set -u
BASE="${1:?usage: judge-arms.sh <base> <ref_dataset.json>}"
REFARG="${2:?ref dataset path (relative to benchmark/longmemeval or absolute)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL="$HERE/official/LongMemEval/src/evaluation/evaluate_qa.py"
RUNS="$HERE/runs"
case "$REFARG" in /*|[A-Za-z]:*) REF="$REFARG" ;; *) REF="$HERE/$REFARG" ;; esac

[ -f "$EVAL" ] || { echo "missing official judge: $EVAL (clone xiaowu0162/LongMemEval)"; exit 1; }
[ -f "$REF" ] || { echo "missing ref dataset: $REF"; exit 1; }

echo "=== Official GPT-4o judge (evaluate_qa.py) — base=$BASE ==="
for ARM in flat kb kb_consol kb5; do
  HYP="$RUNS/hyp-$ARM-$BASE.jsonl"
  if [ ! -s "$HYP" ]; then echo "  [$ARM] (no hypotheses)"; continue; fi
  echo "--- arm: $ARM ---"
  python "$EVAL" gpt-4o "$HYP" "$REF" 2>/dev/null | grep -E '^Accuracy:|^\t' \
    | sed 's/^/  /'
done
echo "=== done. per-instance labels: runs/hyp-<arm>-$BASE.jsonl.eval-results-gpt-4o ==="
