# personal-automation

Personal automation monorepo — a pnpm workspace of small scheduled jobs and the shared libraries they use. Budgeting (YNAB) is the main domain today, but the layout isn't YNAB-specific: each automation is its own app on top of shared infrastructure.

- **`apps/ynab-categorize`** — daily CLI that auto-categorizes Amazon transactions using the Anthropic API (Claude Haiku by default).
- **`apps/ynab-enrich-memos`** — planned Phase 2 (design only — see [apps/ynab-enrich-memos/plan.md](apps/ynab-enrich-memos/plan.md)). Reads Amazon receipt emails, parses product names, PATCHes `memo` on matching YNAB transactions so the categorizer has better data to work with.
- **`apps/notify`** — emails a digest after the daily run when any app's audit log shows errors (design in [apps/notify/plan.md](apps/notify/plan.md)).
- **`apps/stalled-tasks`** — weekly email that reviews open Apple Reminders, classifies why each has stalled, and surfaces the few worth acting on with one next action each (design in [apps/stalled-tasks/plan.md](apps/stalled-tasks/plan.md)).
- **`packages/ynab`** — shared YNAB API client (zod-validated) + schemas + types + milliunits helpers.
- **`packages/gmail`** — Gmail API client (OAuth + send), zod-validated.
- **`packages/common`** — shared helpers: pino-based logger, AppError + retry, PID lockfile, ora spinner, plus tiny utilities (json, chunks, date).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced via a husky `commit-msg` hook running commitlint.

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in YNAB_TOKEN and replace the placeholder budget id + allowed account ids with yours.
# Get ANTHROPIC_API_KEY from https://console.anthropic.com (separate from Claude Pro).
# EXCLUDED_CATEGORY_GROUPS and CATEGORY_ROUTING_HINTS are personal-tuning knobs —
# add the YNAB category-group names you want hidden from the LLM, and any
# routing nudges that map specific purchases to your categories.
# LOOKBACK_DAYS, AUDIT_DIR, and ANTHROPIC_MODEL have working defaults.
```

Every variable in `.env` is required at startup — config loaders throw if any are missing.

Requires Node 26+ and pnpm 11+.

## Run

```bash
# Dry run with verbose logs — does NOT PATCH
pnpm test:ynab-categorize

# Real run
pnpm ynab-categorize

# Override lookback window
pnpm ynab-categorize --lookback-days 5
```

The categorizer always appends a JSONL audit line per decision to `apps/ynab-categorize/audit/ynab-categorize-YYYY-MM-DD.jsonl`.

## What `ynab-categorize` does

1. Loads category groups from YNAB, drops hidden/deleted, drops "Internal Master Category" and the `EXCLUDED_CATEGORY_GROUPS` list, and discovers the "Uncategorized" id for fallback.
2. Loads transactions per allowed account `since LOOKBACK_DAYS`, keeps only those that are:
   - in an allowed account
   - `payee_name === "Amazon"`
   - not a transfer
   - not already flagged `auto-categorized`
3. For each eligible transaction (4 in parallel), asks Claude to pick a category via `messages.parse()` with a Zod-validated JSON schema. Empty memos, missing ids, and unknown ids all fall through to "Uncategorized".
4. Bulk PATCHes the result with `flag_color: yellow`, `flag_name: auto-categorized` so the script is idempotent. Batches of 10.

## stalled-tasks

A weekly digest that reviews open Apple Reminders, classifies why each has stalled, and emails the few worth acting on with one next action each. It runs daily from `launchd/run.sh` but only sends on `DIGEST_DAY`. It reviews the lists named in `REMINDERS_LISTS` (`[]` = all) and skips **recurring** reminders — those are time-triggered, so their own alert is their channel.

```bash
# Print the digest to the console without sending (also bypasses the day gate):
pnpm --filter @personal-automation/stalled-tasks test:stalled-tasks
```

It reads Reminders locally through a Swift/EventKit bridge (`src/reminders/reminders.swift`), compiled on first run into a standalone, ad-hoc-signed binary (`reminders-bridge`). That compile step is a TCC requirement, not an optimization: a non-platform signed binary is its own permission "responsible process", so the Reminders grant attaches to it and holds under launchd. Running `swift reminders.swift` instead would attribute access to the Node runtime that spawned it — which Volta's `execve` makes impossible to grant reliably. It needs:

- **Xcode Command Line Tools** (`xcode-select --install`) — provides `swiftc`.
- **Reminders access**: the bridge requests it on first run, so macOS shows a consent prompt — click **Allow** (it appears as `reminders-bridge` under System Settings → Privacy & Security → Reminders). Without access the run fails with a clear error rather than emailing "nothing's stalled". Editing `reminders.swift` rebuilds the binary with a new identity, so you'll re-grant once after a change.

`STALLED_TASKS_MODEL` is a separate knob from `ANTHROPIC_MODEL` (the categorizer's). Classifying *why* a task is stuck and naming its next physical step is harder judgment than picking a category id, so it starts on a Sonnet-tier model rather than Haiku. Each run logs its classifications to `apps/stalled-tasks/runs/` for tuning.

## Production

`launchd/com.personal-automation` runs `launchd/run.sh` daily at 12:00 local time. The wrapper runs each app in `APPS` sequentially (currently just `ynab-categorize`; uncomment `ynab-enrich-memos` once it lands) and posts a macOS notification if any non-zero exits.

```bash
./launchd/setup.sh   # generates the plist + newsyslog.conf, builds the Reminders bridge, primes its access grant
cp launchd/com.personal-automation.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.personal-automation.plist
```

`setup.sh` also builds the `stalled-tasks` Reminders bridge and triggers its one-time access prompt — **approve it** so the scheduled run reads silently. That grant is tied to the binary's path, so **re-run `setup.sh` if you move the project** on disk.

Optional log rotation (weekly, keeps 4 gzipped archives):

```bash
sudo cp launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
```

A PID lockfile at `$TMPDIR/ynab-categorize.lock` prevents overlapping runs of the categorizer (manual + scheduled, or two scheduled). Stale locks from crashed runs are claimed automatically.
