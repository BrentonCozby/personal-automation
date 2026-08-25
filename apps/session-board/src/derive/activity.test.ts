import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import { deriveActivity } from './activity.js'

let clock = 0

function event(partial: Partial<HookEvent> & Pick<HookEvent, 'hook_event_name'>): HookEvent {
  clock += 1

  return { session_id: 'abc', t: clock, ...partial }
}

it('reads a session mid-turn as running', () => {
  expect(deriveActivity([event({ hook_event_name: 'UserPromptSubmit' })])).toBe('running')
})

it('reads a finished turn as idle', () => {
  const events = [
    event({ hook_event_name: 'UserPromptSubmit' }),
    event({ hook_event_name: 'Stop' }),
  ]

  expect(deriveActivity(events)).toBe('idle')
})

it('treats a failed stop the same as a stop', () => {
  const events = [
    event({ hook_event_name: 'UserPromptSubmit' }),
    event({ hook_event_name: 'StopFailure' }),
  ]

  expect(deriveActivity(events)).toBe('idle')
})

it('reads a session blocked on a permission prompt as waiting', () => {
  const events = [
    event({ hook_event_name: 'UserPromptSubmit' }),
    event({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
  ]

  expect(deriveActivity(events)).toBe('waiting')
})

it('reads an elicitation dialog as waiting too', () => {
  const events = [
    event({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }),
  ]

  expect(deriveActivity(events)).toBe('waiting')
})

it('clears waiting once the elicitation is answered', () => {
  const events = [
    event({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }),
    event({ hook_event_name: 'ElicitationResult' }),
  ]

  expect(deriveActivity(events)).toBe('running')
})

it('holds waiting until the turn ends, since approving a tool logs nothing', () => {
  const events = [
    event({ hook_event_name: 'UserPromptSubmit' }),
    event({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
  ]

  expect(deriveActivity(events)).toBe('waiting')
  expect(deriveActivity([...events, event({ hook_event_name: 'Stop' })])).toBe('idle')
})

it('reads a notification that Claude wants input as idle', () => {
  const events = [event({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })]

  expect(deriveActivity(events)).toBe('idle')
})

it('reports a closed session as ended rather than idle', () => {
  const events = [
    event({ hook_event_name: 'Stop' }),
    event({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
  ]

  expect(deriveActivity(events)).toBe('ended')
})

it('revives a session that was ended and then resumed', () => {
  const events = [
    event({ hook_event_name: 'SessionEnd', reason: 'resume' }),
    event({ hook_event_name: 'SessionStart', source: 'resume' }),
  ]

  expect(deriveActivity(events)).toBe('idle')
})

it('looks past an event it does not recognize', () => {
  const events = [
    event({ hook_event_name: 'UserPromptSubmit' }),
    event({ hook_event_name: 'SomethingAddedLater' }),
  ]

  expect(deriveActivity(events)).toBe('running')
})

it('looks past a notification with no type', () => {
  const events = [
    event({ hook_event_name: 'UserPromptSubmit' }),
    event({ hook_event_name: 'Notification' }),
  ]

  expect(deriveActivity(events)).toBe('running')
})

it('falls back to idle when nothing says otherwise', () => {
  expect(deriveActivity([])).toBe('idle')
})
