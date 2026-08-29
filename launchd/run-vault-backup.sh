#!/usr/bin/env bash
# launchd wrapper: daily one-way backup of the Obsidian vault to its git remote.
#
# Obsidian Sync is the live cross-device sync; this only snapshots the vault to GitHub for an
# offsite backup. Nothing else writes to the remote, so the push is a clean fast-forward: no
# pull/merge, so it can't conflict with Obsidian Sync. Posts a macOS notification on failure,
# matching run.sh / run-tasks-digest.sh.
#
# The vault path is read from apps/tasks/.env (OBSIDIAN_VAULT_PATH), the one place it's
# configured, rather than duplicated here.

set -u
# launchd hands jobs a minimal PATH; widen it so Homebrew or Apple git resolves. git reads
# credentials (the https token) from the login keychain, available in the gui launchd domain.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1

notify_fail() {
  /usr/bin/osascript \
    -e "display notification \"$1\" with title \"Vault backup FAILED\" sound name \"Basso\""
}

vault="$(grep -E '^OBSIDIAN_VAULT_PATH=' "$PROJECT_DIR/apps/tasks/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "${vault:-}" ] || [ ! -d "$vault" ]; then
  notify_fail "OBSIDIAN_VAULT_PATH is unset or not a directory (checked apps/tasks/.env)."
  exit 1
fi
if [ ! -d "$vault/.git" ]; then
  notify_fail "Vault at $vault is not a git repo. Run the initial setup first."
  exit 1
fi

cd "$vault" || {
  notify_fail "Could not enter the vault at $vault."
  exit 1
}
err_log="$(mktemp -t personal-automation-vault-backup.XXXXXX)"
# Each git step appends its stderr to the file rather than streaming it, so notify_fail can read
# back the reason. The trap replays the file into launchd's error log on the way out.
trap 'cat "$err_log" >&2; rm -f "$err_log"' EXIT

# Reports which step failed, with the reason git gave for it.
fail() {
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  notify_fail "$1${last_err:+: $last_err}"
  exit 1
}

git add -A 2>> "$err_log" || fail "git add failed"
# Commit only when something changed; an empty backup run is a no-op, not an error.
if ! git diff --cached --quiet; then
  # --no-verify: the global pre-commit guard blocks any staged line holding a cc-review marker,
  # which a note that merely quotes one trips. A backup can't be gated on what the vault contains.
  git commit -q --no-verify -m "vault backup: $(date '+%Y-%m-%d %H:%M')" 2>> "$err_log" \
    || fail "git commit failed"
fi
# Push HEAD to its branch on origin by name, so a missing upstream can't fail the backup.
# --no-verify for the same reason as the commit: the pre-push guard scans history for markers.
git push --no-verify origin HEAD 2>> "$err_log" || fail "git push failed"
