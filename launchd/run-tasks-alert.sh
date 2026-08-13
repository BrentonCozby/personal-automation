#!/usr/bin/env bash
# launchd wrapper for the due-date alert. Its own agent
# (com.personal-automation.tasks-alert) fires it at each time in TASKS_ALERT_TIMES, every day.
# Posts a macOS notification on failure so a dropped alert isn't silent. Same failure-surfacing as
# run.sh.

set -u
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

err_log="$(mktemp -t personal-automation-tasks-alert.XXXXXX)"
trap 'rm -f "$err_log"' EXIT

/bin/zsh -lc "pnpm --filter @personal-automation/tasks tasks alert" 2> >(tee -a "$err_log" >&2)
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  /usr/bin/osascript \
    -e "display notification \"${last_err:-See $PROJECT_DIR/launchd/logs/tasks-alert.err.log}\" with title \"Task alert FAILED (exit $exit_code)\" sound name \"Basso\""
fi

exit "$exit_code"
