# enrich-memos plan

Reads Amazon receipt emails from Gmail and PATCHes the parsed product list into
the `memo` field of matching YNAB transactions, so when `categorize` runs after
it has real item names to reason from instead of an empty memo.

Runs **before** `categorize` in `launchd/run.sh`'s `APPS` array, using the same
shared packages, same `.env`, and the same audit dir.

Shape borrowed from a community n8n workflow: fetch transactions, filter to
empty-memo Amazon rows, query Gmail for receipts within a ± window of the
transaction date, hand the emails to an LLM, PATCH the memo. Differences are
called out inline below.

## Eligibility rules

Enrich a transaction only if **all** of these hold:

1. `payee_name === 'Amazon'`
2. `account_id` is in `ALLOWED_ACCOUNT_IDS`
3. Not a transfer (`transfer_account_id` and `transfer_transaction_id` both
   null)
4. `flag_name !== 'auto-categorized'` — categorize has already run; overwriting
   its memo would erase the data the LLM saw and break the audit trail
5. `memo` is empty OR does **not** start with `auto-gen:`

Rule 5 is the manual-override knob. Every generated memo starts with
`auto-gen:` (followed by a space) so you can see in YNAB which memos came
from this job. To force a regeneration, edit the memo in YNAB and drop the
prefix — the next run sees a non-prefixed memo (or empty) and re-enriches.
To pin a memo against re-runs, leave the prefix in.

This replaces the n8n workflow's hardcoded `No valid purchase information
found.` marker — same idea (a sentinel that prevents an LLM call loop), more
useful in practice.

## Pipeline

1. Load transactions for each allowed account, `since ENRICH_LOOKBACK_DAYS` ago.
2. Apply the eligibility filter.
3. For each eligible transaction (concurrency >1 — Gmail + Anthropic are
   independent calls so this fans out cleanly):
   1. Query Gmail for messages from Amazon within ± `GMAIL_RECEIPT_WINDOW_DAYS`
      of the transaction date, optionally narrowed by amount.
   2. **No messages** → leave memo unchanged, audit row with status
      `no_emails`. We do **not** write a "no info found" marker. The n8n
      workflow does, to prevent re-runs; we rely on the date-window expiring
      instead so receipts that arrive late still get picked up.
   3. **Messages found** → send messages + transaction info to the Anthropic
      API (same `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` as `categorize`).
      Prompt asks for a single line of `Item1 ($X), Item2 ($Y) — Total $TOTAL`,
      or the sentinel `__NO_RECEIPT__` if no valid receipt could be identified.
      Use `messages.parse()` with a Zod schema covering both shapes.
   4. **Model returns the sentinel or fails to parse** → leave memo unchanged,
      audit row with status `no_receipt`.
   5. **Otherwise** → sanitize (strip newlines/quotes/control chars), prepend
      `auto-gen:` plus a space, clamp to 499 chars, queue for PATCH.
4. Bulk PATCH in batches of 10 (same as `categorize`).

## Module layout

```text
apps/enrich-memos/
  src/
    index.ts          # entrypoint + CLI args (--dry-run, --verbose, --lookback-days), lockfile
    config.ts         # zod-validated loadConfig
    constants.ts      # MEMO_PREFIX, ENRICH_CONCURRENCY, GMAIL_RECEIPT_WINDOW_DAYS, batch sizes
    enrich.ts         # runEnrich({ config, opts }) — the pipeline above + tests
    gmail/
      client.ts       # factory wrapping googleapis Gmail API
      schemas.ts      # zod schemas for the Gmail fields we care about
      auth.ts         # OAuth2 client built from refresh token in env
    anthropic/
      prompts.ts      # user-message builder + sanitizer + tests
      schemas.ts      # zod for the LLM response (item line or __NO_RECEIPT__ sentinel)
```

The Anthropic client at `apps/categorize/src/anthropic/client.ts` needs to
move into a shared package so both apps can use the same factory — see open
question 2 below for the location decision.

## Configuration additions

In `.env.example` (all required, none have defaults):

```bash
# --- Enrich-memos ---
ENRICH_LOOKBACK_DAYS=5
GMAIL_RECEIPT_WINDOW_DAYS=5
GMAIL_FROM_FILTER=auto-confirm@amazon.com,shipment-tracking@amazon.com
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REFRESH_TOKEN=
```

Reusing `YNAB_TOKEN`, `YNAB_BUDGET_ID`, `ALLOWED_ACCOUNT_IDS`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and `AUDIT_DIR` from `categorize`.
Each app's `loadConfig` parses its own subset.

## Shared-package contracts this app relies on

- `packages/common/src/logger.ts` — `createLogger` takes a required `name`
  param and writes to `${name}-YYYY-MM-DD.jsonl`. This app passes
  `name: 'enrich-memos'`.
- `packages/ynab/src/schemas.ts` — `transactionSchema` exposes `date:
  z.string()`, needed for the receipt-matching window.

## Open questions

1. **Receipt matching when multiple receipts share an amount.** First pass:
   hand all candidates within the date window to the LLM and let the system
   prompt pick the right one (this is what the n8n workflow does). If
   accuracy is poor in practice, pre-filter by Amazon order id or by
   tightest-date-match before LLM call.
2. **Where to put the shared Anthropic client.** Options: standalone
   `packages/anthropic/` (mirrors `packages/ynab/`) or
   `packages/common/src/anthropic/`. Leaning standalone since it has its own
   schemas and an external dependency, but happy to nest under `common/` if
   that's the prevailing pattern.
3. **`launchd/run.sh` audit log cleanup.** Currently `find … -name
   'categorize-*.jsonl' -mtime +90 -delete`. Widen to `*.jsonl` so this app's
   audits also rotate. Trivial follow-up in the launchd commit; not blocking
   enrich-memos work.

## Done when

- Eligible empty-memo Amazon transactions get a memo prefixed `auto-gen:`.
- `categorize` runs after and sees the populated memo in its prompt.
- Audit log has one row per attempt with `app: 'enrich-memos'`,
  `status` of `ok`, `no_emails`, `no_receipt`, or `error`, and
  `patch_status` of `success`, `error`, `skipped_for_dry_run`, or
  `skipped_for_upstream_error`. The schema lives in this app — spread
  `baseAuditFields` from `@ynab-automation/common/logger` into a local
  `enrichMemosAuditSchema` and pass it to `createLogger({ auditSchema })`.
- Unit tests cover the eligibility filter (incl. the `auto-gen:` prefix
  branches), the memo sanitizer, and the prompt builder. e2e test uses msw to
  mock both Gmail and YNAB.
- `launchd/run.sh` has `enrich-memos` uncommented before `categorize` in
  `APPS`, and the audit-log find pattern is widened.
