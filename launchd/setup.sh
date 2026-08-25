#!/usr/bin/env bash
# Generates the actual plist and newsyslog conf from the committed templates by
# substituting in the project's absolute path and the current user's username.
# Run this once after cloning, or any time the project moves on disk.
#
# Generated files:
#   com.personal-automation.daily.plist         : daily scheduled job (runs run.sh at 12:00)
#   com.personal-automation.tasks.plist         : tasks digest, on TASKS_SCHEDULE's days/times
#   com.personal-automation.tasks-alert.plist   : due-date alert, every day at TASKS_ALERT_TIMES
#   com.personal-automation.vault-backup.plist  : daily Obsidian vault git backup (09:00)
#   com.personal-automation.session-board.plist : the session board server, up at login
#   newsyslog.personal-automation.conf          : optional log rotation config

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USERNAME="$(whoami)"

# launchd won't create the StandardOutPath/StandardErrorPath directory, so make it up front.
mkdir -p "$PROJECT_DIR/launchd/logs"

substitute() {
  local template="$1"
  local output="$2"
  sed -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
      -e "s|{{USERNAME}}|$USERNAME|g" \
      "$template" > "$output"
  echo "Generated $output"
}

substitute \
  "$PROJECT_DIR/launchd/com.personal-automation.daily.plist.template" \
  "$PROJECT_DIR/launchd/com.personal-automation.daily.plist"

substitute \
  "$PROJECT_DIR/launchd/com.personal-automation.vault-backup.plist.template" \
  "$PROJECT_DIR/launchd/com.personal-automation.vault-backup.plist"

substitute \
  "$PROJECT_DIR/launchd/com.personal-automation.session-board.plist.template" \
  "$PROJECT_DIR/launchd/com.personal-automation.session-board.plist"

substitute \
  "$PROJECT_DIR/launchd/newsyslog.personal-automation.conf.template" \
  "$PROJECT_DIR/launchd/newsyslog.personal-automation.conf"

# Generate the digest's and the alert's dedicated launchd agents from TASKS_SCHEDULE (the
# digest's days/times) and TASKS_ALERT_TIMES (the alert's times, every day).
echo "Generating the tasks digest and alert schedules…"
(cd "$PROJECT_DIR" && pnpm --filter @personal-automation/tasks generate-launchd-plist)

cat <<EOF

Next (load all five agents: the daily run, the digest, the due-date alert, the vault
backup, and the session board):
  cp $PROJECT_DIR/launchd/com.personal-automation.daily.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.tasks.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.tasks-alert.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.vault-backup.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.session-board.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.daily.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.tasks.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.tasks-alert.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.vault-backup.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.session-board.plist

The session board comes up at login and is restarted whenever it exits. Stop a copy you
started by hand first, or it holds port 4747 and the agent respawns every 10 seconds:
  lsof -nP -iTCP:4747 -sTCP:LISTEN -t | xargs -r kill
Check it: launchctl print gui/$(id -u)/com.personal-automation.session-board | head -20
Stop it:  launchctl bootout gui/$(id -u)/com.personal-automation.session-board

Changed TASKS_SCHEDULE or TASKS_ALERT_TIMES later? Re-run this script, then:
  launchctl bootout gui/$(id -u)/com.personal-automation.tasks
  cp $PROJECT_DIR/launchd/com.personal-automation.tasks.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.tasks.plist
  launchctl bootout gui/$(id -u)/com.personal-automation.tasks-alert
  cp $PROJECT_DIR/launchd/com.personal-automation.tasks-alert.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.tasks-alert.plist

Optional log rotation (rotates the logs in launchd/logs/ weekly, keeps 4):
  sudo cp $PROJECT_DIR/launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
EOF
