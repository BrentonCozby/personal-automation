#!/usr/bin/env bash
# launchd wrapper for the tasks digest. Its own agent
# (com.personal-automation.tasks) fires it on the days/times in TASKS_SCHEDULE,
# separate from the daily run.sh. Posts a macOS notification on failure so a broken run isn't
# silent. Same failure-surfacing as run.sh.

set -u
# Guarded twice: a failed substitution leaves PROJECT_DIR empty, and `cd ""` is a no-op that would
# run pnpm from launchd's own directory. Both the exit code and the shell's message reach the logs.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
cd "$PROJECT_DIR" || exit 1

err_log="$(mktemp -t personal-automation-tasks.XXXXXX)"
trap 'rm -f "$err_log"' EXIT

/bin/zsh -lc "pnpm --filter @personal-automation/tasks tasks digest" 2> >(tee -a "$err_log" >&2)
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  /usr/bin/osascript \
    -e "display notification \"${last_err:-See $PROJECT_DIR/launchd/logs/tasks-digest.err.log}\" with title \"Task review FAILED (exit $exit_code)\" sound name \"Basso\""
fi

exit "$exit_code"
