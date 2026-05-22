# ynab-automation

Personal YNAB automations. pnpm monorepo containing:

- **`apps/categorize`** — daily CLI that auto-categorizes Amazon transactions using a local Ollama model.
- **`apps/enrich-memos`** — planned Phase 2 (design only — see [apps/enrich-memos/plan.md](apps/enrich-memos/plan.md)). Reads Amazon receipt emails, parses product names, PATCHes `memo` on matching YNAB transactions so the categorizer has better data to work with.
- **`packages/ynab`** — shared YNAB API client (zod-validated) + schemas + types + milliunits helpers.
- **`packages/common`** — shared helpers: pino-based logger, AppError + retry, PID lockfile, ora spinner, plus tiny utilities (json, chunks, date).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced via a husky `commit-msg` hook running commitlint.

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in YNAB_TOKEN and replace the placeholder budget id + allowed account ids with yours.
# EXCLUDED_CATEGORY_GROUPS and CATEGORY_ROUTING_HINTS are personal-tuning knobs —
# add the YNAB category-group names you want hidden from the LLM, and any
# routing nudges that map specific purchases to your categories.
# LOOKBACK_DAYS, AUDIT_DIR, OLLAMA_URL, and OLLAMA_MODEL have working defaults.
```

Every variable in `.env` is required at startup — config loaders throw if any are missing.

Requires Node 26+, pnpm 11+, and a running Ollama (`ollama serve`) with the configured model pulled (`ollama pull qwen2.5:14b`).

## Run

```bash
# Dry run with verbose logs — does NOT PATCH
pnpm test:categorize

# Real run
pnpm categorize

# Override lookback window
pnpm categorize --lookback-days 5
```

The categorizer always appends a JSONL audit line per decision to `apps/categorize/audit/categorize-YYYY-MM-DD.jsonl`.

## What `categorize` does

1. Loads category groups from YNAB, drops hidden/deleted, drops "Internal Master Category" and the `EXCLUDED_CATEGORY_GROUPS` list, and discovers the "Uncategorized" id for fallback.
2. Loads transactions per allowed account `since LOOKBACK_DAYS`, keeps only those that are:
   - in an allowed account
   - `payee_name === "Amazon"`
   - not a transfer
   - not already flagged `auto-categorized`
3. For each eligible transaction (concurrency 1 because Ollama serializes inference), asks the Ollama model to pick a category. Empty memos, unparseable JSON, invalid shapes, and unknown category ids all fall through to "Uncategorized".
4. Bulk PATCHes the result with `flag_color: yellow`, `flag_name: auto-categorized` so the script is idempotent. Batches of 10.

## Production

Two launchd jobs in `launchd/`:

- **`com.ynab-automation.ollama`** — KeepAlive daemon that keeps `ollama serve` running so the daily job doesn't pay model-load cost or race a manual shell.
- **`com.ynab-automation`** — runs `launchd/run.sh` daily at 12:00 local time. The wrapper runs each app in `APPS` sequentially (currently just `categorize`; uncomment `enrich-memos` once it lands) and posts a macOS notification if any non-zero exits.

```bash
./launchd/setup.sh   # generates plists + newsyslog.conf with this checkout's path and your username
cp launchd/com.ynab-automation.plist launchd/com.ynab-automation.ollama.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ynab-automation.ollama.plist
launchctl load ~/Library/LaunchAgents/com.ynab-automation.plist
```

Optional log rotation (weekly, keeps 4 gzipped archives — covers both jobs' logs):

```bash
sudo cp launchd/newsyslog.ynab-automation.conf /etc/newsyslog.d/
```

A PID lockfile at `$TMPDIR/ynab-categorize.lock` prevents overlapping runs of the categorizer (manual + scheduled, or two scheduled). Stale locks from crashed runs are claimed automatically.
