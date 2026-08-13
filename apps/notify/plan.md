# notify plan

Sends an email digest after `launchd/run.sh` finishes if today's audit logs
contain any per-row errors. The existing `osascript` "tail -3 of stderr"
notification still fires on any non-zero exit and acts as the floor if notify
itself can't send.

Runs **after** every app in `launchd/run.sh`'s `APPS` loop. Reads the JSONL
audit files those apps just wrote and groups by `patch_status`.

## Trigger rules

Audit-log content is the only signal. Notify runs unconditionally from the
launchd wrapper; the wrapper does not pre-gate on exit codes.

Send an email if today's audit rows across all apps contain any of:

- `patch_status: 'error'`
- `patch_status: 'skipped_for_upstream_error'`

(Both are real failures; see [packages/common/src/logger.ts:16-26](../../packages/common/src/logger.ts#L16-L26).
`skipped_for_dry_run` is not a failure and is ignored.)

This also naturally handles the lock-held case
([apps/ynab-categorize/src/index.ts:56](../../apps/ynab-categorize/src/index.ts#L56)
exits 2 before writing any audit rows), so notify produces nothing for
overlap-skipped apps without explicit gating.

No suppression for repeat failures. One email per day, even repeated, keeps
unresolved errors visible.

## Pipeline

1. Resolve the project root the same way `loadRootEnv` does
   ([packages/common/src/env.ts:11](../../packages/common/src/env.ts#L11),
   three levels up from `import.meta.url`). Glob
   `<root>/apps/*/audit/*-${YYYY-MM-DD}.jsonl` (today, local date, the same
   scheme as `createLogger`). **Don't** consult notify's own `AUDIT_DIR`;
   `AUDIT_DIR=audit` is relative and resolves per-package via `cwd`, so
   each app writes under `apps/<app>/audit/` while notify's resolution would
   point at the wrong dir.
2. Derive each file's app name by stripping `-${YYYY-MM-DD}.jsonl` from the
   filename. (`baseAuditSchema` does not declare an `app` field: each app
   adds its own `app: z.literal(...)`, so the filename is the only
   schema-agnostic source.) Skip any file where the derived app name is
   `notify` (defensive: notify isn't supposed to write audits, but don't
   self-feed if some future change adds them).
3. Parse each line with `baseAuditSchema` from
   `@personal-automation/common/logger`. Notify is schema-agnostic across apps:
   per-app fields (`app`, `status`, etc.) are read as untyped extras. Adding
   a new app must not require an edit to notify.
4. Bucket rows by `patch_status` for each app:
   - errors = `error` + `skipped_for_upstream_error`
   - successes = `success`
   - skipped = `skipped_for_dry_run` (excluded from both counts)
5. If zero error rows across all apps, exit 0 without sending.
6. Otherwise build the email and send via `packages/gmail/`.

## Email shape

**Subject**: `Personal Automation: N errors`. Varying N lets the inbox preview
convey load without opening. Don't include the date, since Gmail shows it
already. Gmail threads consecutive emails by the matching subject prefix.

**Body** (plain text, no HTML): one section per app that ran today, each
showing its error / success counts and one block per failed row. Blank lines
between rows for breathing room.

```text
ynab-categorize: 3 errors, 47 successes
═══════════════════════════════════

  Transaction abc123
    Payee:   Amazon
    Amount:  -$42.10
    Status:  error
    Reason:  rate_limit_error: 429 from anthropic

  Transaction def456
    Payee:   Costco
    Amount:  -$118.00
    Status:  skipped_for_upstream_error
    Reason:  AnthropicError: timeout after 30000ms


ynab-enrich-memos: 1 error, 11 successes
════════════════════════════════════

  Transaction ghi789
    Payee:   Amazon
    Amount:  -$23.45
    Status:  error
    Reason:  YnabApiError: 409 Conflict
```

The `Amount` column uses `formatDollars` from
`@personal-automation/ynab/milliunits`, the same helper ynab-categorize already uses for
its logs.

Counts:

- **errors** = rows with `patch_status` of `error` or
  `skipped_for_upstream_error`
- **successes** = rows with `patch_status: 'success'`
- `patch_status: 'skipped_for_dry_run'` rows are excluded from both
  counts. (Dry runs are an explicit user action; if errors show up in a dry
  run, notify still runs but the success-vs-error counts shouldn't be
  diluted by skipped rows.)

Quote the `Reason` string verbatim. No truncation: these are personal-account
emails, not paged ops. If an app produced zero error rows but is present in
the audit dir for today, include its `0 errors, N successes` section as
positive confirmation that it ran.

## Module layout

```text
apps/notify/
  package.json        # { "scripts": { "notify": "tsx src/index.ts" } } so
                      # `pnpm --filter @personal-automation/notify notify` works
  src/
    index.ts          # CLI entrypoint (no args; reads audit dir from env)
    config.ts         # zod-validated loadConfig
    constants.ts      # SUBJECT_PREFIX
    notify.ts         # runNotify({ config, today }): the pipeline above + tests
    digest.ts         # buildDigest(rows), pure: rows → { subject, body } + tests
```

No `gmail/` subdir: the shared package owns the client.

## Shared package: `packages/gmail/`

Create alongside `packages/ynab/`. Mirrors that shape: factory function
`createGmailClient`, zod schemas, derived types.

```text
packages/gmail/
  src/
    client.ts         # createGmailClient({ auth }) → { sendMessage, listMessages, getMessage }
    schemas.ts        # zod for Gmail responses we care about
    types.ts          # z.infer aliases
    auth.ts           # OAuth2 client from refresh token (env-driven)
    constants.ts      # GMAIL_API_BASE_URL
    bootstrap.ts      # one-time refresh-token helper (see below)
```

`sendMessage({ to, subject, body })` is all notify needs, and notify ships
**before** ynab-enrich-memos, so the initial `packages/gmail/` commit lands
`createGmailClient`, `auth.ts`, schemas/types for send, and `sendMessage`.
`listMessages` / `getMessage` are added later when ynab-enrich-memos is built.

**OAuth scopes**: `gmail.send` (notify) and `gmail.readonly` (ynab-enrich-memos).
The same refresh token covers both if consented to up front. The bootstrap
helper requests both scopes during the consent flow so ynab-enrich-memos doesn't
need a second round.

`sendMessage` wraps its HTTP call in `withRetry` from
`@personal-automation/common/retry`. The Gmail send endpoint can return transient
5xx; retrying matches how the YNAB and Anthropic clients already handle
outbound HTTP.

**MIME encoding (impl note for `sendMessage`)**: the Gmail API
`users.messages.send` endpoint expects a base64url-encoded RFC 5322 message
in the `raw` field. The message body must declare
`Content-Type: text/plain; charset=utf-8` so the digest's `═` and `─` chars
render correctly. Wrong content-type = garbled output.

### Bootstrap helper

One-time script to get the initial `GMAIL_OAUTH_REFRESH_TOKEN`. Runs locally
on the user's machine, asks Google for permission, prints the token to
paste into `.env`. Triggered via:

```bash
pnpm --filter @personal-automation/gmail bootstrap
```

`packages/gmail/src/bootstrap.ts` does:

1. Read `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` from `.env`.
2. Start a one-shot HTTP server on `http://localhost:53682` (or any free
   port; matches the `redirect_uris` registered with the GCP OAuth client;
   `http://localhost` accepts any port).
3. Open the Google consent URL in the default browser
   (`open` on macOS) with scopes `gmail.send` + `gmail.readonly` and
   `access_type=offline` + `prompt=consent` (the latter forces Google to
   re-issue a refresh token even if the user has consented before).
4. Capture the `code` query param from Google's redirect.
5. POST to `https://oauth2.googleapis.com/token` exchanging
   `code` → `{ access_token, refresh_token }`.
6. Print the `refresh_token` to stdout with an instruction: paste this into
   `.env` as `GMAIL_OAUTH_REFRESH_TOKEN`.
7. Shut down the HTTP server, exit 0.

Plain HTTP server (`node:http`) and `fetch` are enough, with no `googleapis`
package needed for the bootstrap. README setup section documents the
sequence and the `redirect_uris` value the GCP console must have
(`http://localhost`).

## Configuration additions

In `.env.example` (all required, no defaults):

```bash
# --- Notify ---
NOTIFY_TO_EMAIL=

# --- Gmail (shared by notify and ynab-enrich-memos) ---
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REFRESH_TOKEN=
```

The Gmail vars are the same three ynab-enrich-memos will use, defined in one place
so both apps load from the same source. ynab-enrich-memos's plan already lists
them; they move to a shared block when notify lands first.

Reuses `AUDIT_DIR` from the existing config. Notify's `loadConfig` parses
exactly the vars above plus `AUDIT_DIR`.

## `launchd/run.sh` changes

Append after the `for app in APPS` loop, before the `find … -delete`
cleanup:

```bash
# Always invoke notify. It reads today's audit logs and decides whether to
# send. `|| true` so a notify failure doesn't poison $overall_exit.
/bin/zsh -lc "pnpm --filter @personal-automation/notify notify" || true
```

- No exit-code gating. `$overall_exit` is the *last* non-zero app exit
  ([launchd/run.sh:24](../../launchd/run.sh#L24)), so if app A exits 1 and
  app B exits 2 in the same run, gating on `-eq 1` would mask A's real
  failures. Audit-log content is the source of truth instead. Lock-held
  apps wrote no audit rows so notify naturally produces nothing for them.
- The existing `osascript` notification stays as-is. It still fires for any
  non-zero exit and is the floor for "notify itself failed to send."

Also widen the audit-log cleanup `find` from `ynab-categorize-*.jsonl` to
`*.jsonl` so notify's read targets are also rotated. (This is the same change
ynab-enrich-memos's plan calls out as open question 3: single line, lands here.)

## Shared-package contracts notify relies on

- `packages/common/src/logger.ts`: `baseAuditSchema` exposes the fields
  notify reads: `patch_status`, `transaction_id`, `payee_name`,
  `amount_dollars`, `error`. Notify does **not** reach into per-app
  `status` fields; the base is enough for the digest.
- `packages/gmail/src/client.ts`: `sendMessage({ to, subject, body })`
  returns void on success, throws on transport / API failure. Errors extend
  `AppError` so they format the same way as the rest of the codebase.

Notify does not write an audit log of its own, so it does **not** call
`createLogger` (which requires an `auditSchema`). It uses `pino` directly for
the two or three lines of stdout/stderr it produces: "sent digest to X",
"no errors today, skipping send", "Gmail send failed: ...".

## Failure modes and edge cases

- **Notify can't reach Gmail.** Bubbles up as a non-zero exit from notify,
  swallowed by `|| true` in the wrapper. The `osascript` notification from
  the original app failure still fires. Acceptable; the email is best-effort.
- **Refresh token expired.** Same as above. The README should call out that a
  Gmail-API outage looks like a silent missing email, so check `osascript`
  notifications as the source of truth.
- **Audit JSONL missing.** App didn't run today, crashed before writing, or
  exited 2 on lock collision. Notify treats a missing file as zero rows for
  that app, that app's section is omitted from the email.
- **Audit JSONL malformed line.** `baseAuditSchema.safeParse` per line; on
  failure, log a `warn` to stderr and skip the line. Don't fail the whole
  digest because one row is bad.
- **`status: 'fallback'` rows** ([apps/ynab-categorize/src/ynab-categorize.ts:33](../../apps/ynab-categorize/src/ynab-categorize.ts#L33))
  are a soft warning from ynab-categorize (default category used because no good
  match). They land with `patch_status: 'success'`, so notify counts them as
  successes. Not an error condition. Per-app `status` fields are not
  consulted by notify: the email reflects PATCH outcomes only.
- **Day-boundary spillover.** If a run starts at 23:58 and writes audit rows
  after midnight, today's rows split across two date-named files. Notify
  reads only today's local date, so late-write rows from yesterday's run
  would be missed. Acceptable in v1: runs take well under a minute and the
  daily launchd schedule is set well clear of midnight. If this changes,
  pass the run's start date to notify as a CLI arg.
- **Mixed dry-run + scheduled rows in the same date file.** If a user runs
  `pnpm --filter @personal-automation/ynab-categorize test:ynab-categorize` interactively earlier in the day and the
  daily launchd run follows, today's file contains both. `patch_status` is
  the only signal, so `skipped_for_dry_run` rows are excluded and counts
  remain correct. (Note: notify is invoked only by `launchd/run.sh`, not by
  manual `pnpm` invocations.)

## Monorepo wiring

This work adds two new workspace members (`packages/gmail/`, `apps/notify/`).
The TypeScript project-reference graph needs updating in three places:

- **Root [tsconfig.json](../../tsconfig.json)**: add both new packages to
  `references`.
- **`packages/gmail/tsconfig.json`**: new file, no internal references
  (Gmail package depends only on third-party + node built-ins).
- **`apps/notify/tsconfig.json`**: new file, references
  `../../packages/common` and `../../packages/gmail`.
- **`apps/notify/package.json`**: declares `workspace:*` deps on `common`
  and `gmail`, plus the `notify` and `test` scripts.
- **`packages/gmail/package.json`**: declares the `bootstrap` script
  pointing at `tsx src/bootstrap.ts`.

After the additions, `pnpm typecheck` (which runs `tsc -b`) must succeed
from a clean state.

Coverage thresholds from the root [vitest.config.ts](../../vitest.config.ts)
(80/80/80/75) apply to the new code:

- `digest.ts` is the highest-leverage test target (pure, deterministic input
  → output). Aim for full coverage there.
- `notify.ts` needs an e2e-style test that fakes the audit-log filesystem
  reads (tmp dir with sample JSONL files) and mocks Gmail send via msw.
- `packages/gmail/`'s `sendMessage` needs msw coverage of the send endpoint
  and the OAuth token-refresh endpoint
  (`https://oauth2.googleapis.com/token`).
- `bootstrap.ts` is one-time interactive infra, so exclude it from coverage
  (add to vitest config's coverage `exclude` glob) rather than chase
  contrived tests for it.

## Done when

- A run with at least one `patch_status: 'error'` row generates a single
  email to `NOTIFY_TO_EMAIL` with one section per failing app.
- A clean run (no error rows) sends no email.
- A run that exits 2 (lock held) sends no email; the `osascript` floor
  notification still fires.
- `packages/gmail/` exists with `createGmailClient` and `sendMessage`.
- `apps/notify/` has unit tests for `digest.ts` (rows → subject/body) and an
  e2e test using msw to mock Gmail send. `packages/gmail/` has msw coverage
  of the send and token-refresh endpoints. No live API calls in CI.
- `pnpm typecheck`, `pnpm check`, and `pnpm test` all pass from a clean
  state. Coverage stays at or above the root thresholds.
- `pnpm --filter @personal-automation/gmail bootstrap` walks the user through
  the consent flow and prints a working `GMAIL_OAUTH_REFRESH_TOKEN`.
- `.env.example` lists the new vars under a `--- Notify ---` and
  `--- Gmail ---` block.
- `launchd/run.sh` invokes notify on exit 1, leaves exit 2 alone, and the
  audit-log cleanup glob is widened to `*.jsonl`.
- README setup section documents the OAuth scopes (`gmail.send` plus
  `gmail.readonly` for later ynab-enrich-memos use).
