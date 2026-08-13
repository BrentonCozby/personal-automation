import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import { expect, it } from 'vitest'
import { createPushoverClient } from './client.js'

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json'
const server = setupMswServer()

function client(): ReturnType<typeof createPushoverClient> {
  return createPushoverClient({ token: 'app-token', userKey: 'user-key' })
}

function message(): { title: string; message: string; url: string; urlTitle: string } {
  return {
    title: 'Due today (1)',
    message: '• give Dolly her meds',
    url: 'obsidian://open?vault=iphone&file=Todos/Dashboard.md',
    urlTitle: 'Open the dashboard',
  }
}

it('posts the message as form fields and returns the request id', async () => {
  let received: Record<string, string> = {}
  server.use(
    http.post(PUSHOVER_URL, async ({ request }) => {
      received = Object.fromEntries(new URLSearchParams(await request.text()))

      return HttpResponse.json({ status: 1, request: 'req-123' })
    }),
  )

  expect(await client().send(message())).toEqual({ requestId: 'req-123' })
  expect(received).toEqual({
    token: 'app-token',
    user: 'user-key',
    title: 'Due today (1)',
    message: '• give Dolly her meds',
    url: 'obsidian://open?vault=iphone&file=Todos/Dashboard.md',
    url_title: 'Open the dashboard',
    priority: '0',
  })
})

// A dropped meds alert is the worst outcome this job has, so a refusal is loud and the run fails.
it('throws with the status and body when Pushover refuses', async () => {
  let calls = 0
  server.use(
    http.post(PUSHOVER_URL, () => {
      calls += 1

      return HttpResponse.json(
        { status: 0, errors: ['application token is invalid'] },
        { status: 400 },
      )
    }),
  )

  await expect(client().send(message())).rejects.toThrow(/400.*application token is invalid/s)
  // A rejected token is not going to be accepted on the next attempt.
  expect(calls).toBe(1)
})

// Costs about a second of real backoff, which is the price of proving a 500 is not treated as a
// permanent refusal.
it('retries a server error and reports the eventual success', async () => {
  let calls = 0
  server.use(
    http.post(PUSHOVER_URL, () => {
      calls += 1
      if (calls === 1) return new HttpResponse('upstream is down', { status: 503 })

      return HttpResponse.json({ status: 1, request: 'req-456' })
    }),
  )

  expect(await client().send(message())).toEqual({ requestId: 'req-456' })
  expect(calls).toBe(2)
})
