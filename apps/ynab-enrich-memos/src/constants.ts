/** Payee these enrichments target. Mirrors ynab-categorize's PAYEE_FILTER. */
export const PAYEE_FILTER = 'Amazon'

/**
 * Prefix on every memo this job writes, so you can see in YNAB which memos were auto-generated.
 * A space follows it in the built memo. It's purely a marker now: eligibility is empty-only
 * (see isEligible), so a non-empty memo of any kind is left alone; clear a memo to regenerate it.
 */
export const MEMO_PREFIX = 'auto-gen:'

/** YNAB rejects memos longer than this; the generated memo (prefix included) is clamped to it. */
export const MAX_MEMO_LENGTH = 500

/**
 * Transactions processed at once. Kept low because each one sends a whole window of receipt
 * emails to the model (~15k input tokens), so a wide burst trips the Anthropic per-minute token
 * rate limit, most painful during a multi-day backfill. The client retries 429s, so a higher
 * value still completes, just with more churn.
 */
export const ENRICH_CONCURRENCY = 2

/** Bulk PATCH size, matching ynab-categorize. */
export const PATCH_BATCH_SIZE = 10

/**
 * Candidate receipt emails fetched per transaction. Gmail returns newest-first, so this must be
 * high enough to cover the whole ± date window; otherwise the matching receipt can be truncated
 * out and the model matches a wrong one. `emails_capped` on the audit row flags when even this is
 * exceeded (tighten GMAIL_RECEIPT_WINDOW_DAYS or raise this if you see it).
 */
export const MAX_EMAILS_PER_TXN = 50

/**
 * Reject a matched receipt whose stated order total differs from the charge by more than this.
 * Amazon's order total equals the charge to the cent; the small tolerance only absorbs tax
 * rounding. This is a deterministic backstop to the prompt's amount-matching rule: it stops a
 * wrong-amount receipt from ever being written, no matter what the model returns.
 */
export const ORDER_TOTAL_TOLERANCE_DOLLARS = 0.5

/** Per-email body chars handed to the model, after decode + sanitize. Bounds token use. */
export const MAX_EMAIL_BODY_CHARS = 4000

/** Progress-log cadence on non-TTY (launchd) runs. */
export const PROGRESS_LOG_EVERY = 10
