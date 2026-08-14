import { expect, it } from 'vitest'
import { buildAlertMessage } from './alert-message.js'

it('lists what is due, one bulleted item per line', () => {
  const result = buildAlertMessage({
    due: [{ title: 'give Dolly her meds' }, { title: 'water the schefflera' }],
    demoted: [],
  })

  expect(result.title).toBe('Due (2)')
  expect(result.message).toBe('• give Dolly her meds\n• water the schefflera')
})

// The machine is dropping a commitment the user did not drop, so they learn it when it happens.
it('announces a demotion on its own', () => {
  const result = buildAlertMessage({
    due: [],
    demoted: [{ title: 'book india flights', untouchedDays: 31 }],
  })

  expect(result.title).toBe('Moved to someday (1)')
  expect(result.message).toBe('Moved to someday:\n• book india flights, untouched 31 days')
})

it('puts the demotion under what is due when both have something', () => {
  const result = buildAlertMessage({
    due: [{ title: 'give Dolly her meds' }],
    demoted: [{ title: 'book india flights', untouchedDays: 31 }],
  })

  expect(result.title).toBe('Due (1)')
  expect(result.message).toBe(
    '• give Dolly her meds\n\nMoved to someday:\n• book india flights, untouched 31 days',
  )
})

it('renders an empty pair as an empty message', () => {
  expect(buildAlertMessage({ due: [], demoted: [] })).toEqual({
    title: 'Moved to someday (0)',
    message: '',
  })
})

// Pushover truncates at 1024 bytes itself, which would cut a title in half. The count of what was
// left out is more useful than half a task name.
it('drops whole items and names how many, rather than being cut mid-title', () => {
  const due = Array.from({ length: 60 }, (_, index) => ({
    title: `a task with a fairly long name, number ${index}`,
  }))

  const result = buildAlertMessage({ due, demoted: [] })

  expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(1024)
  expect(result.message).toMatch(/\n• and \d+ more$/)
  expect(result.title).toBe('Due (60)')
})

// A demotion is news that arrives nowhere else, so it survives the truncation that trims the list.
it('keeps the demotion when the due list is truncated', () => {
  const due = Array.from({ length: 60 }, (_, index) => ({
    title: `a task with a fairly long name, number ${index}`,
  }))

  const result = buildAlertMessage({
    due,
    demoted: [{ title: 'book india flights', untouchedDays: 31 }],
  })

  expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(1024)
  expect(result.message).toContain('book india flights, untouched 31 days')
})

// Pushover refuses an over-long message rather than trimming it, and a refusal loses the whole
// alert, so the limit has to hold even when the demotions alone would fill it.
it('trims the demotion list when it fills the message on its own', () => {
  const demoted = Array.from({ length: 8 }, (_, index) => ({
    title: `a demoted task carrying a name long enough to matter here, number ${index}`.repeat(3),
    untouchedDays: 31,
  }))

  const result = buildAlertMessage({
    due: [{ title: 'give Dolly her meds' }],
    demoted,
  })

  expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(1024)
  expect(result.message).toMatch(/• and \d+ more moved to someday$/)
  expect(result.message).toContain('Moved to someday:')
})

// The floor of the trim: one demotion whose title alone is longer than the whole message. Nothing
// is left to drop but the task itself, and what is sent still has to say one task moved.
it('names the count when a single demotion is longer than the message', () => {
  const result = buildAlertMessage({
    due: [{ title: 'give Dolly her meds' }],
    demoted: [{ title: 'x'.repeat(1200), untouchedDays: 31 }],
  })

  expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(1024)
  expect(result.message).toContain('• and 1 more moved to someday')
  expect(result.message).not.toContain('xxx')
})
