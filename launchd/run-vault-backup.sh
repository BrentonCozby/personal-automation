#!/usr/bin/env bash
# launchd wrapper: weekly one-way backup of the Obsidian vault to its git remote.
#
# Obsidian Sync is the live cross-device sync; this only snapshots the vault to GitHub for an
# offsite backup. Nothing else writes to the remote, so the push is a clean fast-forward — no
# pull/merge, so it can't conflict with Obsidian Sync. Posts a macOS notification on failure,
# matching run.sh / run-stalled-tasks.sh.
#
# The vault path is read from apps/stalled-tasks/.env (OBSIDIAN_VAULT_PATH) — the one place it's
# configured — rather than duplicated here.

set -u
# launchd hands jobs a minimal PATH; widen it so Homebrew or Apple git resolves. git reads
# credentials (the https token) from the login keychain, available in the gui launchd domain.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

notify_fail() {
  /usr/bin/osascript \
    -e "display notification \"$1\" with title \"Vault backup FAILED\" sound name \"Basso\""
}

vault="$(grep -E '^OBSIDIAN_VAULT_PATH=' "$PROJECT_DIR/apps/stalled-tasks/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "${vault:-}" ] || [ ! -d "$vault" ]; then
  notify_fail "OBSIDIAN_VAULT_PATH is unset or not a directory (checked apps/stalled-tasks/.env)."
  exit 1
fi
if [ ! -d "$vault/.git" ]; then
  notify_fail "Vault at $vault is not a git repo — run the initial setup first."
  exit 1
fi

cd "$vault"
err_log="$(mktemp -t personal-automation-vault-backup.XXXXXX)"
trap 'rm -f "$err_log"' EXIT

git add -A 2> >(tee -a "$err_log" >&2)
# Commit only when something changed; an empty backup run is a no-op, not an error.
if ! git diff --cached --quiet; then
  git commit -q -m "vault backup: $(date '+%Y-%m-%d %H:%M')" 2> >(tee -a "$err_log" >&2)
fi
git push 2> >(tee -a "$err_log" >&2)
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  notify_fail "${last_err:-git push failed; see launchd-vault-backup.err.log}"
fi

exit "$exit_code"
