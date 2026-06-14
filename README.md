# personal-automation

A catch-all monorepo for my personal automation — a pnpm workspace of small scheduled jobs and the shared libraries they build on. There's no "main" app: each automation is its own app on top of shared packages, and the list grows as I add more.

- **`apps/ynab-categorize`** — daily CLI that auto-categorizes Amazon transactions using the Anthropic API (Claude Haiku by default).
- **`apps/ynab-enrich-memos`** — reads Amazon receipt emails, parses the product list, and PATCHes it into the `memo` of matching YNAB transactions so the categorizer has real item names to work from. Runs before `ynab-categorize` in the daily run.
- **`apps/notify`** — emails an error digest after the daily run when any app's audit log shows errors.
- **`apps/stalled-tasks`** — emails a scheduled digest reviewing open Obsidian todos: classifies why each has stalled and surfaces the few worth acting on with one next action each.
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
- [stalled-tasks](#stalled-tasks)
- [Production](#production)
- [Checking status](#checking-status)

## Setup

```bash
pnpm install
cp .env.example .env                                            # shared secrets + ids
cp apps/ynab-categorize/.env.example apps/ynab-categorize/.env  # only for apps you run
cp apps/ynab-enrich-memos/.env.example apps/ynab-enrich-memos/.env
cp apps/stalled-tasks/.env.example apps/stalled-tasks/.env
cp apps/notify/.env.example apps/notify/.env
```

Config is split: shared secrets and ids live in the root `.env`, and each app's own config sits beside it in `apps/<app>/.env`. At startup an app loads the root `.env` then its own `.env` on top; every variable it needs is required — config loaders throw if any are missing — so only fill in the apps you actually run. Each `.env` has a `.env.example` next to it:

- **root `.env`** — `ANTHROPIC_API_KEY` (from [console.anthropic.com](https://console.anthropic.com), separate from Claude Pro), `YNAB_TOKEN` + `YNAB_BUDGET_ID`, `ALLOWED_ACCOUNT_IDS` (shared by both YNAB apps), and the `GMAIL_OAUTH_*` credentials apps send mail through.
- **`apps/ynab-categorize/.env`** — `LOOKBACK_DAYS`, `AUDIT_DIR`, `EXCLUDED_CATEGORY_GROUPS`, `CATEGORY_ROUTING_HINTS`, `YNAB_CATEGORIZER_ANTHROPIC_MODEL`.
- **`apps/ynab-enrich-memos/.env`** — `AUDIT_DIR`, `ENRICH_LOOKBACK_DAYS`, `GMAIL_RECEIPT_WINDOW_DAYS`, `GMAIL_FROM_FILTER`, `ENRICH_MEMOS_ANTHROPIC_MODEL`.
- **`apps/stalled-tasks/.env`** — `TASK_PROVIDER`, `TASK_LISTS`, `STALLED_TASKS_SCHEDULE`, `STALLED_TASKS_TO_EMAIL`, `STALLED_TASKS_ANTHROPIC_MODEL`, and digest tuning (`DIGEST_MAX_ITEMS`, `STALE_THRESHOLD_DAYS`).
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

# stalled-tasks — print the digest to the console without sending
pnpm --filter @personal-automation/stalled-tasks test:stalled-tasks
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

## stalled-tasks

A digest that reviews open tasks, classifies why each has stalled, and emails the few worth acting on with one next action each. It runs on its own launchd schedule — the days/times in `STALLED_TASKS_SCHEDULE` (e.g. `["Sunday 08:00", "Wednesday 08:00"]`), so twice or three times a week is just more entries. It reviews the lists named in `TASK_LISTS` (`[]` = all). A task with a **due date** is judged by it — overdue surfaces, a future due date counts as scheduled and is skipped — and **recurring** tasks are treated the same way (judged by when their next occurrence is due), so anchor them with a date.

The task backend is chosen by `TASK_PROVIDER`: tasks are read through a `TaskSource` (`src/tasks/types.ts`), and `createTaskSource` (`src/tasks/source.ts`) is the single switch point between providers. The implemented provider is `obsidian` (`src/tasks/obsidian/`); `google` (Google Tasks) is an un-implemented placeholder kept to show the seam stays open. Switching is a config change, not a code change.

The `obsidian` provider reads Markdown todos from a vault on disk (`OBSIDIAN_VAULT_PATH`). With `TASK_LISTS=[]` it reads `todos.md` at the vault root; otherwise `TASK_LISTS` names files or folders (relative to the vault) and folders are walked for their `*.md`. It parses [Obsidian Tasks](https://publish.obsidian.md/tasks/) lines — only open `- [ ]` checkboxes count (done/cancelled/in-progress are skipped), `➕` sets the creation date that drives staleness for undated tasks, `📅` the due date, and recurring (`🔁`) tasks are kept and judged by their due date (the rule is stripped from the title). The read is read-only and doesn't pull, so it sees the last synced state on disk — keep the vault synced separately (Obsidian Sync or the Obsidian Git plugin). It works on any OS.

`STALLED_TASKS_ANTHROPIC_MODEL` is a separate knob from `YNAB_CATEGORIZER_ANTHROPIC_MODEL`. Classifying *why* a task is stuck and naming its next physical step is harder judgment than picking a category id, so it starts on a Sonnet-tier model rather than Haiku. Each run logs its classifications to `apps/stalled-tasks/runs/` for tuning.

## Production

Three launchd agents:

- `com.personal-automation.daily` runs `launchd/run.sh` daily at 12:00 — each app in the `APPS` array in sequence (`ynab-enrich-memos` then `ynab-categorize`), then `notify`.
- `com.personal-automation.stalled-tasks` runs the digest on its `STALLED_TASKS_SCHEDULE` days/times.
- `com.personal-automation.vault-backup` runs `launchd/run-vault-backup.sh` weekly (Sunday 09:00) — a one-way `git push` of the Obsidian vault to its remote for offsite backup. Obsidian Sync is the live cross-device sync; this only snapshots to git, so it never conflicts. The vault path comes from `OBSIDIAN_VAULT_PATH` in `apps/stalled-tasks/.env`.

Each is its own agent because launchd binds one agent to one program on one schedule: a plist's `StartCalendarInterval` can list many times, but they all run the same script. The agents are siblings grouped by schedule — `com.personal-automation` is just the shared namespace, not a job. An app gets its own agent only when it needs its own schedule — otherwise it's another entry in `run.sh`. Keeping them apart also means each gets its own logs and its own failure notification.

All post a macOS notification on a non-zero exit.

```bash
./launchd/setup.sh   # generates the plists (daily, stalled-tasks, vault-backup)
cp launchd/com.personal-automation.daily.plist ~/Library/LaunchAgents/
cp launchd/com.personal-automation.stalled-tasks.plist ~/Library/LaunchAgents/
cp launchd/com.personal-automation.vault-backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.daily.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.vault-backup.plist
```

Run `./launchd/run-vault-backup.sh` once by hand before relying on the schedule — it confirms the `git push` credential (the https token in your keychain) is reachable from a launchd context.

Re-run `setup.sh` (and reload the digest agent — it prints the commands) whenever you change `STALLED_TASKS_SCHEDULE`, since that regenerates the digest plist from the schedule.

Optional log rotation (weekly, keeps 4 gzipped archives):

```bash
sudo cp launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
```

Each app that can run more than once at a time guards itself with a PID lockfile in `$TMPDIR` (e.g. `ynab-categorize.lock`, `stalled-tasks.lock`) so a manual run and a scheduled run can't overlap. Stale locks from crashed runs are claimed automatically.

## Checking status

Quick commands to see whether the scheduled jobs are healthy and what the last run did.

### Are the agents loaded and OK?

The quick check — three columns: PID, last exit code, label. A label showing up means it's loaded; a `0` in the middle means the last run was clean. A `-` PID means "not running this instant," which is the normal, healthy state for a scheduled job — it only shows a real PID during the seconds it's actually running.

```bash
launchctl list | grep personal-automation
# -  0  com.personal-automation.daily
# -  0  com.personal-automation.stalled-tasks

# Same thing as an explicit OK / CHECK line per agent
launchctl list | awk '/personal-automation/ {print ($2==0 ? "OK   " : "CHECK") "  " $3 "  (last exit " $2 ")"}'
```

Only reach for the verbose `launchctl print` when you need details the line above doesn't show — next scheduled fire time, run count, the resolved program path:

```bash
launchctl print "gui/$(id -u)/com.personal-automation.daily"
launchctl print "gui/$(id -u)/com.personal-automation.stalled-tasks"
```

### Run logs (launchd stdout/stderr)

The daily run and the digest each write a stdout + stderr log under `launchd/logs/`:

```bash
# Daily run (ynab-enrich-memos → ynab-categorize → notify)
tail -n 50 launchd/logs/daily.out.log
tail -n 50 launchd/logs/daily.err.log

# stalled-tasks digest
tail -n 50 launchd/logs/stalled-tasks.out.log
tail -n 50 launchd/logs/stalled-tasks.err.log
```

A non-empty `*.err.log` isn't always a failure — pnpm and progress spinners write to stderr. Check the agent's last exit code (above) for the real verdict.

### What did the last run do? (audit logs)

Each YNAB app appends one JSONL line per transaction to `apps/<app>/audit/<app>-YYYY-MM-DD.jsonl`; `stalled-tasks` logs its classifications to `apps/stalled-tasks/runs/run-YYYY-MM-DD.jsonl`. With `jq`:

```bash
# Today's categorizer decisions, status counts (ok / error / skipped_for_no_match)
jq -r .status "apps/ynab-categorize/audit/ynab-categorize-$(date +%F).jsonl" | sort | uniq -c

# Today's enrichment results: did each transaction get a memo, and did the PATCH land?
jq -r '[.status, .patch_status, (.new_memo // "—")] | @tsv' \
  "apps/ynab-enrich-memos/audit/ynab-enrich-memos-$(date +%F).jsonl"

# Only the failures across both YNAB apps today
jq -c 'select(.status != "ok")' apps/*/audit/*-"$(date +%F)".jsonl

# Today's stalled-tasks digest: titles and why each was flagged
jq -r '[.classification, .title] | @tsv' "apps/stalled-tasks/runs/run-$(date +%F).jsonl"

# Most recent audit file per app (when did each last run?)
ls -t apps/ynab-categorize/audit apps/ynab-enrich-memos/audit apps/stalled-tasks/runs
```

### Trigger a run now

```bash
# Force the daily run immediately (-k kills any in-flight copy first)
launchctl kickstart -k "gui/$(id -u)/com.personal-automation.daily"

# Force the stalled-tasks digest
launchctl kickstart -k "gui/$(id -u)/com.personal-automation.stalled-tasks"
```

To run an app by hand without launchd (and without the failure notification), use the `pnpm --filter` commands in [Run](#run) — start with the `test:` dry-run script.

### Stuck lock?

A crashed run can leave a stale lockfile; the next run claims it automatically, but you can inspect or clear it:

```bash
ls -l "$TMPDIR"/ynab-categorize.lock "$TMPDIR"/stalled-tasks.lock 2>/dev/null
rm -f "$TMPDIR"/ynab-categorize.lock   # only if you're sure no run is active
```
