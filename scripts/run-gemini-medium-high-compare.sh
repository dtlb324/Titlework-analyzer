#!/usr/bin/env bash
# Run Gemini 3.5 Flash medium vs high on one job and open compare.html (macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

JOB_ID="${1:-job_42ec0d61-3c6a-45fe-aa58-1eb41ef11055}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

missing=()
[[ -z "${DATABASE_URL:-}" && -z "${POSTGRES_URL:-}" ]] && missing+=("DATABASE_URL")
[[ -z "${GEMINI_API_KEY:-}" ]] && missing+=("GEMINI_API_KEY")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing: ${missing[*]}"
  echo "Add them to $ENV_FILE then run:"
  echo "  source $ENV_FILE"
  echo "  bash scripts/run-gemini-medium-high-compare.sh"
  exit 1
fi

OUT_DIR="eval/compare/${JOB_ID}/gemini-medium-vs-high"
echo "Job: $JOB_ID"
echo "Output: $ROOT/$OUT_DIR"
echo ""

node scripts/compare-final-opinion.mjs \
  --job-id "$JOB_ID" \
  --gemini-thinking-levels medium,high \
  --skip-sonnet \
  --out-dir "$OUT_DIR"

HTML="$ROOT/$OUT_DIR/compare.html"
echo ""
echo "Files:"
ls -la "$OUT_DIR" || true
echo ""
if [[ -f "$HTML" ]]; then
  echo "Open side-by-side view:"
  echo "  file://$HTML"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    open "$HTML"
  fi
else
  echo "compare.html was not created. Check errors above."
  exit 1
fi
