#!/usr/bin/env bash
# Generates the actual plist and newsyslog conf from the committed templates by
# substituting in the project's absolute path and the current user's username.
# Run this once after cloning, or any time the project moves on disk.
#
# Generated files:
#   com.personal-automation.plist        — daily scheduled job (runs run.sh at 12:00)
#   newsyslog.personal-automation.conf   — optional log rotation config

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USERNAME="$(whoami)"

substitute() {
  local template="$1"
  local output="$2"
  sed -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
      -e "s|{{USERNAME}}|$USERNAME|g" \
      "$template" > "$output"
  echo "Generated $output"
}

substitute \
  "$PROJECT_DIR/launchd/com.personal-automation.plist.template" \
  "$PROJECT_DIR/launchd/com.personal-automation.plist"

substitute \
  "$PROJECT_DIR/launchd/newsyslog.personal-automation.conf.template" \
  "$PROJECT_DIR/launchd/newsyslog.personal-automation.conf"

# Build the stalled-tasks Reminders bridge and prime its macOS access grant. The grant is keyed
# to this binary's absolute path, so it must be (re)done here — including after the project
# moves on disk (which also regenerates the plist above). Running it once now surfaces the
# consent prompt while you're present, so the first scheduled run reads Reminders silently.
BRIDGE_DIR="$PROJECT_DIR/apps/stalled-tasks/src/reminders"
if /usr/bin/swiftc -O "$BRIDGE_DIR/reminders.swift" -o "$BRIDGE_DIR/reminders-bridge" 2>/dev/null &&
  /usr/bin/codesign --force --sign - "$BRIDGE_DIR/reminders-bridge" 2>/dev/null; then
  echo "Built reminders-bridge — approve the Reminders prompt if one appears."
  "$BRIDGE_DIR/reminders-bridge" >/dev/null 2>&1 || true
else
  echo "WARNING: could not build reminders-bridge (needs Xcode CLT: xcode-select --install)."
  echo "         stalled-tasks will build it on first run instead."
fi

# Generate the digest's dedicated launchd agent from STALLED_TASKS_SCHEDULE (its days/times).
echo "Generating the stalled-tasks digest schedule…"
(cd "$PROJECT_DIR" && pnpm --filter @personal-automation/stalled-tasks generate-launchd-plist)

cat <<EOF

Next (load both agents — the daily YNAB run and the digest):
  cp $PROJECT_DIR/launchd/com.personal-automation.plist ~/Library/LaunchAgents/
  cp $PROJECT_DIR/launchd/com.personal-automation.stalled-tasks.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.personal-automation.plist
  launchctl load ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist

Changed STALLED_TASKS_SCHEDULE later? Re-run this script, then:
  launchctl unload ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist
  cp $PROJECT_DIR/launchd/com.personal-automation.stalled-tasks.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist

Optional log rotation (rotates launchd.{out,err}.log weekly, keeps 4):
  sudo cp $PROJECT_DIR/launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
EOF
