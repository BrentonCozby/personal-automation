# notify plan

Sends an email digest after `launchd/run.sh` finishes, whenever today's audit
logs show the run did something: any row applied, or any row failed. The
`osascript` "tail -3 of stderr" notification
fires on any non-zero exit, so a run still surfaces a failure when notify itself
cannot send.

Runs **after** every app in `launchd/run.sh`'s `APPS` loop. Reads the JSONL
audit files those apps just wrote and groups them by `outcome`.

> Status: **implemented.** This file is the design doc; the code under `src/` is
> the source of truth. Update both together.

## Trigger rules

Audit-log content is the only signal. Notify runs unconditionally from the
launchd wrapper; the wrapper does not pre-gate on exit codes.

The shared `outcome` field on every audit row decides everything, and
[packages/common/src/logger.ts:16-37](../../packages/common/src/logger.ts#L16-L37)
is where the writer and this reader agree on it:

| `outcome` | Digest treatment |
|---|---|
| `applied` | a success |
| `failed` | an error: the write was attempted and failed |
| `failed_upstream` | an error: something threw before the write, so none was attempted |
| `skipped_for_dry_run` | neither |
| `skipped_for_no_match` | neither |

Send an email whenever the run did something, meaning at least one `applied`,
`failed` or `failed_upstream` row across all apps. A digest that arrives on a
clean day is the point: it doubles as the daily confirmation that
categorization and memo-enrichment still work. Skip only when nothing was
applied and nothing failed, which means an empty run or one that was all skips.

This also handles the lock-held case without explicit gating: a second run
exits 2 from the shared `runCli`
([packages/common/src/cli.ts:20-22](../../packages/common/src/cli.ts#L20-L22))
before writing any audit rows, so notify sees nothing for that app.

No suppression for repeat failures. One email per day, even repeated, keeps
unresolved errors visible.

## Pipeline

1. List `apps/` for its directory names, then build each one's audit path from
   `AUDIT_DIR_NAME` + `auditFileName` in
   `@personal-automation/common/audit-path`: `apps/<app>/audit/<app>-<today>.jsonl`,
   today in the local date. That shared module is what keeps the writer and this
   reader from drifting, and it is why the path is never resolved from notify's
   own working directory.
2. The directory name is the app name. (`baseAuditSchema` declares no `app`
   field: each app adds its own `app: z.literal(...)`, so the layout is the only
   schema-agnostic source.) Skip `notify` itself, so a future change that gave it
   an audit log could not make it self-feed.
3. Parse each line with `baseAuditSchema` from
   `@personal-automation/common/logger`. Notify is schema-agnostic across apps:
   per-app fields (`app`, `status`, etc.) are read as untyped extras. Adding
   a new app must not require an edit to notify.
4. Bucket rows by `outcome` per app, the way the trigger rules above split them:
   errors, successes, and the two skips in neither.
5. If both counts are zero across all apps, exit 0 without sending.
6. Otherwise build the email and send via `packages/gmail/`.

## Email shape

**Subject**: `Personal Automation: N errors`. Varying N lets the inbox preview
convey load without opening. Don't include the date, since Gmail shows it
already. Gmail threads consecutive emails by the matching subject prefix.

**Body**: multipart. One `buildDigest` call produces a plain-text part and an
HTML part, and `sendMessage` sends both. Clients that render HTML get the card
layout; anything else falls back to the text. One section per app, alphabetical
so the email reads the same day to day, each with its error and success counts,
then its error rows, then its success rows.

An error row carries the transaction id, date, payee, amount, `outcome` and the
error string. A success row is one to three lines: payee, amount and date, then
the `memo` the decision read, then `result_summary`, which is the category name
for ynab-categorize and the written memo for ynab-enrich-memos.

```text
ynab-categorize: 1 error, 2 successes
═════════════════════════════════════

  Transaction abc123
    Date:    Aug 12, 2026
    Payee:   Amazon
    Amount:  -$42.10
    Outcome: failed_upstream
    Reason:  rate_limit_error: 429 from anthropic

  Successes:
    Amazon  -$23.45  Aug 12, 2026
      memo: auto-gen: AA batteries, USB-C cable
      →  Household Goods

ynab-enrich-memos: 0 errors, 11 successes
═════════════════════════════════════════
```

Three shapes deviate from that:

- **A run that dies before processing anything** writes one row under the
  reserved transaction id `RUN_ABORTED_SENTINEL` (`<run-aborted>`), which the
  digest renders as a `RUN ABORTED` block carrying only the reason.
- **Apps in `SUMMARY_ONLY_SUCCESS_APPS`** (`ynab-enrich-memos` today) keep their
  success count in the section header but drop the per-transaction success rows,
  because the transactions they enrich are already listed under ynab-categorize.
  Their errors always show in full, which is why the section above has a header
  and nothing under it.
- **An app whose rows are all skips** still gets a section, reading
  `(nothing to report)`, so the digest says what ran rather than only what broke.

Quote the `Reason` string verbatim. No truncation: these are personal-account
emails, not paged ops.

`amount_dollars` is already in dollars, while `formatDollars` in
`@personal-automation/ynab/milliunits` takes milliunits, so `digest.ts` formats
the amount inline rather than multiplying by 1000 to reuse that helper.

## Module layout

```text
apps/notify/
  package.json        # { "scripts": { "notify": "tsx src/index.ts" } } so
                      # `pnpm --filter @personal-automation/notify notify` works
  src/
    index.ts          # CLI entrypoint, no args
    config.ts
    constants.ts      # SUBJECT_PREFIX, SELF_APP_NAME, SUMMARY_ONLY_SUCCESS_APPS
    notify.ts         # runNotify({ config, today }): the pipeline above
    digest.ts         # buildDigest(rows), pure: rows → { subject, body }
```

No `gmail/` subdir: the shared package owns the client.

## Shared package: `packages/gmail/`

Mirrors `packages/ynab/`: factory function `createGmailClient`, zod schemas,
derived types.

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

`sendMessage({ to, subject, body })` is all notify needs; `listMessages` and
`getMessage` are there for ynab-enrich-memos.

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
`Content-Type: text/plain; charset=utf-8`, or the digest's `═` and `─` chars
arrive as the wrong characters.

### Bootstrap helper

`packages/gmail/src/bootstrap.ts` mints the initial
`GMAIL_OAUTH_REFRESH_TOKEN`: it runs a one-shot `node:http` server for the
redirect, opens the Google consent URL, exchanges the `code`, and prints the
token to paste into the root `.env`.

```bash
pnpm --filter @personal-automation/gmail bootstrap
```

Two things about the consent URL are not obvious from the code:

- `prompt=consent` (with `access_type=offline`) is what forces Google to
  re-issue a refresh token even for a user who has consented before. Without
  it a repeat run prints nothing usable.
- The GCP OAuth client registers `http://localhost` as its redirect URI, which
  accepts any port, so the local server does not need a fixed one.

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

The three Gmail vars sit in the root `.env` because ynab-enrich-memos uses the
same ones, so both apps load them from a single source.

## `launchd/run.sh`

Notify is invoked after the `for app in APPS` loop, before the `find … -delete`
cleanup:

```bash
/bin/zsh -lc "pnpm --filter @personal-automation/notify notify" || true
```

The comment above that line in `run.sh` carries the reasoning: `|| true` keeps a
notify failure out of `$overall_exit`, and there is no exit-code gating because
`$overall_exit` holds only the *last* non-zero app exit, so gating on any one
value would mask an earlier app's failure.

The cleanup `find` below it matches `*.jsonl`, not just `ynab-categorize-*.jsonl`,
so notify's read targets rotate too.

## Shared-package contracts notify relies on

- `packages/common/src/logger.ts`: `baseAuditSchema` exposes the fields
  notify reads: `outcome`, `transaction_id`, `payee_name`, `amount_dollars`,
  `memo`, `transaction_date`, `result_summary` and `error`, plus the
  `RUN_ABORTED_SENTINEL` id. Notify does **not** reach into per-app `status`
  fields; the base is enough for the digest.
- `packages/gmail/src/client.ts`: `sendMessage({ to, subject, body, html })`
  resolves to the sent message (notify reads its `id` for the log line) and
  throws on transport or API failure. `body` is the plain-text part and becomes
  the fallback when `html` is also given. Errors extend `AppError` so they
  format the same way as the rest of the codebase.

Notify does not write an audit log of its own, so it does **not** call
`createLogger` (which requires an `auditSchema`). It uses `pino` directly for
the two or three lines of stdout/stderr it produces: "Digest sent.", "No
activity in today's audit logs; skipping email.", and a Gmail send failure.

## Failure modes and edge cases

- **Notify can't reach Gmail, or the refresh token expired.** Bubbles up as a
  non-zero exit from notify, swallowed by `|| true` in the wrapper. The email is
  best-effort, so this looks exactly like a silent missing email: the `osascript`
  notification from the original app failure is the signal to trust.
- **Audit JSONL missing.** App didn't run today, crashed before writing, or
  exited 2 on lock collision. Notify treats a missing file as zero rows for
  that app, that app's section is omitted from the email.
- **Audit JSONL malformed line.** `baseAuditSchema.safeParse` per line; on
  failure, log a `warn` to stderr and skip the line. Don't fail the whole
  digest because one row is bad.
- **`status: 'fallback'` rows** ([apps/ynab-categorize/src/categorize.ts:34](../../apps/ynab-categorize/src/categorize.ts#L34))
  are a soft warning from ynab-categorize (default category used because no good
  match). They land with `outcome: 'applied'`, so notify counts them as
  successes. Not an error condition. Per-app `status` fields are not
  consulted by notify: the email reflects PATCH outcomes only.
- **Day-boundary spillover.** If a run starts at 23:58 and writes audit rows
  after midnight, today's rows split across two date-named files. Notify
  reads only today's local date, so late-write rows from yesterday's run
  would be missed. Accepted: runs take well under a minute and the daily
  launchd schedule sits well clear of midnight. If either changes, pass the
  run's start date to notify as a CLI arg.
- **Mixed dry-run + scheduled rows in the same date file.** If a user runs
  `pnpm --filter @personal-automation/ynab-categorize test:ynab-categorize` interactively earlier in the day and the
  daily launchd run follows, today's file contains both. `outcome` is the only
  signal, so `skipped_for_dry_run` rows fall in neither bucket and the counts
  stay right. (Note: notify is invoked only by `launchd/run.sh`, not by
  manual `pnpm` invocations.)

## Testing

`bootstrap.ts` is one-time interactive infra, so it sits in the root
[vitest.config.ts](../../vitest.config.ts) coverage `exclude` glob rather than
carrying contrived tests. Everything else meets the 80/80/80/75 thresholds, and
no test reaches a live API: `notify.ts`'s end-to-end test writes sample JSONL
into a tmp dir and mocks Gmail send with msw, and `packages/gmail` mocks both
the send and the OAuth token-refresh endpoints.
