#!/usr/bin/env bash
# Generates the actual plist and newsyslog conf from the committed templates by
# substituting in the project's absolute path and the current user's username.
# Run this once after cloning, or any time the project moves on disk.
#
# Generated files:
#   com.ynab-automation.plist        — daily scheduled job (runs run.sh at 12:00)
#   newsyslog.ynab-automation.conf   — optional log rotation config

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
  "$PROJECT_DIR/launchd/com.ynab-automation.plist.template" \
  "$PROJECT_DIR/launchd/com.ynab-automation.plist"

substitute \
  "$PROJECT_DIR/launchd/newsyslog.ynab-automation.conf.template" \
  "$PROJECT_DIR/launchd/newsyslog.ynab-automation.conf"

cat <<EOF

Next:
  cp $PROJECT_DIR/launchd/com.ynab-automation.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.ynab-automation.plist

Optional log rotation (rotates launchd.{out,err}.log weekly, keeps 4):
  sudo cp $PROJECT_DIR/launchd/newsyslog.ynab-automation.conf /etc/newsyslog.d/
EOF
