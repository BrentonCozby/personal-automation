import { AppError } from './errors.js'

type RetryOptions = {
  attempts?: number
  baseDelayMs?: number
  isRetryable?: (err: unknown) => boolean
  onRetry?: (info: { attempt: number; err: unknown; delayMs: number }) => void
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 500, isRetryable = defaultIsRetryable, onRetry }: RetryOptions = {},
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const isLast = i === attempts - 1
      if (isLast || !isRetryable(err)) break

      // Exponential backoff with jitter.
      const delayMs = baseDelayMs * 2 ** i + Math.random() * baseDelayMs
      onRetry?.({ attempt: i + 1, err, delayMs })
      await sleep(delayMs)
    }
  }
  throw lastErr
}

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof AppError) return err.retryable
  // Network-level failures are usually transient: fetch errors (TypeError), aborts
  // (AbortError), and per-request timeouts from AbortSignal.timeout (TimeoutError).
  if (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'TypeError')
  ) {
    return true
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
