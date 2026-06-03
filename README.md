# personal-automation

A catch-all monorepo for my personal automation — a pnpm workspace of small scheduled jobs and the shared libraries they build on. There's no "main" app: each automation is its own app on top of shared packages, and the list grows as I add more.

- **`apps/ynab-categorize`** — daily CLI that auto-categorizes Amazon transactions using the Anthropic API (Claude Haiku by default).
- **`apps/ynab-enrich-memos`** — reads Amazon receipt emails, parses the product list, and PATCHes it into the `memo` of matching YNAB transactions so the categorizer has real item names to work from. Runs before `ynab-categorize` in the daily run.
- **`apps/notify`** — emails an error digest after the daily run when any app's audit log shows errors.
- **`apps/stalled-tasks`** — emails a scheduled digest reviewing open Apple Reminders: classifies why each has stalled and surfaces the few worth acting on with one next action each (v2 design in [apps/stalled-tasks/plan.md](apps/stalled-tasks/plan.md)).
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
- **`apps/stalled-tasks/.env`** — `REMINDERS_LISTS`, `STALLED_TASKS_SCHEDULE`, `STALLED_TASKS_TO_EMAIL`, `STALLED_TASKS_ANTHROPIC_MODEL`, and digest tuning (`DIGEST_MAX_ITEMS`, `STALE_THRESHOLD_DAYS`).
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

A digest that reviews open Apple Reminders, classifies why each has stalled, and emails the few worth acting on with one next action each. It runs on its own launchd schedule — the days/times in `STALLED_TASKS_SCHEDULE` (e.g. `["Sunday 08:00", "Wednesday 18:00"]`), so twice or three times a week is just more entries. It reviews the lists named in `REMINDERS_LISTS` (`[]` = all) and skips **recurring** reminders — those are time-triggered, so their own alert is their channel.

It reads Reminders locally through a Swift/EventKit bridge (`src/reminders/reminders.swift`), compiled on first run into a standalone, ad-hoc-signed binary (`reminders-bridge`). That compile step is a TCC requirement, not an optimization: a non-platform signed binary is its own permission "responsible process", so the Reminders grant attaches to it and holds under launchd. Running `swift reminders.swift` instead would attribute access to the Node runtime that spawned it — which Volta's `execve` makes impossible to grant reliably. It needs:

- **Xcode Command Line Tools** (`xcode-select --install`) — provides `swiftc`.
- **Reminders access**: the bridge requests it on first run, so macOS shows a consent prompt — click **Allow** (it appears as `reminders-bridge` under System Settings → Privacy & Security → Reminders). Without access the run fails with a clear error rather than emailing "nothing's stalled". Editing `reminders.swift` rebuilds the binary with a new identity, so you'll re-grant once after a change.

`STALLED_TASKS_ANTHROPIC_MODEL` is a separate knob from `YNAB_CATEGORIZER_ANTHROPIC_MODEL`. Classifying *why* a task is stuck and naming its next physical step is harder judgment than picking a category id, so it starts on a Sonnet-tier model rather than Haiku. Each run logs its classifications to `apps/stalled-tasks/runs/` for tuning.

## Production

Two launchd agents:

- `com.personal-automation` runs `launchd/run.sh` daily at 12:00 — each app in the `APPS` array in sequence (`ynab-enrich-memos` then `ynab-categorize`), then `notify`.
- `com.personal-automation.stalled-tasks` runs the digest on its `STALLED_TASKS_SCHEDULE` days/times.

Both post a macOS notification on a non-zero exit.

```bash
./launchd/setup.sh   # generates both plists, builds the Reminders bridge, primes its access grant
cp launchd/com.personal-automation.plist ~/Library/LaunchAgents/
cp launchd/com.personal-automation.stalled-tasks.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.stalled-tasks.plist
```

`setup.sh` also builds the `stalled-tasks` Reminders bridge and triggers its one-time access prompt — **approve it** so the scheduled run reads silently. That grant is tied to the binary's path, so **re-run `setup.sh` if you move the project** on disk. Re-run it (and reload the digest agent — `setup.sh` prints the commands) whenever you change `STALLED_TASKS_SCHEDULE`.

Optional log rotation (weekly, keeps 4 gzipped archives):

```bash
sudo cp launchd/newsyslog.personal-automation.conf /etc/newsyslog.d/
```

Each app that can run more than once at a time guards itself with a PID lockfile in `$TMPDIR` (e.g. `ynab-categorize.lock`, `stalled-tasks.lock`) so a manual run and a scheduled run can't overlap. Stale locks from crashed runs are claimed automatically.
