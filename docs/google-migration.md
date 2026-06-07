# Migrating off Apple: Google Tasks + a non-macOS host

Status: planning notes. Nothing here is implemented beyond the provider seam
(`apps/stalled-tasks/src/tasks/`). This doc records the decisions to make
*before* writing the Google side, so the gotchas aren't discovered mid-build.

## Where the seam already is

`stalled-tasks` reads tasks through a provider-neutral interface, so swapping
backends is a config change, not a rewrite:

- `apps/stalled-tasks/src/tasks/types.ts` — `Task` / `TaskSource` (no
  provider terms leak past here).
- `apps/stalled-tasks/src/tasks/source.ts` — `createTaskSource({ provider,
  lists })`, the single switch point. `apple` is implemented; `google` throws
  a clear not-implemented error.
- `apps/stalled-tasks/src/tasks/apple/` — the EventKit/Swift bridge,
  macOS-only.
- Selected by `TASK_PROVIDER` (`apple` | `google`) + `TASK_LISTS`.

Building Google = add `createGoogleTaskSource` under `tasks/google/`, wire one
`case` into the selector, set `TASK_PROVIDER=google`.

## 1. The landmine: Google Tasks has no creation timestamp

The digest's value comes from `staleDays` (`apps/stalled-tasks/src/staleness.ts`),
driven by `Task.created`, falling back to `Task.lastModified`.

The Google Tasks API task resource exposes **`updated` but no creation time**,
and `updated` changes on every edit. So the naive mapping `created ← updated`
means **editing a task resets its staleness clock** — different from Apple and
largely self-defeating ("stale" would mean "untouched since last edit").

Decide one of these explicitly (don't let `created: null` happen by accident):

- **Persist first-seen (recommended).** We already write `runs/*.jsonl` every
  run. Seed `created` from the earliest run that observed the task id. Requires
  durable storage for `runs/` (see §3 — ephemeral hosts break this).
- **Accept `updated`-based staleness.** Simpler; document the behavior change.
- **Heuristic / other signal.** e.g. position, or a `notes` convention.

Also note:
- Google `due` is **date-only** (time portion ignored); Apple `due` carries a
  time. The digest only uses date granularity today, so this is low-impact —
  just don't assume a time.
- Google Tasks has **no recurrence**, so the `recurring` filter in the Apple
  bridge is simply a no-op there.

## 2. Auth & packaging

- **Scope:** Google Tasks needs `auth/tasks.readonly` added to the OAuth
  consent. Reusing the existing Google OAuth app means a **re-consent / new
  refresh token**.
- **Naming:** `GMAIL_OAUTH_*` in the root `.env` will be misleading once it
  also powers Tasks. Consider renaming to `GOOGLE_OAUTH_*` (touches root
  `.env`, `.env.example`, `packages/gmail`, and `apps/*/config.ts`).
- **Packaging:** per repo conventions, the API client is a package
  (`packages/google-tasks`, mirroring `packages/gmail`: `client.ts` factory,
  `schemas.ts` zod, `types.ts` derived). If more Google services appear,
  extract a shared `packages/google-auth` rather than duplicating OAuth.
- **Testing:** keep the pure `GoogleTask JSON → Task` mapper separate from the
  HTTP client and unit-test it (like `parseBridgeOutput`); cover the client
  with msw via a `.e2e.test.ts` (like the gmail/ynab e2e tests). Mind the
  coverage thresholds (80/80/80/75 in `vitest.config.ts`).
- **List filtering:** `TASK_LISTS` matches list *names*. Apple lists are names;
  Google task lists have ids + titles, so resolve titles → ids (or filter by
  title) inside the Google source. The neutral `Task.list` stays a display name.

## 3. The non-macOS host move (bigger lift, not yet started)

These are still Apple/macOS-coupled and out of the current seam's scope:

- **Scheduling.** `launchd/` + `apps/stalled-tasks/src/schedule.ts` +
  `generate-launchd-plist.ts` are macOS-only. Given this repo already runs CI
  and Claude Code on the web, a **scheduled GitHub Actions workflow** is likely
  the cleanest cross-platform scheduler (cron expression, secrets in GitHub, no
  host to own). `STALLED_TASKS_SCHEDULE` would translate to a cron string.
- **Failure notifications.** The `osascript display notification` calls in
  `launchd/run.sh` and `run-stalled-tasks.sh` have no Google equivalent. Route
  failures through email (the existing `notify` app already emails), Slack, or
  a dead-man's-switch like healthchecks.io.
- **Ephemeral filesystem.** `apps/*/audit/`, `runs/`, and the `find -mtime
  +90` cleanup in `run.sh` all assume persistent local disk. In a container/CI
  runner they vanish between runs — which also breaks the "seed `created` from
  earliest run" option in §1 unless `runs/` is persisted somewhere durable
  (object storage, a committed data branch, etc.).
- **Lockfiles.** The `$TMPDIR` PID locks (`*.lock`) assume one long-lived host;
  on cloud they're either irrelevant or need a different concurrency guard.

## 4. Decommissioning Apple

Once Google works on the new host, `tasks/apple/`, the Swift bridge, and all of
`launchd/` become dead weight. The seam means they can be deleted wholesale, or
`apple` kept as a macOS-only option. No big-bang required.

## Suggested order

1. `packages/google-tasks` client + schemas + tests (no app wiring yet).
2. `tasks/google/source.ts` mapping into `Task`; decide §1 here.
3. Flip `TASK_PROVIDER=google` on a Mac to validate end-to-end.
4. Replace scheduling + notifications for the target host (§3).
5. Remove the Apple path (§4) if no longer needed.
