/**
 * Checks that keep a web page you happen to be visiting from driving the board.
 *
 * The board listens on localhost with no login, so any page in the browser can
 * reach it. A form post needs no permission from the browser first, and the
 * session id in the path is substituted into the command a new terminal tab
 * runs, so an unchecked request turns into a command of someone else's choosing.
 */

/**
 * Session ids come from Claude Code as UUIDs. This is wider than that but still
 * holds nothing a shell or an argument parser treats as anything but text.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface RequestRejection {
  status: number
  error: string
}

declare const checkedSessionId: unique symbol

/**
 * A session id that has been through `isSessionId`.
 *
 * `openSessionTab` takes this rather than a string, so a path segment that
 * skipped the check cannot reach the command a terminal tab runs: the compiler
 * refuses it. Catching the bad id at the door was what the origin hole needed;
 * this is what makes forgetting the door impossible.
 */
export type SessionId = string & { readonly [checkedSessionId]: true }

export function isSessionId(sessionId: string): sessionId is SessionId {
  return SESSION_ID_PATTERN.test(sessionId)
}

function allowedOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]
}

function isJsonContentType(contentType: string | undefined): boolean {
  const [type] = (contentType || '').split(';')

  return type?.trim().toLowerCase() === 'application/json'
}

/**
 * The reason to refuse a request, or `undefined` to let it through.
 *
 * Reads only what the browser sets itself, never a header a page can forge.
 */
export function findRequestRejection({
  method,
  origin,
  contentType,
  port,
}: {
  method: string | undefined
  origin: string | undefined
  contentType: string | undefined
  port: number
}): RequestRejection | undefined {
  if (!method || !MUTATING_METHODS.has(method)) return undefined

  // A request with no origin at all came from curl or a script, not a page: a
  // browser always sets it on these methods. Anything else is another site.
  if (origin && !allowedOrigins(port).includes(origin)) {
    return { status: 403, error: 'cross-origin request refused' }
  }

  // The second lock, independent of the first. A form can only send text/plain,
  // urlencoded or multipart, so demanding json forces the browser to ask
  // permission first through a preflight, which this server never answers.
  if (method !== 'DELETE' && !isJsonContentType(contentType)) {
    return { status: 415, error: 'content-type must be application/json' }
  }

  return undefined
}
