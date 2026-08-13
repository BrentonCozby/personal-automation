# personal-automation

A catch-all monorepo for my personal automation — a pnpm workspace of small scheduled jobs and the shared libraries they build on. There's no "main" app: each automation is its own app on top of shared packages, and the list grows as I add more.

- **`apps/ynab-categorize`** — daily CLI that auto-categorizes Amazon transactions using the Anthropic API (Claude Haiku by default).
- **`apps/ynab-enrich-memos`** — reads Amazon receipt emails, parses the product list, and PATCHes it into the `memo` of matching YNAB transactions so the categorizer has real item names to work from. Runs before `ynab-categorize` in the daily run.
- **`apps/notify`** — emails an error digest after the daily run when any app's audit log shows errors.
- **`apps/tasks`** — emails a scheduled digest reviewing open Obsidian todos: classifies why each has stalled and surfaces the few worth acting on with one next action each.
- **`packages/anthropic`** — shared Claude API client (`messages.parse` + `zodOutputFormat`).
- **`packages/ynab`** — shared YNAB API client (zod-validated) + schemas + types + milliunits helpers.
- **`packages/gmail`** — Gmail API client (OAuth + send, optional multipart HTML), zod-validated.
- **`packages/common`** — shared helpers: pino-based logger, AppError + retry, PID lockfile, ora spinner, plus tiny utilities (json, chunks, date).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced via a husky `commit-msg` hook running commitlint.

## Contents

- [Setup](#setup)
- [Run](#run)
- [ynab-categorize](#ynab-categorize)
- [ynab-enrich-memos](#ynab-enrich-memos)
- [tasks](#tasks)
- [Production](#production)
- [Checking status](#checking-status)

## Setup

```bash
pnpm install
cp .env.example .env                                            # shared secrets + ids
cp apps/ynab-categorize/.env.example apps/ynab-categorize/.env  # only for apps you run
cp apps/ynab-enrich-memos/.env.example apps/ynab-enrich-memos/.env
cp apps/tasks/.env.example apps/tasks/.env
cp apps/notify/.env.example apps/notify/.env
```

Config is split: shared secrets and ids live in the root `.env`, and each app's own config sits beside it in `apps/<app>/.env`. At startup an app loads the root `.env` then its own `.env` on top; every variable it needs is required — config loaders throw if any are missing — so only fill in the apps you actually run. Each `.env` has a `.env.example` next to it:

- **root `.env`** — `ANTHROPIC_API_KEY` (from [console.anthropic.com](https://console.anthropic.com), separate from Claude Pro), `YNAB_TOKEN` + `YNAB_BUDGET_ID`, `ALLOWED_ACCOUNT_IDS` (shared by both YNAB apps), and the `GMAIL_OAUTH_*` credentials apps send mail through. Mint `GMAIL_OAUTH_REFRESH_TOKEN` with `pnpm --filter @personal-automation/gmail bootstrap`, and re-run that after any Google password change — it revokes the token.
- **`apps/ynab-categorize/.env`** — `LOOKBACK_DAYS`, `AUDIT_DIR`, `EXCLUDED_CATEGORY_GROUPS`, `CATEGORY_ROUTING_HINTS`, `YNAB_CATEGORIZER_ANTHROPIC_MODEL`.
- **`apps/ynab-enrich-memos/.env`** — `AUDIT_DIR`, `ENRICH_LOOKBACK_DAYS`, `GMAIL_RECEIPT_WINDOW_DAYS`, `GMAIL_FROM_FILTER`, `ENRICH_MEMOS_ANTHROPIC_MODEL`.
- **`apps/tasks/.env`** — `OBSIDIAN_VAULT_PATH`, `TASK_LISTS`, `TASKS_SCHEDULE`, `TASKS_TO_EMAIL`, `TASKS_ANTHROPIC_MODEL`, and the state-model thresholds (`TASKS_WIP_CAP`, `TASKS_STALL_DAYS`, `TASKS_HORIZON_DAYS`).
- **`apps/notify/.env`** — `NOTIFY_TO_EMAIL`.

Requires Node 26+ and pnpm 11+.

## Run

Each app is a workspace package; run its scripts with `pnpm --filter`. No app is privileged at the root — the pattern is the same for every one:

```bash
pnpm --filter @personal-automation/<app> <script>
```

```bash
# ynab-categorize — dry run (verbose, does NOT PATCH), then a real run
pnpm --filter @personal-automation/ynab-categorize test:ynab-categorize
pnpm --filter @personal-automation/ynab-categorize ynab-categorize
pnpm --filter @personal-automation/ynab-categorize ynab-categorize --lookback-days 5

# ynab-enrich-memos — dry run (does NOT PATCH), then a real run
pnpm --filter @personal-automation/ynab-enrich-memos test:ynab-enrich-memos
pnpm --filter @personal-automation/ynab-enrich-memos ynab-enrich-memos

# tasks — print the digest to the console without sending
pnpm --filter @personal-automation/tasks test:tasks

# tasks — act on one task (any part of the title, no quoting needed)
pnpm --filter @personal-automation/tasks tasks promote fix the bike
pnpm --filter @personal-automation/tasks tasks schedule fix the bike +7d
pnpm --filter @personal-automation/tasks tasks abandon fix the bike
```

## ynab-categorize

The categorizer always appends a JSONL audit line per decision to `apps/ynab-categorize/audit/ynab-categorize-YYYY-MM-DD.jsonl`.

1. Loads category groups from YNAB, drops hidden/deleted, drops "Internal Master Category" and the `EXCLUDED_CATEGORY_GROUPS` list, and discovers the "Uncategorized" id for fallback.
2. Loads transactions per allowed account `since LOOKBACK_DAYS`, keeps only those that are:
   - in an allowed account
   - `payee_name === "Amazon"`
   - not a transfer
   - not already flagged `auto-categorized`
3. For each eligible transaction (4 in parallel), asks Claude to pick a category via `messages.parse()` with a Zod-validated JSON schema. Empty memos, missing ids, and unknown ids all fall through to "Uncategorized".
4. Bulk PATCHes the result with `flag_color: yellow`, `flag_name: auto-categorized` so the script is idempotent. Batches of 10.

## ynab-enrich-memos

Runs before `ynab-categorize` so the categorizer reasons from real item names instead of an empty memo. Appends a JSONL audit line per attempt to `apps/ynab-enrich-memos/audit/ynab-enrich-memos-YYYY-MM-DD.jsonl`. Design notes in [apps/ynab-enrich-memos/plan.md](apps/ynab-enrich-memos/plan.md).

1. Loads transactions per allowed account `since ENRICH_LOOKBACK_DAYS` and keeps only Amazon, non-transfer rows whose `memo` is empty. A non-empty memo — yours or a prior run's — is never touched.
2. For each eligible transaction (`ENRICH_CONCURRENCY` in parallel), searches Gmail for receipts from `GMAIL_FROM_FILTER` senders within ±`GMAIL_RECEIPT_WINDOW_DAYS` of the charge date, drops any that fail DMARC, and asks Claude to match the order whose total equals the charge to the cent.
3. Verifies the returned order total against the charge in code — a mismatch is rejected (fails closed). On a match, prefixes the memo with `auto-gen:` and queues a memo-only PATCH (no flag, so the categorizer still runs on it).
4. Bulk PATCHes in batches of 10.

## tasks

A twice-weekly review of the few tasks you have committed to, which emails only the ones that have gone quiet, with one next action each. It runs on its own launchd schedule — the days/times in `TASKS_SCHEDULE` (e.g. `["Sunday 08:00", "Wednesday 08:00"]`), so twice or three times a week is just more entries.

The app carries a state model: each task is tagged `#someday` or `#active` in the vault, and `#active` is capped at `TASKS_WIP_CAP`. `tasks migrate` gives every untagged task its first tag (dry by default, `--apply` writes). Three commands then act on one task at a time, each taking any part of its title: `promote` moves it to `#active` (refusing at the cap unless you pass `--over-cap`), `schedule <date>` puts a `📅` date on it (`YYYY-MM-DD` or `+Nd`, and a date past `TASKS_HORIZON_DAYS` sends it to `#someday` rather than pretending it is planned), and `abandon` drops it by cancelling its checkbox. Finishing and dropping are recorded by the checkbox rather than a tag, so a task you tick or cancel in Obsidian counts the same as one closed here. Since Obsidian has no per-task last-modified anywhere, a fingerprint of each task's text is kept in `apps/tasks/runs/touch-clock.json` so an edit can be read as a touch; the file is disposable and rebuilds itself. See `docs/task-state-model.md`.

The digest reviews `#active` tasks only. One counts as gone quiet when nothing has touched it for `TASKS_STALL_DAYS` and it carries no date still ahead of it — a date means it is scheduled, and the Tasks plugin surfaces it on the day. Only those tasks reach the model, which says why each went quiet and names its next physical step; the email prints that step plus the `schedule` and `abandon` commands for it. Two cases send nothing at all: no task is `#active`, or nothing has gone quiet. Neither is worth an email.

Every command reads the same vault on disk (`OBSIDIAN_VAULT_PATH`) through one scanner. With `TASK_LISTS=[]` it reads `todos.md` at the vault root; otherwise `TASK_LISTS` names files or folders (relative to the vault) and folders are walked for their `*.md`. It parses [Obsidian Tasks](https://publish.obsidian.md/tasks/) lines — open `- [ ]` and in-progress `- [/]` checkboxes count as live (done and cancelled are skipped), `📅` sets the due date, and recurring (`🔁`) tasks sit outside the state model entirely (the plugin manages them by their recurrence rule). Nothing pulls the vault, so it reads the last synced state on disk — keep it synced separately (Obsidian Sync or the Obsidian Git plugin). It works on any OS.

`TASKS_ANTHROPIC_MODEL` is a separate knob from `YNAB_CATEGORIZER_ANTHROPIC_MODEL`. Judging *why* a commitment went quiet and naming its next physical step is harder judgment than picking a category id, so it starts on a Sonnet-tier model rather than Haiku. Each run logs its classifications to `apps/tasks/runs/` for tuning.

## Production

Three launchd agents:

- `com.personal-automation.daily` runs `launchd/run.sh` daily at 12:00 — each app in the `APPS` array in sequence (`ynab-enrich-memos` then `ynab-categorize`), then `notify`.
- `com.personal-automation.tasks` runs the digest on its `TASKS_SCHEDULE` days/times.
- `com.personal-automation.vault-backup` runs `launchd/run-vault-backup.sh` daily (09:00) — a one-way `git push` of the Obsidian vault to its remote for offsite backup. Obsidian Sync is the live cross-device sync; this only snapshots to git, so it never conflicts. The vault path comes from `OBSIDIAN_VAULT_PATH` in `apps/tasks/.env`.

Each is its own agent because launchd binds one agent to one program on one schedule: a plist's `StartCalendarInterval` can list many times, but they all run the same script. The agents are siblings grouped by schedule — `com.personal-automation` is just the shared namespace, not a job. An app gets its own agent only when it needs its own schedule — otherwise it's another entry in `run.sh`. Keeping them apart also means each gets its own logs and its own failure notification.

All post a macOS notification on a non-zero exit.

```bash
./launchd/setup.sh   # generates the plists (daily, tasks, vault-backup)
cp launchd/com.personal-automation.daily.plist ~/Library/LaunchAgents/
cp launchd/com.personal-automation.tasks.plist ~/Library/LaunchAgents/
cp launchd/com.personal-automation.vault-backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.daily.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.tasks.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.vault-backup.plist
```

Run `./launchd/run-vault-backup.sh` once by hand before relying on the schedule — it confirms the `git push` credential (the https token in your keychain) is reachable from a launchd context.

Re-run `setup.sh` (and reload the digest agent — it prints the commands) whenever you change `TASKS_SCHEDULE`, since that regenerates the digest plist from the schedule.

Optional log rotation (weekly, keeps 4 gzipped archives):

```bash
sudo cp launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
```

Each app that can run more than once at a time guards itself with a PID lockfile in `$TMPDIR` (e.g. `ynab-categorize.lock`, `tasks.lock`) so a manual run and a scheduled run can't overlap. Stale locks from crashed runs are claimed automatically.

## Checking status

Quick commands to see whether the scheduled jobs are healthy and what the last run did.

### Are the agents loaded and OK?

The quick check — three columns: PID, last exit code, label. A label showing up means it's loaded; a `0` in the middle means the last run was clean. A `-` PID means "not running this instant," which is the normal, healthy state for a scheduled job — it only shows a real PID during the seconds it's actually running.

```bash
launchctl list | grep personal-automation
# -  0  com.personal-automation.daily
# -  0  com.personal-automation.tasks

# Same thing as an explicit OK / CHECK line per agent
launchctl list | awk '/personal-automation/ {print ($2==0 ? "OK   " : "CHECK") "  " $3 "  (last exit " $2 ")"}'
```

Only reach for the verbose `launchctl print` when you need details the line above doesn't show — next scheduled fire time, run count, the resolved program path:

```bash
launchctl print "gui/$(id -u)/com.personal-automation.daily"
launchctl print "gui/$(id -u)/com.personal-automation.tasks"
```

### Run logs (launchd stdout/stderr)

The daily run and the digest each write a stdout + stderr log under `launchd/logs/`:

```bash
# Daily run (ynab-enrich-memos → ynab-categorize → notify)
tail -n 50 launchd/logs/daily.out.log
tail -n 50 launchd/logs/daily.err.log

# tasks digest
tail -n 50 launchd/logs/tasks-digest.out.log
tail -n 50 launchd/logs/tasks-digest.err.log
```

A non-empty `*.err.log` isn't always a failure — pnpm and progress spinners write to stderr. Check the agent's last exit code (above) for the real verdict.

### What did the last run do? (audit logs)

Each YNAB app appends one JSONL line per transaction to `apps/<app>/audit/<app>-YYYY-MM-DD.jsonl`; `tasks` logs its classifications to `apps/tasks/runs/run-YYYY-MM-DD.jsonl`. With `jq`:

```bash
# Today's categorizer decisions, status counts (ok / error / skipped_for_no_match)
jq -r .status "apps/ynab-categorize/audit/ynab-categorize-$(date +%F).jsonl" | sort | uniq -c

# Today's enrichment results: did each transaction get a memo, and did the PATCH land?
jq -r '[.status, .patch_status, (.new_memo // "—")] | @tsv' \
  "apps/ynab-enrich-memos/audit/ynab-enrich-memos-$(date +%F).jsonl"

# Only the failures across both YNAB apps today
jq -c 'select(.status != "ok")' apps/*/audit/*-"$(date +%F)".jsonl

# Today's task review: which tasks went quiet, and why the model thinks so
jq -r '[.untouched_days, .classification, .title] | @tsv' "apps/tasks/runs/run-$(date +%F).jsonl"

# Most recent audit file per app (when did each last run?)
ls -t apps/ynab-categorize/audit apps/ynab-enrich-memos/audit apps/tasks/runs
```

### Trigger a run now

```bash
# Force the daily run immediately (-k kills any in-flight copy first)
launchctl kickstart -k "gui/$(id -u)/com.personal-automation.daily"

# Force the tasks digest
launchctl kickstart -k "gui/$(id -u)/com.personal-automation.tasks"
```

To run an app by hand without launchd (and without the failure notification), use the `pnpm --filter` commands in [Run](#run) — start with the `test:` dry-run script.

### Stuck lock?

A crashed run can leave a stale lockfile; the next run claims it automatically, but you can inspect or clear it:

```bash
ls -l "$TMPDIR"/ynab-categorize.lock "$TMPDIR"/tasks.lock 2>/dev/null
rm -f "$TMPDIR"/ynab-categorize.lock   # only if you're sure no run is active
```
