import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import { resolveCurrentSessionId, resolveSuccessors } from './continuity.js'

let clock = 0

function event(
  partial: Partial<HookEvent> & Pick<HookEvent, 'hook_event_name' | 'session_id'>,
): HookEvent {
  clock += 1

  return { t: clock, ...partial }
}

it('follows a cleared session to the one that replaced it', () => {
  // Real timestamps from clearing `bme-orders`: the end landed first here.
  const successors = resolveSuccessors([
    event({
      hook_event_name: 'SessionEnd',
      session_id: '43f85675',
      reason: 'clear',
      hook_ppid: 43_789,
      t: 1_787_608_045,
    }),
    event({
      hook_event_name: 'SessionStart',
      session_id: 'b0ccc417',
      source: 'clear',
      hook_ppid: 43_789,
      t: 1_787_608_046,
    }),
  ])

  expect(successors.get('43f85675')).toBe('b0ccc417')
})

it('follows the handover when the new session is written down first', () => {
  // Clearing `code-gardener` wrote SessionStart before SessionEnd. The order is
  // not stable between one clear and the next, so neither half can be assumed
  // to arrive first.
  const successors = resolveSuccessors([
    event({
      hook_event_name: 'SessionStart',
      session_id: '51d6838c',
      source: 'clear',
      hook_ppid: 29_194,
      t: 1_787_607_861,
    }),
    event({
      hook_event_name: 'SessionEnd',
      session_id: 'dc563f3b',
      reason: 'clear',
      hook_ppid: 29_194,
      t: 1_787_607_861,
    }),
  ])

  expect(successors.get('dc563f3b')).toBe('51d6838c')
})

it('refuses to pair two handovers far apart in time on a recycled pid', () => {
  const successors = resolveSuccessors([
    event({
      hook_event_name: 'SessionEnd',
      session_id: 'old',
      reason: 'clear',
      hook_ppid: 7,
      t: 100,
    }),
    event({
      hook_event_name: 'SessionStart',
      session_id: 'much-later',
      source: 'clear',
      hook_ppid: 7,
      t: 90_000,
    }),
  ])

  expect(successors.size).toBe(0)
})

it('follows a resume from a throwaway tab to the session it opened', () => {
  const successors = resolveSuccessors([
    event({
      hook_event_name: 'SessionEnd',
      session_id: 'f57f1d6b',
      reason: 'resume',
      hook_ppid: 75_555,
    }),
    event({
      hook_event_name: 'SessionStart',
      session_id: 'ca0c7db2',
      source: 'resume',
      hook_ppid: 75_555,
    }),
  ])

  expect(successors.get('f57f1d6b')).toBe('ca0c7db2')
})

it('ignores an ordinary exit followed by an unrelated new session', () => {
  const successors = resolveSuccessors([
    event({
      hook_event_name: 'SessionEnd',
      session_id: 'finished',
      reason: 'prompt_input_exit',
      hook_ppid: 500,
    }),
    event({
      hook_event_name: 'SessionStart',
      session_id: 'brand-new',
      source: 'startup',
      hook_ppid: 500,
    }),
  ])

  expect(successors.size).toBe(0)
})

it('ignores a new session that started on a different process', () => {
  const successors = resolveSuccessors([
    event({ hook_event_name: 'SessionEnd', session_id: 'old', reason: 'clear', hook_ppid: 1 }),
    event({ hook_event_name: 'SessionStart', session_id: 'new', source: 'clear', hook_ppid: 2 }),
  ])

  expect(successors.size).toBe(0)
})

it('walks a chain of clears to the session that is current now', () => {
  const successors = new Map([
    ['a', 'b'],
    ['b', 'c'],
  ])

  expect(resolveCurrentSessionId({ sessionId: 'a', successors })).toBe('c')
})

it('leaves a session with no successor as itself', () => {
  expect(resolveCurrentSessionId({ sessionId: 'a', successors: new Map() })).toBe('a')
})

it('stops instead of spinning if the chain loops back', () => {
  const successors = new Map([
    ['a', 'b'],
    ['b', 'a'],
  ])

  expect(resolveCurrentSessionId({ sessionId: 'a', successors })).toBe('b')
})
