import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Resolves the workspace root from a caller's module URL. Assumes the standard
 * `apps/<name>/src/...` or `packages/<name>/src/...` layout: three levels up
 * from the caller lands at the workspace root. Centralized here so the layout
 * assumption is encoded in one place.
 */
export function resolveWorkspaceRoot(callerUrl: string): string {
  const callerDir = path.dirname(fileURLToPath(callerUrl))

  return path.resolve(callerDir, '../../..')
}

/**
 * Loads only the monorepo-root `.env`, based on the caller's module URL. For
 * package-level callers that need shared secrets but have no app `.env` of their
 * own (e.g. the Gmail bootstrap script):
 *
 *   loadRootEnv(import.meta.url)
 */
export function loadRootEnv(callerUrl: string): void {
  dotenv.config({ path: path.join(resolveWorkspaceRoot(callerUrl), '.env'), quiet: true })
}

/**
 * Loads the monorepo-root `.env`, then the calling app's own `apps/<name>/.env`
 * layered on top: shared secrets live at the root, app-specific config sits
 * beside the app. Apps call this once at the top of their config.ts:
 *
 *   loadAppEnv(import.meta.url)
 */
export function loadAppEnv(callerUrl: string): void {
  const callerDir = path.dirname(fileURLToPath(callerUrl))
  dotenv.config({ path: path.join(resolveWorkspaceRoot(callerUrl), '.env'), quiet: true })
  dotenv.config({ path: path.resolve(callerDir, '../.env'), quiet: true })
}

/**
 * Zod string transform that parses the input as JSON. Pair with `.pipe(...)`
 * to validate the parsed shape, for example `jsonValue.pipe(z.array(z.string()))`
 * for an env var that holds a JSON array.
 */
export const jsonValue = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid JSON' })

    return z.NEVER
  }
})
