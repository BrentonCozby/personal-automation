import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import { pruneEvents } from './prune-events.js'

const NOW = 1_800_000_000
const DAY = 86_400

function event(sessionId: string, agoDays: number): HookEvent {
  return { session_id: sessionId, hook_event_name: 'Stop', t: NOW - agoDays * DAY }
}

it('drops an old session nobody claimed and keeps a recent one and a claimed one', () => {
  const events = [
    event('old', 40),
    event('claimed', 40),
    event('recent', 40),
    event('recent', 2),
    event('old', 30),
  ]

  const kept = pruneEvents({ events, metadata: { claimed: {} }, now: NOW, keepDays: 14 })

  expect(kept).toEqual([event('claimed', 40), event('recent', 40), event('recent', 2)])
})

it('hands back the same array when nothing is dropped', () => {
  const events = [event('recent', 1)]

  expect(pruneEvents({ events, metadata: {}, now: NOW, keepDays: 14 })).toBe(events)
})
