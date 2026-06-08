# Getting off Apple: the Linux/cloud move

Status: planning notes — the remaining macOS couplings to remove once the daily
run moves off the Mac. The **task source** is being handled separately (Obsidian;
see `handoff-obsidian-migration.md`). This doc is everything *else* that ties the
project to a Mac.

Nothing here is implemented yet, on purpose: there's no target host yet, and the
Obsidian source (the prerequisite for running anywhere but the Mac) isn't built.
This is the plan to execute *during* the actual move, in roughly this order:

1. Land the Obsidian `TaskSource` (per the hand-off doc) so the run no longer
   needs EventKit/Swift.
2. Replace scheduling + notifications for the target host (below).
3. Handle the ephemeral-filesystem implications.
4. Delete the Apple path.

## What's still Apple/macOS-coupled

| Area | Where | Why it's Mac-only |
|------|-------|-------------------|
| Scheduling | `launchd/` + `apps/stalled-tasks/src/schedule.ts` + `generate-launchd-plist.ts` | launchd, plists, `StartCalendarInterval` |
| Failure alerts | `launchd/run.sh`, `launchd/run-stalled-tasks.sh` | `osascript display notification` |
| Log rotation | `launchd/newsyslog.*.conf.template` | newsyslog (BSD/macOS) |
| Filesystem assumptions | `run.sh` (`find -mtime` cleanup), `apps/*/audit/`, `runs/`, `$TMPDIR` lockfiles | assume one persistent host |
| Task source | `apps/stalled-tasks/src/tasks/apple/` (+ bridge) | EventKit/Swift; **being replaced by Obsidian** |

## Plan per area

### Scheduling → scheduled GitHub Actions (recommended)
This repo already lives on GitHub and runs CI + Claude on the web, so a
**scheduled workflow** is the lowest-friction cross-platform scheduler: a `cron:`
trigger, secrets in GitHub Actions, no host to own. `STALLED_TASKS_SCHEDULE`
(`["Sunday 08:00", …]`) translates to cron expressions; the daily `APPS` loop in
`run.sh` becomes workflow steps. Alternatives if a long-lived box is preferred:
cron or systemd timers. Either way, `schedule.ts` / `generate-launchd-plist.ts`
get replaced by the new scheduler's config and `launchd/` is retired.

### Failure notifications → a small notifier seam
Replace the two `osascript` calls with a provider-neutral notifier (mirroring the
`TaskSource` seam):
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
  which is fine within a single run, but **cross-run history is lost** (and `runs/`
  is what any "persist first-seen" staleness scheme would rely on). If history
  matters, persist it: commit to a data branch/repo, or push to object storage.
- `find … -mtime +90 -delete` cleanup in `run.sh` — moot on ephemeral disk; drop
  it or repoint it at wherever logs are persisted.
- `$TMPDIR` PID lockfiles (`*.lock`) — assume one long-lived host. On a single-shot
  CI run they're unnecessary; if concurrency is still possible, use a different
  guard (e.g. Actions `concurrency:`).

### Decommission Apple
Once the Obsidian source runs on the new host and scheduling + notifications are
replaced, `apps/stalled-tasks/src/tasks/apple/` (+ the Swift bridge) and all of
`launchd/` become dead weight and can be deleted wholesale. The provider seam
means no business logic changes — just drop `'apple'` from `TASK_PROVIDERS` and
the selector `case`. Keep it only if you still want a macOS-local option.

## Footnote: why not Google Tasks
Google Tasks was the original target but was dropped in favor of Obsidian. The
blocker: the Google Tasks API exposes `updated` but **no creation timestamp**, and
`updated` changes on every edit — so staleness (which is driven by `created`) would
reset whenever a task is touched. Obsidian keeps todos as plain Markdown in git
with an explicit `➕` created-date (and git history as a backstop), needs no OAuth,
and co-locates todos with goals/notes for richer classification.
