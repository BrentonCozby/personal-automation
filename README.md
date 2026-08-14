# personal-automation

A catch-all monorepo for my personal automation: a pnpm workspace of small scheduled jobs and the shared libraries they build on. There's no "main" app: each automation is its own app on top of shared packages.

- **`apps/ynab-categorize`**: daily CLI that auto-categorizes Amazon transactions using the Anthropic API (Claude Haiku by default).
- **`apps/ynab-enrich-memos`**: reads Amazon receipt emails, parses the product list, and PATCHes it into the `memo` of matching YNAB transactions so the categorizer has real item names to work from. Runs before `ynab-categorize` in the daily run.
- **`apps/notify`**: emails an error digest after the daily run when any app's audit log shows errors.
- **`apps/tasks`**: a state model over Obsidian todos, with a scheduled review that emails the committed tasks that have gone quiet (one next action each) plus a record of what was finished and dropped, and a daily job that pushes what is due to the phone.
- **`packages/anthropic`**: shared Claude API client (`messages.parse` + `zodOutputFormat`).
- **`packages/ynab`**: shared YNAB API client (zod-validated) + schemas + types + milliunits helpers.
- **`packages/gmail`**: Gmail API client (OAuth + send, optional multipart HTML), zod-validated.
- **`packages/common`**: shared helpers: pino-based logger, AppError + retry, PID lockfile, ora spinner, plus tiny utilities (json, chunks, date).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), enforced via a husky `commit-msg` hook running commitlint.

## Setup

```bash
pnpm install
cp .env.example .env                                            # shared secrets + ids
cp apps/ynab-categorize/.env.example apps/ynab-categorize/.env  # only for apps you run
cp apps/ynab-enrich-memos/.env.example apps/ynab-enrich-memos/.env
cp apps/tasks/.env.example apps/tasks/.env
cp apps/notify/.env.example apps/notify/.env
```

Config is split: shared secrets and ids live in the root `.env`, and each app's own tuning sits beside it in `apps/<app>/.env`. At startup an app loads the root `.env` then its own `.env` on top; every variable it needs is required (config loaders throw if any are missing), so only fill in the apps you actually run. Each `.env.example` lists exactly what its `.env` has to set, and is the file to read for the current list.

Two of them need more than a value pasted in:

- `ANTHROPIC_API_KEY` comes from [console.anthropic.com](https://console.anthropic.com) and is separate from a Claude Pro subscription.
- `pnpm --filter @personal-automation/gmail bootstrap` mints `GMAIL_OAUTH_REFRESH_TOKEN`. Re-run it after any Google password change, which revokes the token.

Requires Node 26+ and pnpm 11+.

## Run

Each app is a workspace package; run its scripts with `pnpm --filter`. No app is privileged at the root:

```bash
pnpm --filter @personal-automation/<app> <script>
```

```bash
# ynab-categorize: dry run (verbose, does NOT PATCH), then a real run
pnpm --filter @personal-automation/ynab-categorize test:ynab-categorize
pnpm --filter @personal-automation/ynab-categorize ynab-categorize
pnpm --filter @personal-automation/ynab-categorize ynab-categorize --lookback-days 5

# ynab-enrich-memos: dry run (does NOT PATCH), then a real run
pnpm --filter @personal-automation/ynab-enrich-memos test:ynab-enrich-memos
pnpm --filter @personal-automation/ynab-enrich-memos ynab-enrich-memos

# tasks: print the digest to the console without sending
pnpm --filter @personal-automation/tasks test:tasks

# tasks: act on one task (any part of the title, no quoting needed)
pnpm --filter @personal-automation/tasks tasks promote fix the bike
pnpm --filter @personal-automation/tasks tasks schedule fix the bike +7d
pnpm --filter @personal-automation/tasks tasks abandon fix the bike

# tasks: give every untagged task its first tag (prints a diff; --apply writes)
pnpm --filter @personal-automation/tasks tasks migrate

# tasks: print the due-date push instead of sending it
pnpm --filter @personal-automation/tasks tasks alert --dry-run
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

Only Amazon, non-transfer rows with an empty `memo` are eligible, so a memo you typed or a prior run wrote is never touched. For each, it searches Gmail for receipts from `GMAIL_FROM_FILTER` senders within ±`GMAIL_RECEIPT_WINDOW_DAYS` of the charge, drops any that fail DMARC, and asks Claude for the order whose total equals the charge to the cent. That total is re-checked in code, so an unverifiable match is dropped rather than written. What lands is a memo-only PATCH prefixed `auto-gen:`, with no flag, leaving the row for the categorizer.

## tasks

A state model over the todos in an [Obsidian](https://publish.obsidian.md/tasks/) vault, plus two scheduled jobs on top of it. Each task is tagged `#someday` or `#active`, and `#active` is capped at `TASKS_WIP_CAP`. What the states mean, and why the model is shaped this way, is in [docs/task-state-model.md](docs/task-state-model.md); [Run](#run) has the invocations.

**The review** has its own launchd agent, on the days and times in `TASKS_SCHEDULE` (e.g. `["Sunday 08:00", "Wednesday 08:00"]`, so three times a week is just another entry). It emails the `#active` tasks that have gone quiet, one next physical step each, alongside the record of what you finished and dropped in the last `TASKS_DONE_WINDOW_DAYS` days.

**The alert** runs every day, at each time in `TASKS_ALERT_TIMES` (e.g. `["08:05", "19:00"]`). It pushes what is due to your phone through Pushover, and demotes anything `#active` that has gone `TASKS_HORIZON_DAYS` days untouched. The plist generator refuses an alert time on a minute `TASKS_SCHEDULE` names: both agents write the whole touch-clock file, so whichever saved second would discard the other's entries.

`tasks migrate` gives every untagged task its first tag. Then `promote` (refusing at the cap unless you pass `--over-cap`), `schedule` and `abandon` act on one task at a time, each taking any part of its title. `tasks alert --dry-run` prints the push instead of sending it, but is not read-only: it still demotes, and it still writes the touch clock.

`TASK_LISTS` names the files or folders to read, relative to `OBSIDIAN_VAULT_PATH`, and folders are walked for their `*.md`. An empty list means `todos.md` at the vault root. Nothing pulls the vault, so every command reads the last synced state on disk; keep it synced separately, with Obsidian Sync or the Obsidian Git plugin.

`TASKS_ANTHROPIC_MODEL` is a separate knob from `YNAB_CATEGORIZER_ANTHROPIC_MODEL`. Judging *why* a commitment went quiet and naming its next physical step is harder judgment than picking a category id, so it starts on a Sonnet-tier model rather than Haiku. Each run logs its classifications to `apps/tasks/runs/` for tuning.

## Production

Four launchd agents:

- `com.personal-automation.daily` runs `launchd/run.sh` daily at 12:00: each app in the `APPS` array in sequence (`ynab-enrich-memos` then `ynab-categorize`), then `notify`.
- `com.personal-automation.tasks` runs the digest on its `TASKS_SCHEDULE` days/times.
- `com.personal-automation.tasks-alert` runs `launchd/run-tasks-alert.sh` at each time in `TASKS_ALERT_TIMES`, every day: the due-date push, and the decay pass that goes with it.
- `com.personal-automation.vault-backup` runs `launchd/run-vault-backup.sh` daily (09:00): a one-way `git push` of the Obsidian vault to its remote for offsite backup. Obsidian Sync is the live cross-device sync; this only snapshots to git, so it never conflicts. The vault path comes from `OBSIDIAN_VAULT_PATH` in `apps/tasks/.env`.

Each is its own agent because launchd binds one agent to one program on one schedule: a plist's `StartCalendarInterval` can list many times, but they all run the same script. So an app gets its own agent only when it needs its own schedule, and is otherwise another entry in `run.sh`. Keeping them apart also gives each its own logs and its own failure notification. `com.personal-automation` is the shared namespace, not a job.

All post a macOS notification on a non-zero exit.

```bash
./launchd/setup.sh   # generates the plists (daily, tasks, tasks-alert, vault-backup)
for agent in daily tasks tasks-alert vault-backup; do
  cp "launchd/com.personal-automation.$agent.plist" ~/Library/LaunchAgents/
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/"com.personal-automation.$agent.plist"
done
```

Run `./launchd/run-vault-backup.sh` once by hand before relying on the schedule: it confirms the `git push` credential (the https token in your keychain) is reachable from a launchd context.

Re-run `setup.sh` whenever you change `TASKS_SCHEDULE` or `TASKS_ALERT_TIMES`, then reload the agent it names; it prints those commands.

Optional log rotation (weekly, keeps 4 gzipped archives):

```bash
sudo cp launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
```

Each app that can run more than once at a time guards itself with a PID lockfile in `$TMPDIR` (e.g. `ynab-categorize.lock`, `tasks.lock`) so a manual run and a scheduled run can't overlap. Stale locks from crashed runs are claimed automatically.

## Checking status

### Are the agents loaded and OK?

The quick check gives three columns: PID, last exit code, label. A label showing up means it's loaded; a `0` in the middle means the last run was clean. A `-` PID means "not running this instant," which is the normal, healthy state for a scheduled job: a real PID shows only during the seconds it runs.

```bash
launchctl list | grep personal-automation
# -  0  com.personal-automation.daily
# -  0  com.personal-automation.tasks
# -  0  com.personal-automation.tasks-alert

# Same thing as an explicit OK / CHECK line per agent
launchctl list | awk '/personal-automation/ {print ($2==0 ? "OK   " : "CHECK") "  " $3 "  (last exit " $2 ")"}'
```

Only reach for the verbose `launchctl print` when you need details the line above doesn't show, such as next scheduled fire time, run count, or the resolved program path:

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

A non-empty `*.err.log` isn't always a failure: pnpm and progress spinners write to stderr. Check the agent's last exit code (above) for the real verdict.

### What did the last run do? (audit logs)

Each YNAB app appends one JSONL line per transaction to `apps/<app>/audit/<app>-YYYY-MM-DD.jsonl`; `tasks` logs its classifications to `apps/tasks/runs/run-YYYY-MM-DD.jsonl`. With `jq`:

```bash
# Today's categorizer decisions, status counts (categorized / fallback / error)
jq -r .status "apps/ynab-categorize/audit/ynab-categorize-$(date +%F).jsonl" | sort | uniq -c

# Today's enrichment results: did each transaction get a memo, and did the PATCH land?
jq -r '[.status, .outcome, (.new_memo // "-")] | @tsv' \
  "apps/ynab-enrich-memos/audit/ynab-enrich-memos-$(date +%F).jsonl"

# Only the failures across both YNAB apps today. `outcome` is the shared field every app
# writes; `status` is per-app, so it can't be queried across both.
jq -c 'select(.outcome == "failed" or .outcome == "failed_upstream")' \
  apps/*/audit/*-"$(date +%F)".jsonl

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

To run an app by hand without launchd (and without the failure notification), use the `pnpm --filter` commands in [Run](#run). Start with the `test:` dry-run script.

### Stuck lock?

The next run claims a stale lockfile on its own, but you can inspect or clear one:

```bash
ls -l "$TMPDIR"/ynab-categorize.lock "$TMPDIR"/tasks.lock 2>/dev/null
rm -f "$TMPDIR"/ynab-categorize.lock   # only if you're sure no run is active
```
