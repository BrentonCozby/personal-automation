import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

// Standard msw lifecycle for a test file: spin a fresh server, reset between cases,
// close at the end, and fail loudly on any unhandled HTTP request so a mistyped URL
// doesn't silently hit the network. Call once at module scope of a `.test.ts` file.
export function setupMswServer(): ReturnType<typeof setupServer> {
  const server = setupServer()
  beforeAll((): void => server.listen({ onUnhandledRequest: 'error' }))
  afterEach((): void => server.resetHandlers())
  afterAll((): void => server.close())

  return server
}
