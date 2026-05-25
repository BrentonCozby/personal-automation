import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

// Loads the monorepo-root `.env` based on the caller's module URL. Assumes the
// standard `apps/<name>/src/...` layout — three levels up from the caller lands
// at the repo root. Apps call this once at the top of their config.ts:
//
//   loadRootEnv(import.meta.url)
export function loadRootEnv(callerUrl: string): void {
  const callerDir = path.dirname(fileURLToPath(callerUrl))
  dotenv.config({ path: path.resolve(callerDir, '../../../.env') })
}

// Zod string transform that parses the input as JSON. Pair with `.pipe(...)`
// to validate the parsed shape — e.g. `jsonValue.pipe(z.array(z.string()))`
// for an env var that holds a JSON array.
export const jsonValue = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid JSON' })

    return z.NEVER
  }
})
