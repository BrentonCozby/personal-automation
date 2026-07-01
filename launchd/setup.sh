#!/usr/bin/env bash
# Generates the actual plist and newsyslog conf from the committed templates by
# substituting in the project's absolute path and the current user's username.
# Run this once after cloning, or any time the project moves on disk.
#
# Generated files:
#   com.personal-automation.daily.plist         — daily scheduled job (runs run.sh at 12:00)
#   com.personal-automation.vault-backup.plist  — daily Obsidian vault git backup (09:00)
#   newsyslog.personal-automation.conf          — optional log rotation config

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USERNAME="$(whoami)"

# launchd won't create the StandardOutPath/StandardErrorPath directory — make it up front.
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
  "$PROJECT_DIR/launchd/newsyslog.personal-automation.conf.template" \
  "$PROJECT_DIR/launchd/newsyslog.personal-automation.conf"

# Generate the digest's dedicated launchd agent from STALLED_TASKS_SCHEDULE (its days/times).
echo "Generating the stalled-tasks digest schedule…"
(cd "$PROJECT_DIR" && pnpm --filter @personal-automation/stalled-tasks generate-launchd-plist)

cat <<EOF

Next (load all three agents — the daily run, the digest, and the vault backup):
  cp $PROJECT_DIR/launchd/com.personal-automation.daily.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.stalled-tasks.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.vault-backup.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.daily.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.vault-backup.plist

Changed STALLED_TASKS_SCHEDULE later? Re-run this script, then:
  launchctl bootout gui/$(id -u)/com.personal-automation.stalled-tasks
  cp $PROJECT_DIR/launchd/com.personal-automation.stalled-tasks.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist

Optional log rotation (rotates the logs in launchd/logs/ weekly, keeps 4):
  sudo cp $PROJECT_DIR/launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
EOF
