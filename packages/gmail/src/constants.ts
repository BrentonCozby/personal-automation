export const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1'
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

export const GMAIL_SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

// Per-request timeout so an unattended run can't hang forever on a stalled socket. A timeout
// rejects with a retryable TimeoutError, so withRetry gives each attempt a fresh budget.
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000
