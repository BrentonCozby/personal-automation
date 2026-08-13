import { AppError } from '@personal-automation/common/errors'
import { calendarDaysBetween, localIsoDate } from '../state/days.js'
import type { AbandonResult } from './abandon.js'
import type { PromoteResult } from './promote.js'
import type { ScheduleResult } from './schedule.js'
import type { LookupFailure, NotEditable, TaskSummary, WriteFailure } from './task-io.js'

/**
 * The console message for one promotion attempt.
 *
 * At the cap, it names the tasks already active and the order it put them in, because an order the
 * reader can't account for reads as arbitrary. It never suggests working harder or faster: raising
 * the cap for one promotion is a supported move, so it is offered plainly.
 */
export function renderPromoteResult({ result, now }: { result: PromoteResult; now: Date }): string {
  switch (result.kind) {
    case 'not_found':
    case 'ambiguous':
      return renderLookupFailure(result)
    case 'not_editable':
      return renderNotEditable(result)
    case 'conflict':
      return renderConflict(result)
    case 'already_active':
      return `"${result.title}" is already #active. Nothing to change.`
    case 'at_cap':
      return renderAtCap({ cap: result.cap, active: result.active, now })
    case 'promoted':
      return result.isOverCap
        ? [
            `Promoted "${result.title}" to #active: ${result.activeCount} active, one over the cap of ${result.cap}.`,
            'Recorded in runs/overrides.jsonl.',
          ].join('\n')
        : `Promoted "${result.title}" to #active: ${result.activeCount} of ${result.cap} active.`
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled promote result: ${JSON.stringify(_exhaustive)}` })
    }
  }
}

/** The console message for one abandonment. */
export function renderAbandonResult(result: AbandonResult): string {
  switch (result.kind) {
    case 'not_found':
    case 'ambiguous':
      return renderLookupFailure(result)
    case 'not_editable':
      return renderNotEditable(result)
    case 'conflict':
      return renderConflict(result)
    case 'abandoned':
      return [
        `Dropped "${result.title}": its checkbox is cancelled and dated ${result.date}.`,
        ...(result.wasActive ? ['That frees a place on the active list.'] : []),
      ].join('\n')
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled abandon result: ${JSON.stringify(_exhaustive)}` })
    }
  }
}

/** The console message for one scheduling. */
export function renderScheduleResult(result: ScheduleResult): string {
  switch (result.kind) {
    case 'not_found':
    case 'ambiguous':
      return renderLookupFailure(result)
    case 'not_editable':
      return renderNotEditable(result)
    case 'conflict':
      return renderConflict(result)
    case 'bad_date':
      return `"${result.input}" is not a date. Use YYYY-MM-DD, or +Nd for days from today (+7d).`
    case 'past_date':
      return `${result.date} has already gone by. Give a date from today onward.`
    case 'scheduled':
      return result.isDeferred
        ? [
            `Scheduled "${result.title}" for ${result.date}, which is past the ${result.horizonDays}-day horizon.`,
            'Moved it to #someday, since a date that far out is a hope rather than a plan.',
          ].join('\n')
        : `Scheduled "${result.title}" for ${result.date}.`
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled schedule result: ${JSON.stringify(_exhaustive)}` })
    }
  }
}

function renderLookupFailure(result: LookupFailure): string {
  if (result.kind === 'not_found') {
    return [
      `No open task matches "${result.query}".`,
      'This reads the same files as the digest (TASK_LISTS), so a task kept elsewhere in the',
      'vault will not be found here.',
    ].join('\n')
  }

  return [
    `"${result.query}" matches ${result.matches.length} open tasks:`,
    '',
    ...result.matches.map(match => `  ${match.title} (${match.list})`),
    '',
    'Give more of the title, or the whole of it.',
  ].join('\n')
}

function renderNotEditable(result: NotEditable): string {
  switch (result.reason) {
    case 'recurring':
      return [
        `"${result.title}" is a recurring task, so it stays outside the state model. The Tasks`,
        'plugin carries it on its own dates. Nothing was changed.',
      ].join('\n')
    case 'terminal':
      return [
        `"${result.title}" is tagged #${result.state}, which is a state nothing moves out of.`,
        'Nothing was changed. Edit the tag in Obsidian if you mean to pick it up again.',
      ].join('\n')
    case 'conflicting':
      return [
        `"${result.title}" carries ${result.states.map(state => `#${state}`).join(' and ')}, and a`,
        'task is in one state or none. Nothing was changed, and until one tag goes it counts as',
        'neither: not against the cap, not in the holding pool.',
        '',
        `  ${result.path}:${result.line}`,
        '',
        'Delete the tag you did not mean. Writing a state here would have thrown away the other',
        'one, and nothing on the line says which of the two that should be.',
      ].join('\n')
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled refusal: ${JSON.stringify(_exhaustive)}` })
    }
  }
}

function renderConflict(result: WriteFailure): string {
  return [
    `"${result.title}" changed in ${result.path} while this was reading it, so nothing was`,
    'written. Run it again to pick up the new text.',
  ].join('\n')
}

function renderAtCap({
  cap,
  active,
  now,
}: {
  cap: number
  active: TaskSummary[]
  now: Date
}): string {
  return [
    `${active.length} ${active.length === 1 ? 'task is' : 'tasks are'} already #active, which is the cap.`,
    '',
    'Closest to done first (most recently touched, then soonest due):',
    ...active.map((task, index) => `  ${index + 1}. ${task.title}: ${describe({ task, now })}`),
    '',
    `Finish or drop one of those, or run again with --over-cap to make it ${cap + 1} this once.`,
  ].join('\n')
}

function describe({ task, now }: { task: TaskSummary; now: Date }): string {
  const parts = [touchPhrase({ lastTouched: task.lastTouched, now })]
  if (task.due) parts.push(`due ${localIsoDate(task.due)}`)

  return parts.join(', ')
}

function touchPhrase({ lastTouched, now }: { lastTouched: Date | undefined; now: Date }): string {
  if (!lastTouched) return 'not touched since the clock started'
  const days = calendarDaysBetween({ from: lastTouched, to: now })
  if (days <= 0) return 'touched today'
  if (days === 1) return 'touched yesterday'

  return `touched ${days} days ago`
}
