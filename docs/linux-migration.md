# Moving off macOS: the Linux/cloud move

Status: planning notes on the macOS couplings to remove if/when the daily run
moves off the Mac. The task source is already off it: the Obsidian reader is live,
the **Apple path is removed** (`apps/tasks/src/tasks/apple/` + the Swift bridge are
gone), and reading a vault works on any OS. This doc is everything *else* still
tied to a Mac, to execute *during* the actual move; there's no target host yet.

## What's still macOS-coupled

| Area | Where | Why it's Mac-only |
|------|-------|-------------------|
| Scheduling | `launchd/` + `apps/tasks/src/schedule.ts` + `generate-launchd-plist.ts` | launchd, plists, `StartCalendarInterval` |
| Failure alerts | every `launchd/run*.sh` wrapper | `osascript display notification` |
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
Replace the `osascript` call in each of the four `run*.sh` wrappers with a
provider-neutral notifier, isolated behind one module the way the vault's scanner
and writer are:
- **Email**: reuse `packages/gmail`; the `notify` app already emails, so failure
  alerts can ride the same channel.
- **Push**: Pushover via a single HTTP POST, cloud-friendly, and already the
  channel the due-date alert uses. Not ntfy: it was tested on the real phone and
  delivered no iOS banner (see `docs/task-state-model.md`).
- **Dead-man's-switch**: healthchecks.io to catch *silent* failures (the run not
  firing at all), which neither email nor push can.

Fold the current "notify on non-zero exit" logic into this so it's one code path,
not shell-script-only.

### Ephemeral filesystem
On a container/CI runner, anything written to disk vanishes after the run:
- `apps/*/audit/` and `runs/*.jsonl`: the `notify` app reads *today's* audit log,
  which is fine within a single run, but **cross-run history is lost**. `runs/` also
  holds `touch-clock.json`, which the task state model needs across runs: losing it
  stamps every task as touched today and costs one stall window of signal. Persist
  it: commit to a data branch/repo, or push to object storage.
- `find … -mtime +90 -delete` cleanup in `run.sh`: moot on ephemeral disk; drop
  it or repoint it at wherever logs are persisted.
- `$TMPDIR` PID lockfiles (`*.lock`): these assume one long-lived host. On a single-shot
  CI run they're unnecessary; if concurrency is still possible, use a different
  guard (e.g. Actions `concurrency:`).

## Footnote: why not Google Tasks
Google Tasks was the original target but was dropped in favor of Obsidian. The
blocker was timestamps: the Google Tasks API exposes `updated` but no creation
timestamp, and `updated` changes on every edit. Obsidian keeps todos as plain
Markdown in git, needs no OAuth, and co-locates todos with goals and notes for
richer classification. The state model is now the stronger reason not to revisit
this, since it is Obsidian-shaped throughout: see "Reading and writing the vault"
in `docs/task-state-model.md`.
