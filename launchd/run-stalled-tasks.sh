#!/usr/bin/env bash
# launchd wrapper for the stalled-tasks digest. Its own agent
# (com.personal-automation.stalled-tasks) fires it on the days/times in STALLED_TASKS_SCHEDULE,
# separate from the daily run.sh. Posts a macOS notification on failure so a broken run isn't
# silent — same failure-surfacing as run.sh.

set -u
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

err_log="$(mktemp -t personal-automation-stalled.XXXXXX)"
trap 'rm -f "$err_log"' EXIT

/bin/zsh -lc "pnpm --filter @personal-automation/stalled-tasks stalled-tasks" 2> >(tee -a "$err_log" >&2)
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  /usr/bin/osascript \
    -e "display notification \"${last_err:-See $PROJECT_DIR/launchd-stalled-tasks.err.log}\" with title \"Stalled Tasks digest FAILED (exit $exit_code)\" sound name \"Basso\""
fi

exit "$exit_code"
