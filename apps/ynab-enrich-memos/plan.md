# ynab-enrich-memos

Reads Amazon receipt emails from Gmail and PATCHes the parsed product list into the `memo`
field of matching YNAB transactions, so when `ynab-categorize` runs after it, it has real item
names to reason from instead of an empty memo.

Runs **before** `ynab-categorize` in `launchd/run.sh`'s `APPS` array, using the same shared
packages and the same monorepo-root secrets.

Shape borrowed from a community n8n workflow: fetch transactions, filter to empty-memo Amazon
rows, query Gmail for receipts within a ± window of the transaction date, hand the emails to an
LLM, PATCH the memo.

> Status: **implemented.** This file is the design doc; the code under `src/` is the source of
> truth. Update both together.

## Eligibility rules

Enrich a transaction only if **all** of these hold (see `isEligible` in `enrich.ts`):

1. `payee_name === 'Amazon'`
2. `account_id` is in `ALLOWED_ACCOUNT_IDS`
3. Not a transfer (`transfer_account_id` and `transfer_transaction_id` both null)
4. `memo` is empty (null, blank, or whitespace-only).

Empty-only is the key rule. A non-empty memo is **never** touched, whether it's a note you
typed or this job's own output, so a manual annotation can't be clobbered. It also subsumes the
old "already-categorized" guard: `ynab-categorize` runs *after* us and never writes the memo, so
the only memo it ever reasons from is one we wrote (or the empty one). There's no `flag_name`
check to maintain.

Every generated memo starts with `auto-gen:` (plus a space) so you can see in YNAB which memos
came from this job. The prefix is a visual marker only: to regenerate a memo, **clear it**
in YNAB and the next run re-enriches it. It takes the place of the n8n workflow's hardcoded
`No valid purchase information found.` marker, which was the same idea (a sentinel that prevents an
LLM-call loop) and less useful in practice.

## Pipeline (`runEnrich` in `enrich.ts`)

1. Load transactions for each allowed account, `since ENRICH_LOOKBACK_DAYS` ago.
2. Apply the eligibility filter.
3. For each eligible transaction (`ENRICH_CONCURRENCY` at a time, since the Gmail and Anthropic
   calls for one transaction do not depend on any other transaction's):
   1. Query Gmail (`buildReceiptQuery`) for messages from any `GMAIL_FROM_FILTER` sender within
      ± `GMAIL_RECEIPT_WINDOW_DAYS` of the transaction date, newest first, capped at
      `MAX_EMAILS_PER_TXN`; see "Candidate cap".
   2. **No messages** → leave memo unchanged, audit row `status: 'no_emails'`. We do **not**
      write a "no info found" marker. The n8n workflow does, to prevent re-runs; we rely on the
      date window expiring instead, so receipts that arrive late still get picked up.
   3. **Messages found** → fetch each (`getMessage` decodes the MIME tree to text), then drop any
      that fail DMARC (`isAuthentic` in `trust.ts`; see "Sender authenticity"). If none survive,
      treat it as `no_emails`.
   4. Build the prompt (`buildEnrichPrompt`) from the surviving emails and call the Anthropic API
      via the shared client using `messages.parse()` with `receiptResponseSchema`; see
      "Amount matching".
   5. **`receipt_found: false`, an empty summary, or an unverifiable amount** → leave memo
      unchanged, audit row `status: 'no_receipt'`.
   6. **Otherwise** → `buildMemo` sanitizes (collapse whitespace, strip wrapping quotes),
      prepends the `auto-gen:` marker and a space, clamps to `MAX_MEMO_LENGTH` (500, YNAB's
      limit), and queues a memo-only PATCH.
4. Bulk PATCH in batches of `PATCH_BATCH_SIZE` (10, same as ynab-categorize).

The patch sets **only** `memo` (no flag), leaving the row un-flagged so ynab-categorize still
treats it as un-categorized and runs on it next.

### LLM output: structured, not a string sentinel

The original plan asked the model for a single line or a `__NO_RECEIPT__` string sentinel.
Because the shared client uses structured outputs (`output_config.format`), the response is a
typed object instead, matching how ynab-categorize and tasks already work:

```ts
{ receipt_found: boolean; item_summary: string | null; order_total: number | null }
```

`receipt_found: false` (or a blank `item_summary`) is the "no receipt" signal; the wrapper in
`anthropic/client.ts` collapses both to `summary: null`. `order_total` is a separate field so the
caller can verify the amount in code.

### Amount matching

The charge amount is the reliable key (Amazon's order total equals the charge to the cent), so
matching keys on it: the prompt tells the model to find the order whose total **equals** the
charge and to never settle for the closest one, and to return that order's `order_total`. Then
`enrich.ts` verifies it deterministically: if `order_total` is missing or differs from the
charge by more than `ORDER_TOTAL_TOLERANCE_DOLLARS`, the match is rejected as `no_receipt`. This
**fails closed**: an unverifiable match is dropped, so a wrong-amount memo can't be written no
matter what the model returns. It exists because a wrong-amount memo was written once, for the
reason in "Candidate cap".

### Sender authenticity

The Gmail `from:` filter matches the sender **address**, so display-name spoofing (a sketchy
address that just *labels* itself "Amazon") is already excluded, and Gmail search skips spam/trash
by default, so forged-address mail (which Amazon's DMARC policy keeps out of the inbox anyway)
rarely surfaces.
As defense-in-depth, `isAuthentic` (`trust.ts`) drops a candidate when Gmail's
`Authentication-Results` header shows `dmarc=fail`. It's **fail-open**: a missing/unparseable
header keeps the email, because a missed enrichment is harmless but dropping a real receipt isn't.
Dropped counts are recorded durably as `untrusted_dropped` in the audit row.

### Candidate cap

Gmail returns newest-first, capped at `MAX_EMAILS_PER_TXN` (50). It must be high enough to cover
the whole ± window: with the old cap of 8, a heavy Amazon week truncated the matching receipt out
of the fetched set, and the model matched a wrong one (the bug the amount guard now also catches).
We can't tell Gmail to sort by closeness-to-charge, so when the result count equals the cap we set
`emails_capped: true` on the audit row (durable, not just a console warn): a silently-truncated
match stays visible after the fact. If `emails_capped` still shows up, raise the cap or tighten
`GMAIL_RECEIPT_WINDOW_DAYS`.

## Module layout

```text
apps/ynab-enrich-memos/
  src/
    index.ts          # CLI args (--dry-run, --verbose, --lookback-days), lockfile
    config.ts
    constants.ts      # MEMO_PREFIX, concurrency, batch sizes, length + fetch caps
    enrich.ts         # runEnrich (pipeline above), isEligible, audit schema
    memo.ts           # buildMemo
    trust.ts          # isAuthentic: the DMARC-fail sender gate
    gmail/
      query.ts        # buildReceiptQuery: the Amazon-specific Gmail search string
    anthropic/
      client.ts       # thin wrapper over @personal-automation/anthropic
      prompts.ts      # user-message builder + email sanitizer
      schemas.ts      # receiptResponseSchema
```

The Gmail client, auth and schemas are the shared `packages/gmail/`, and the Anthropic client is
the shared `packages/anthropic/`, so the only Gmail-specific code here is the query builder.
**Reading** Gmail (`listMessages` + `getMessage`, with MIME-tree decode) was added to that package
for this app; the readonly scope was already requested at bootstrap.

## Configuration

App-specific config in `apps/ynab-enrich-memos/.env` (mirrored by `.env.example`):

```bash
ENRICH_LOOKBACK_DAYS=5
GMAIL_RECEIPT_WINDOW_DAYS=5
GMAIL_FROM_FILTER=["auto-confirm@amazon.com","shipment-tracking@amazon.com"]  # JSON array
ENRICH_MEMOS_ANTHROPIC_MODEL=claude-haiku-4-5
```

Shared secrets and ids (`YNAB_TOKEN`, `YNAB_BUDGET_ID`, `ALLOWED_ACCOUNT_IDS`,
`ANTHROPIC_API_KEY`, `GMAIL_OAUTH_*`) come from the monorepo-root `.env`; `loadAppEnv` loads
root then app on top.

`ALLOWED_ACCOUNT_IDS` is in the root `.env` rather than duplicated here, because ynab-categorize
reads the same account list and an app loads only the root `.env` plus its own.

## Shared-package contracts this app relies on

- `packages/gmail`: `listMessages({ query, maxResults })` and `getMessage({ id })` (normalizes
  headers + decodes body to text). Added for this app.
- `packages/ynab`: `TransactionPatch` widened so every field but `id` is optional, letting this
  app send a memo-only patch while ynab-categorize keeps sending category + flag.
- `packages/common/logger`: `createLogger` writes to `${name}-YYYY-MM-DD.jsonl`; this app
  passes `name: 'ynab-enrich-memos'`. Audit schema spreads `baseAuditFields` into a local
  `enrichMemosAuditSchema`.

## Audit + notify interaction

One audit row per attempt, carrying two status fields. `status` is this app's own
(`enriched` / `no_emails` / `no_receipt` / `error`) and notify never reads it. `outcome` is the
shared field from `baseAuditFields` that the digest buckets on. notify auto-discovers the rows at
`apps/<app>/audit/<app>-<date>.jsonl` and validates them against `baseAuditSchema`.

`status` → `outcome`:

| `status` | `outcome` | In the digest |
|---|---|---|
| `enriched` | `applied`, set by the shared patch stage in `packages/ynab/src/patch.ts` | a success |
| `enriched`, dry run | `skipped_for_dry_run` | neither |
| `no_emails` / `no_receipt` | `skipped_for_no_match` | neither |
| `error` (Gmail or Anthropic threw) | `failed_upstream` | an error |
| PATCH rejected or the id is missing from YNAB's response | `failed` | an error |
| fatal run abort | `failed`, on a row whose `transaction_id` is `RUN_ABORTED_SENTINEL` | an error |

`no_emails` and `no_receipt` are deliberately not failures: a charge with no receipt yet is
re-checked daily until it falls out of the date window, so treating those as errors would put a
normal miss in the digest every morning.

App-specific audit fields beyond `baseAuditFields`: `emails_found` (trusted candidates handed to
the model), `emails_capped`, `untrusted_dropped`, `new_memo`, `order_total`, and the
`matched_email_url` / `matched_email_subject` / `matched_email_date` trio for spot-checking which
receipt the model used. These ride along in the JSONL (durable) but notify ignores them. The two
base fields the digest does show for this app are `result_summary` (the memo written) and
`transaction_date`.

## Open questions

1. **Two receipts in the window with the *same* total.** Amount matching can't tell them apart,
   so the model could attach the wrong one (both pass the amount guard). Wrong-*amount* matching
   is already prevented (amount-strict prompt + deterministic guard + a cap large enough to keep
   the real receipt in the set). The remaining same-amount case would need an order-id or
   tightest-date tiebreak: not yet implemented; rare in practice.
2. **Body extraction: text/plain vs HTML.** `extractBodyText` prefers the `text/plain` part and
   falls back to stripped HTML. Some Amazon emails carry a near-empty plain part beside the real
   HTML, which would starve the model. Needs validation against **real** Amazon receipt emails
   before changing the rule (e.g. prefer the longer of the two, or always include both). Same
   real-email test should confirm `MAX_EMAILS_PER_TXN` is large enough (watch `emails_capped`).
