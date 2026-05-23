export class AppError extends Error {
  override readonly name: string = 'AppError'
  readonly retryable: boolean

  constructor({
    message,
    retryable = false,
    cause,
  }: { message: string; retryable?: boolean; cause?: unknown }) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.retryable = retryable
  }
}

export class YnabApiError extends AppError {
  override readonly name = 'YnabApiError'
  readonly status: number
  readonly method: string
  readonly path: string
  readonly body: string

  constructor({
    status,
    method,
    path,
    body,
  }: { status: number; method: string; path: string; body: string }) {
    super({
      message: `YNAB ${method} ${path} → ${status}: ${body}`,
      retryable: isRetryableHttpStatus(status),
    })
    this.status = status
    this.method = method
    this.path = path
    this.body = body
  }
}

function isRetryableHttpStatus(status: number): boolean {
  // 408 timeout, 425 too-early, 429 rate-limited, and any 5xx are transient.
  if (status === 408 || status === 425 || status === 429) return true
  if (status >= 500 && status < 600) return true

  return false
}
