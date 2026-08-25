#!/usr/bin/env bash
# launchd wrapper: the session board, a server that stays up rather than a job that runs.
#
# The other wrappers in here run something, wait, and post a macOS notification if it
# failed. This one must not: launchd restarts the board whenever it exits, so a
# notification on exit would fire again every ThrottleInterval for as long as the board
# could not start. The err log is where a failure shows, and the board being down is
# already visible: http://localhost:4747 stops answering.
#
# `exec` matters. Without it launchd's child is this shell, and the SIGTERM it sends at
# logout or on `launchctl bootout` would reach the shell instead of the board, which would
# leave the board holding port 4747 while launchd believed it had stopped. Running through
# `pnpm --filter` has the same problem one layer further out.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
APP_DIR="$PROJECT_DIR/apps/session-board"
TSX="$PROJECT_DIR/node_modules/.bin/tsx"

if [ ! -x "$TSX" ]; then
  echo "tsx is missing at $TSX. Run pnpm install." >&2
  exit 1
fi

cd "$APP_DIR" || exit 1

# Through a login shell, the way run.sh does. node here is a Volta shim under
# ~/.volta/bin, which is on the PATH the login profile sets and not on the bare one
# launchd hands a job: without this the tsx launcher dies with "node: not found".
# Both `exec`s are load-bearing. They leave launchd's direct child as the node process, so
# the SIGTERM from `launchctl bootout` or from logging out reaches the board's own
# shutdown rather than a shell wrapping it, and the board frees port 4747 on the way out.
exec /bin/zsh -lc 'exec "$0" src/index.ts' "$TSX"
