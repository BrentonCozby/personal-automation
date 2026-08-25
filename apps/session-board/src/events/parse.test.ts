import { expect, it } from 'vitest'
import { parseEventLog } from './parse.js'

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event)
}

const sessionStart = {
  hook_event_name: 'SessionStart',
  session_id: 'abc',
  t: 100,
  source: 'startup',
  cwd: '/repo',
  hook_ppid: 4242,
}

it('parses a well-formed line into an event', () => {
  const { events, skippedLineCount } = parseEventLog(line(sessionStart))

  expect(skippedLineCount).toBe(0)
  expect(events).toEqual([sessionStart])
})

it('keeps events in file order rather than sorting by timestamp', () => {
  // A resume writes SessionEnd then SessionStart inside the same second.
  // Sorting on `t` cannot tell them apart, and liveness depends on knowing
  // which of the two claimed the process last.
  const text = [
    line({ hook_event_name: 'SessionEnd', session_id: 'leaving', t: 500, reason: 'resume' }),
    line({ hook_event_name: 'SessionStart', session_id: 'entering', t: 500, source: 'resume' }),
  ].join('\n')

  const { events } = parseEventLog(text)

  expect(events.map(event => event.session_id)).toEqual(['leaving', 'entering'])
})

it('drops a torn line and counts it without losing the lines around it', () => {
  const text = [
    line(sessionStart),
    '{"hook_event_name":"Stop","session_i',
    line({ hook_event_name: 'Stop', session_id: 'abc', t: 200 }),
  ].join('\n')

  const { events, skippedLineCount } = parseEventLog(text)

  expect(skippedLineCount).toBe(1)
  expect(events.map(event => event.hook_event_name)).toEqual(['SessionStart', 'Stop'])
})

it('drops a line missing a field the board cannot work without', () => {
  const { events, skippedLineCount } = parseEventLog(line({ hook_event_name: 'Stop', t: 200 }))

  expect(skippedLineCount).toBe(1)
  expect(events).toEqual([])
})

it('ignores blank lines instead of counting them as damage', () => {
  const { events, skippedLineCount } = parseEventLog(`\n${line(sessionStart)}\n\n`)

  expect(skippedLineCount).toBe(0)
  expect(events).toHaveLength(1)
})

it('keeps an event whose name this version does not recognize', () => {
  // A newer Claude Code adding an event must not empty the board.
  const { events, skippedLineCount } = parseEventLog(
    line({ hook_event_name: 'SomethingAddedLater', session_id: 'abc', t: 300 }),
  )

  expect(skippedLineCount).toBe(0)
  expect(events[0]?.hook_event_name).toBe('SomethingAddedLater')
})

it('keeps an event carrying fields it does not know about', () => {
  const { events, skippedLineCount } = parseEventLog(
    line({ ...sessionStart, some_future_field: 'ignored' }),
  )

  expect(skippedLineCount).toBe(0)
  expect(events[0]?.session_id).toBe('abc')
})
