# Moving off macOS: the Linux/cloud move

Status: planning notes — the macOS couplings to remove if/when the daily run
moves off the Mac. The task source already moved to Obsidian (it runs on any OS);
this doc is everything *else* still tied to a Mac.

Done so far: the Obsidian reader is live and the **Apple path is removed**
(`apps/tasks/src/tasks/apple/` + the Swift bridge are gone), so the run no
longer needs EventKit/Swift. What's left is the rest of the macOS coupling, to
execute *during* the actual move (there's no target host yet):

1. Replace scheduling + notifications for the target host (below).
2. Handle the ephemeral-filesystem implications.
3. Retire `launchd/`.

## What's still macOS-coupled

| Area | Where | Why it's Mac-only |
|------|-------|-------------------|
| Scheduling | `launchd/` + `apps/tasks/src/schedule.ts` + `generate-launchd-plist.ts` | launchd, plists, `StartCalendarInterval` |
| Failure alerts | `launchd/run.sh`, `launchd/run-tasks-digest.sh` | `osascript display notification` |
| Log rotation | `launchd/newsyslog.*.conf.template` | newsyslog (BSD/macOS) |
| Filesystem assumptions | `run.sh` (`find -mtime` cleanup), `apps/*/audit/`, `runs/`, `$TMPDIR` lockfiles | assume one persistent host |

## Plan per area

### Scheduling → scheduled GitHub Actions (recommended)
This repo already lives on GitHub and runs CI + Claude on the web, so a
**scheduled workflow** is the lowest-friction cross-platform scheduler: a `cron:`
trigger, secrets in GitHub Actions, no host to own. `TASKS_SCHEDULE`
(`["Sunday 08:00", …]`) translates to cron expressions; the daily `APPS` loop in
`run.sh` becomes workflow steps. Alternatives if a long-lived box is preferred:
cron or systemd timers. Either way, `schedule.ts` / `generate-launchd-plist.ts`
get replaced by the new scheduler's config and `launchd/` is retired.

### Failure notifications → a small notifier seam
Replace the two `osascript` calls with a provider-neutral notifier, isolated behind
one module the way the vault's scanner and writer are:
- **Email** — reuse `packages/gmail`; the `notify` app already emails, so failure
  alerts can ride the same channel.
- **Push** — `ntfy.sh` (free) or Pushover (~$5 one-time) via a single HTTP POST,
  cloud-friendly.
- **Dead-man's-switch** — healthchecks.io to catch *silent* failures (the run not
  firing at all), which neither email nor push can.

Fold the current "notify on non-zero exit" logic into this so it's one code path,
not shell-script-only.

### Ephemeral filesystem
On a container/CI runner, anything written to disk vanishes after the run:
- `apps/*/audit/` and `runs/*.jsonl` — the `notify` app reads *today's* audit log,
  which is fine within a single run, but **cross-run history is lost**. `runs/` also
  holds `touch-clock.json`, which the task state model needs across runs: losing it
  stamps every task as touched today and costs one stall window of signal. Persist
  it: commit to a data branch/repo, or push to object storage.
- `find … -mtime +90 -delete` cleanup in `run.sh` — moot on ephemeral disk; drop
  it or repoint it at wherever logs are persisted.
- `$TMPDIR` PID lockfiles (`*.lock`) — assume one long-lived host. On a single-shot
  CI run they're unnecessary; if concurrency is still possible, use a different
  guard (e.g. Actions `concurrency:`).

## Footnote: why not Google Tasks
Google Tasks was the original target but was dropped in favor of Obsidian. The
blocker was timestamps: the Google Tasks API exposes `updated` but no creation
timestamp, and `updated` changes on every edit. The state model has since made that
moot in a stronger way — it is Obsidian-shaped throughout (state tags on the line,
checkbox statuses, `✅`/`❌` dates), so a second backend would have to reproduce all
of it rather than supply a list of tasks. Obsidian keeps todos as plain Markdown in
git, needs no OAuth, and co-locates todos with goals/notes for richer classification.
