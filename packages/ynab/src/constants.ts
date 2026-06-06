export const YNAB_API_BASE_URL = 'https://api.ynab.com/v1'

// Per-request timeout so an unattended run can't hang forever on a stalled socket. A timeout
// rejects with a retryable TimeoutError, so withRetry gives each attempt a fresh budget.
export const YNAB_REQUEST_TIMEOUT_MS = 30_000
