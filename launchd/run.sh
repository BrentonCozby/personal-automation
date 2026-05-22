#!/usr/bin/env bash
# Wrapper invoked by launchd. Runs each ynab-automation app in order and posts a
# macOS notification on any non-zero exit so failures don't go unseen.
#
# Add new apps by appending to APPS below; they'll run in sequence.

set -u
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

APPS=(
  # Enrichment runs first so categorize sees the populated memos.
  # 'enrich-memos'    # uncomment when Phase 2 lands
  'categorize'
)

err_log="$(mktemp -t ynab-automation.XXXXXX)"
trap 'rm -f "$err_log"' EXIT

overall_exit=0
for app in "${APPS[@]}"; do
  /bin/zsh -lc "pnpm --filter @ynab-automation/$app $app" 2> >(tee -a "$err_log" >&2)
  app_exit=$?
  if [ "$app_exit" -ne 0 ]; then
    overall_exit=$app_exit
    # Don't bail on the first failure — let later apps still run.
  fi
done

# Trim audit logs older than 90 days so the audit/ dir doesn't grow forever.
find "$PROJECT_DIR/apps"/*/audit -name 'categorize-*.jsonl' -mtime +90 -delete 2>/dev/null || true

if [ "$overall_exit" -ne 0 ]; then
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  /usr/bin/osascript \
    -e "display notification \"${last_err:-See $PROJECT_DIR/audit/launchd.err.log}\" with title \"YNAB Automation FAILED (exit $overall_exit)\" sound name \"Basso\""
fi

exit "$overall_exit"
