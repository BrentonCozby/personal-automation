# Due-date alerts and decay implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tasks alert` command, run by launchd at 08:00 and 19:00, that pushes what is due to the phone through Pushover and demotes any `#active` task untouched for 28 days to `#someday`.

**Architecture:** Two pure rules (`state/due.ts`, `state/decay.ts`) decide what to alert on and what to demote. One command (`commands/alert.ts`) runs both inside a single `withTaskClock` pass under `tasks-edit.lock`, so the vault is read once and the touch clock is saved once. A pure renderer (`alert-message.ts`) turns the two lists into a title and a message; a factory client (`pushover/client.ts`) POSTs it. The push happens after the clock is saved, so a Pushover failure cannot throw away the clock update that keeps a demotion from reading as a touch.

**Tech Stack:** TypeScript (ESM, NodeNext), zod 4, vitest + msw, pino, pnpm workspaces, launchd.

**Spec:** `docs/superpowers/specs/2026-08-13-due-date-alerts-and-decay-design.md`

## Global Constraints

Every task's requirements include these.

- **Package manager is pnpm.** Never `npm` or `yarn`. Run tests with `pnpm vitest run <path>` from the repo root, never a bare `vitest` (watch mode).
- **Object args for 2+ parameters:** `function foo({ a, b }: { a: T; b: U })`. A single positional arg only where a second could never be wanted.
- **Factory functions, not classes.** External-system adapters are `createX` returning an object of operations, with named inner functions (`function send(...)`, not `send: (...) => ...`).
- **Blank line before `return`** unless the return is an inline `if (x) return y` or the only statement in its block.
- **No em dashes anywhere**, in code, comments, docs, or any string this app prints or pushes. Use parentheses, a colon, a period, or a semicolon.
- **No `as`, no `as unknown as`, no non-null `!`.** Narrow with `typeof`, `in`, a truthiness check, or a type guard.
- **`||` for falsy fallbacks, `??` only to keep a real `0` / `''` / `false`.**
- **No `.default()` in `config.ts`.** Env is the source of truth; a missing var throws at load.
- **Tests live next to source** as `<name>.test.ts`, end-to-end ones as `<name>.e2e.test.ts`.
- **Conventional Commits**, enforced by a husky `commit-msg` hook. Every commit ends with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`, passed with `-m` (the hook reads the trailer off the command line, so `-F file` is rejected). Stage in a separate command from the commit.
- **Coverage gate is 80 lines / 80 functions / 80 statements / 75 branches**, whole workspace.
- Exact values fixed by the spec: `TASKS_DUE_ALERT_DAYS=7`, `TASKS_HORIZON_DAYS=28` (already set), `TASKS_ALERT_TIMES=["08:00", "19:00"]`, `TASKS_ALERT_URL=obsidian://open?vault=iphone&file=Todos/Dashboard.md`, Pushover message limit 1024 UTF-8 bytes, title limit 250, priority `0`, endpoint `https://api.pushover.net/1/messages.json`, item separator the literal `•`, no HTML in the message.

## File Structure

Created:

```
apps/tasks/src/state/due.ts            which tasks alert, pure
apps/tasks/src/state/due.test.ts
apps/tasks/src/state/decay.ts          which tasks demote, pure
apps/tasks/src/state/decay.test.ts
apps/tasks/src/alert-message.ts        renders the push title and message, pure
apps/tasks/src/alert-message.test.ts
apps/tasks/src/pushover/schemas.ts     zod for the response
apps/tasks/src/pushover/client.ts      createPushoverClient, the POST
apps/tasks/src/pushover/client.test.ts
apps/tasks/src/commands/alert.ts       runAlert: one pass, both halves
apps/tasks/src/commands/alert.e2e.test.ts
launchd/run-tasks-alert.sh             wrapper, notifies macOS on a non-zero exit
```

Modified:

```
apps/tasks/src/state/touch-clock.ts    recordFingerprint, plus recordTouch's doc comment
apps/tasks/src/commands/task-io.ts     fingerprintFor, beside touchFor
apps/tasks/src/config.ts               TASKS_DUE_ALERT_DAYS, TASKS_ALERT_URL, PUSHOVER_*
apps/tasks/src/constants.ts            ALERT_URL_TITLE
apps/tasks/src/cli-args.ts             the `alert` command
apps/tasks/src/locks.ts                alert takes the edit lock
apps/tasks/src/index.ts                help text, dispatch, result printing
apps/tasks/src/run.e2e.test.ts         makeConfig gains the four new fields
apps/tasks/src/schedule.ts             parseAlertTimes, buildTasksAlertPlist
apps/tasks/src/generate-launchd-plist.ts   writes both plists
apps/tasks/.env, apps/tasks/.env.example   three new settings
launchd/setup.sh                       loads the new agent
launchd/newsyslog.personal-automation.conf.template   rotates the new logs
README.md, docs/task-state-model.md    the feature, and the corrected decay reason
```

Not touched: `run.ts`, `digest.ts`. The review and the alert share the state modules and nothing else.

---

### Task 1: The due-date rule

**Files:**
- Create: `apps/tasks/src/state/due.ts`
- Test: `apps/tasks/src/state/due.test.ts`

**Interfaces:**
- Consumes: `calendarDaysBetween`, `dueStatus` from `./days.js`; `TaskStatus` from `./types.js`.
- Produces: `type DueCandidate = { title: string; status: TaskStatus; isRecurring: boolean; due: Date | null }`; `isDueForAlert({ task, dueAlertDays, now }): boolean`; `dueForAlert<T extends DueCandidate>({ tasks, dueAlertDays, now }): T[]`. `DueCandidate` is a structural subset of `ScannedTask`, so Task 7 passes scan results straight in and gets `ScannedTask[]` back.

Decisions this task locks in, neither of which the spec pins down:

- **Most overdue first**, ties broken alphabetically by title. The list is short and the banner is read in one glance; a stable order means two passes on the same day read the same way.
- **State tags are not read.** A dated `#someday` task alerts exactly like a dated `#active` one, which the spec confirms is deliberate.

- [ ] **Step 1: Write the failing tests**

Create `apps/tasks/src/state/due.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DueCandidate, dueForAlert, isDueForAlert } from './due.js'

// Alerting counts local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)
const DUE_ALERT_DAYS = 7

function candidate(overrides: Partial<DueCandidate> = {}): DueCandidate {
  return {
    title: 'water the schefflera',
    status: 'open',
    isRecurring: false,
    due: new Date(2026, 7, 20),
    ...overrides,
  }
}

describe('isDueForAlert', () => {
  it('alerts a task due today', () => {
    expect(isDueForAlert({ task: candidate(), dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(true)
  })

  it('leaves a task due tomorrow alone', () => {
    const task = candidate({ due: new Date(2026, 7, 21) })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  it('leaves an undated task alone', () => {
    const task = candidate({ due: null })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a ticked task alone', () => {
    const task = candidate({ status: 'done' })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  // The taper: the due day plus the six after it, then the twice-weekly review takes over.
  it('alerts on the sixth day after the due date and stops on the seventh', () => {
    const sixth = candidate({ due: new Date(2026, 7, 14) })
    const seventh = candidate({ due: new Date(2026, 7, 13) })

    expect(isDueForAlert({ task: sixth, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(true)
    expect(isDueForAlert({ task: seventh, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  // The meds case. An unticked recurring task keeps its past date, so it keeps being asked about.
  it('keeps alerting a recurring task long past its date', () => {
    const task = candidate({ isRecurring: true, due: new Date(2026, 6, 18) })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(true)
  })

  // Spring forward is 2026-03-08 in America/Los_Angeles. Subtracting timestamps would lose an hour
  // and floor the span to 6, keeping the task on the list a day too long.
  it('counts calendar days across a daylight saving change', () => {
    const now = new Date(2026, 2, 12, 9, 0)
    const task = candidate({ due: new Date(2026, 2, 5) })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now })).toBe(false)
  })
})

describe('dueForAlert', () => {
  it('lists the most overdue first, then alphabetically', () => {
    const tasks = [
      candidate({ title: 'water the schefflera' }),
      candidate({ title: 'give Dolly her meds', due: new Date(2026, 7, 18) }),
      candidate({ title: 'a task due today' }),
      candidate({ title: 'call the vet', due: new Date(2026, 7, 25) }),
    ]

    expect(
      dueForAlert({ tasks, dueAlertDays: DUE_ALERT_DAYS, now: NOW }).map(task => task.title),
    ).toEqual(['give Dolly her meds', 'a task due today', 'water the schefflera'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/state/due.test.ts`
Expected: FAIL, cannot resolve `./due.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/tasks/src/state/due.ts`:

```ts
import { calendarDaysBetween, dueStatus } from './days.js'
import type { TaskStatus } from './types.js'

/**
 * What the alert rule reads. A structural subset of `ScannedTask`, so a scan result goes straight
 * in.
 *
 * No state tag is read. Putting a date on something is the reason to want reminding of it, so a
 * dated `#someday` task alerts exactly like a dated `#active` one.
 */
export type DueCandidate = {
  title: string
  status: TaskStatus
  isRecurring: boolean
  due: Date | null
}

/**
 * Whether the task belongs on today's push: open, dated, and the date has arrived or gone by.
 *
 * How long it keeps being asked about differs by kind. A recurring chore is asked about every day
 * until it is ticked, with no limit, because the Tasks plugin only rolls its date forward on the
 * tick, so the date staying past is exactly the signal that the chore was missed. Everything else
 * stops after `dueAlertDays` and is left to the twice-weekly review, which is what keeps a task
 * dated months ago from pushing daily forever.
 */
export function isDueForAlert({
  task,
  dueAlertDays,
  now,
}: {
  task: DueCandidate
  dueAlertDays: number
  now: Date
}): boolean {
  const due = task.due
  if (task.status !== 'open' || !due) return false
  if (dueStatus({ due, now }) !== 'past') return false
  if (task.isRecurring) return true

  return calendarDaysBetween({ from: due, to: now }) < dueAlertDays
}

/**
 * The tasks to push, most overdue first, ties in alphabetical order.
 *
 * The banner is read in one glance, so the oldest debt leads and the order is stable between the
 * morning pass and the evening one.
 */
export function dueForAlert<T extends DueCandidate>({
  tasks,
  dueAlertDays,
  now,
}: {
  tasks: readonly T[]
  dueAlertDays: number
  now: Date
}): T[] {
  return tasks
    .filter(task => isDueForAlert({ task, dueAlertDays, now }))
    .sort((left, right) => dueTime(left) - dueTime(right) || left.title.localeCompare(right.title))
}

function dueTime(task: DueCandidate): number {
  return task.due?.getTime() ?? 0
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks/src/state/due.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/tasks/src/state/due.ts apps/tasks/src/state/due.test.ts
git commit -m "feat(tasks): the rule for which dated tasks get a push

Recurring tasks alert every day they are late, since the plugin only rolls
the date forward on a tick. Everything else tapers off after
TASKS_DUE_ALERT_DAYS and is left to the twice-weekly review.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: The decay rule

**Files:**
- Create: `apps/tasks/src/state/decay.ts`
- Test: `apps/tasks/src/state/decay.test.ts`

**Interfaces:**
- Consumes: `CapCandidate`, `countsTowardCap` from `./wip.js`; `untouchedDays` from `./stall.js`.
- Produces: `hasDecayed({ task, horizonDays, now }): boolean`; `decayed<T extends CapCandidate>({ tasks, horizonDays, now }): T[]`. Task 7 passes `CapCandidate & { task: ScannedTask }` values in and gets the same shape back, the join `run.ts` already uses.

The rule deliberately does not check the due date, unlike `isStalled`. A future date cannot reach it: `schedule` refuses a date past `TASKS_HORIZON_DAYS` (it routes the task to `#someday` instead), so a date set inside the horizon has gone by before the same number of untouched days accumulates, and editing a date by hand is itself a touch. Adding the check would add a branch nothing can take.

- [ ] **Step 1: Write the failing tests**

Create `apps/tasks/src/state/decay.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decayed, hasDecayed } from './decay.js'
import type { CapCandidate } from './wip.js'

// Decay is counted in local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)
const HORIZON_DAYS = 28

function candidate(overrides: Partial<CapCandidate> = {}): CapCandidate {
  return {
    title: 'book india flights',
    list: 'todos',
    status: 'open',
    isRecurring: false,
    state: 'active',
    due: null,
    lastTouched: new Date(2026, 6, 23),
    ...overrides,
  }
}

describe('hasDecayed', () => {
  it('demotes an #active task untouched for the whole horizon', () => {
    expect(hasDecayed({ task: candidate(), horizonDays: HORIZON_DAYS, now: NOW })).toBe(true)
  })

  it('leaves a task touched one day inside the horizon alone', () => {
    const task = candidate({ lastTouched: new Date(2026, 6, 24) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a #someday task alone however long it sits', () => {
    const task = candidate({ state: 'someday', lastTouched: new Date(2026, 0, 1) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a recurring task alone', () => {
    const task = candidate({ isRecurring: true, lastTouched: new Date(2026, 0, 1) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a closed task alone', () => {
    const task = candidate({ status: 'done', lastTouched: new Date(2026, 0, 1) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  // A deleted clock must not demote everything at once.
  it('treats an unknown age as no evidence', () => {
    const task = candidate({ lastTouched: undefined })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })
})

describe('decayed', () => {
  it('keeps only the tasks past the horizon', () => {
    const tasks = [
      candidate({ title: 'book india flights' }),
      candidate({ title: 'fix the gate', lastTouched: new Date(2026, 7, 19) }),
    ]

    expect(decayed({ tasks, horizonDays: HORIZON_DAYS, now: NOW }).map(task => task.title)).toEqual([
      'book india flights',
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/state/decay.test.ts`
Expected: FAIL, cannot resolve `./decay.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/tasks/src/state/decay.ts`:

```ts
import { untouchedDays } from './stall.js'
import { type CapCandidate, countsTowardCap } from './wip.js'

/**
 * Whether a commitment has gone quiet for so long that the system stops treating it as one: an
 * `#active` task nothing has touched for `horizonDays`.
 *
 * The horizon is how far ahead a date can honestly be seen, and a task nobody has touched for that
 * long is past the point where calling it current means anything. Decay demotes rather than closing
 * the checkbox, so the machine never drops a commitment the user did not agree to drop, and
 * `tasks promote` puts it straight back.
 *
 * A task the clock has never seen does not decay. Unreachable once the clock is reconciled, but a
 * deleted clock must not demote everything at once.
 *
 * The due date is deliberately not read, unlike the stall rule. `schedule` routes any date past the
 * horizon to `#someday`, so a date set inside it has gone by before this many untouched days pass,
 * and editing a date by hand is itself a touch.
 */
export function hasDecayed({
  task,
  horizonDays,
  now,
}: {
  task: CapCandidate
  horizonDays: number
  now: Date
}): boolean {
  if (!countsTowardCap(task)) return false
  const quiet = untouchedDays({ task, now })

  return quiet !== undefined && quiet >= horizonDays
}

/** The tasks to demote, in the order they were given. */
export function decayed<T extends CapCandidate>({
  tasks,
  horizonDays,
  now,
}: {
  tasks: readonly T[]
  horizonDays: number
  now: Date
}): T[] {
  return tasks.filter(task => hasDecayed({ task, horizonDays, now }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks/src/state/decay.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/tasks/src/state/decay.ts apps/tasks/src/state/decay.test.ts
git commit -m "feat(tasks): the rule for demoting a task nothing has touched

An #active task untouched for TASKS_HORIZON_DAYS is no longer a current
commitment, and holding a cap slot for it costs a slot that could carry
something real. Demotion is reversible; closing the box would not be.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: The push message

**Files:**
- Create: `apps/tasks/src/alert-message.ts`
- Test: `apps/tasks/src/alert-message.test.ts`

**Interfaces:**
- Produces: `type DueItem = { title: string }`; `type DemotedItem = { title: string; untouchedDays: number }`; `type AlertMessage = { title: string; message: string }`; `buildAlertMessage({ due, demoted }): AlertMessage`. `DueItem` is a structural subset of `ScannedTask`, so Task 7 passes scan results in unchanged.

One copy decision this task locks in. The title is `Due (N)` whatever the dates are, since a banner that named today would be a lie about an item three days overdue and there is nothing on a lock screen to check it against. A push carrying only a demotion is titled `Moved to someday (N)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/tasks/src/alert-message.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/alert-message.test.ts`
Expected: FAIL, cannot resolve `./alert-message.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/tasks/src/alert-message.ts`:

```ts
/** One task on today's push. */
export type DueItem = {
  title: string
}

/** One task the pass demoted, and how long it had been sitting. */
export type DemotedItem = {
  title: string
  untouchedDays: number
}

export type AlertMessage = {
  title: string
  message: string
}

// Pushover's own limits, in UTF-8 bytes. Anything longer is cut by their API, mid-word.
const MESSAGE_LIMIT = 1024
// Items are separated by a bullet because Pushover strips HTML from the notification and shows the
// message as one run of text there, where newlines alone do not read as separate items. The banner
// is the only part that has to be readable; the app renders the newlines as a list.
const BULLET = '•'
const MOVED_HEADING = 'Moved to someday'

/**
 * The push: what is due, and anything the pass demoted.
 *
 * Renders what it is given. Whether any of this is worth sending is decided before this, so nothing
 * here can disagree with the counts.
 */
export function buildAlertMessage({
  due,
  demoted,
}: {
  due: readonly DueItem[]
  demoted: readonly DemotedItem[]
}): AlertMessage {
  const dueLines = due.map(item => `${BULLET} ${item.title}`)
  const tail =
    demoted.length === 0
      ? []
      : [
          ...(dueLines.length > 0 ? [''] : []),
          `${MOVED_HEADING}:`,
          ...demoted.map(item => `${BULLET} ${item.title}, untouched ${item.untouchedDays} days`),
        ]

  // With nothing due, the push exists only to announce the demotion, so the title says so rather
  // than counting to zero.
  const title = due.length === 0 ? `${MOVED_HEADING} (${demoted.length})` : `Due (${due.length})`

  return {
    title,
    message: fitMessage({ dueLines, tail }),
  }
}

// Whole lines are dropped from the end of the due list until the message fits, and the count that
// went is named. The demotion lines are never dropped: they are the only place that news appears.
function fitMessage({ dueLines, tail }: { dueLines: string[]; tail: string[] }): string {
  const full = [...dueLines, ...tail].join('\n')
  if (dueLines.length === 0 || byteLength(full) <= MESSAGE_LIMIT) return full

  for (let kept = dueLines.length - 1; kept > 0; kept -= 1) {
    const candidate = withOverflow({ dueLines, kept, tail })
    if (byteLength(candidate) <= MESSAGE_LIMIT) return candidate
  }

  return withOverflow({ dueLines, kept: 0, tail })
}

function withOverflow({
  dueLines,
  kept,
  tail,
}: {
  dueLines: string[]
  kept: number
  tail: string[]
}): string {
  return [
    ...dueLines.slice(0, kept),
    `${BULLET} and ${dueLines.length - kept} more`,
    ...tail,
  ].join('\n')
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks/src/alert-message.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/tasks/src/alert-message.ts apps/tasks/src/alert-message.test.ts
git commit -m "feat(tasks): render the due-date push

Bulleted items, no HTML: Pushover strips tags from the notification, which
is the only part that has to be readable. Over the 1024-byte limit whole
items are dropped and counted, so nothing is cut mid-title.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: The Pushover client

**Files:**
- Create: `apps/tasks/src/pushover/schemas.ts`, `apps/tasks/src/pushover/client.ts`
- Test: `apps/tasks/src/pushover/client.test.ts`

**Interfaces:**
- Consumes: `AppError`, `isRetryableHttpStatus` from `@personal-automation/common/errors`; `withRetry` from `@personal-automation/common/retry`; `setupMswServer` from `@personal-automation/common/test-msw` (test only).
- Produces: `type PushoverMessage = { title: string; message: string; url: string; urlTitle: string }`; `type PushoverClient = { send: (message: PushoverMessage) => Promise<{ requestId: string }> }`; `createPushoverClient({ token, userKey }): PushoverClient`.

- [ ] **Step 1: Write the failing tests**

Create `apps/tasks/src/pushover/client.test.ts`:

```ts
import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import { expect, it } from 'vitest'
import { createPushoverClient } from './client.js'

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json'
const server = setupMswServer()

function client() {
  return createPushoverClient({ token: 'app-token', userKey: 'user-key' })
}

function message() {
  return {
    title: 'Due (1)',
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
    title: 'Due (1)',
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

      return HttpResponse.json({ status: 0, errors: ['application token is invalid'] }, { status: 400 })
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/pushover/client.test.ts`
Expected: FAIL, cannot resolve `./client.js`.

- [ ] **Step 3: Write the schema**

Create `apps/tasks/src/pushover/schemas.ts`:

```ts
import { z } from 'zod'

/**
 * Pushover's reply to an accepted message. `status: 1` is the only success it sends; a refusal
 * arrives as a 4xx carrying an `errors` array, which the client turns into a failure before this
 * parses anything.
 */
export const pushoverResponseSchema = z.object({
  status: z.literal(1),
  request: z.string().min(1),
})

export type PushoverResponse = z.infer<typeof pushoverResponseSchema>
```

- [ ] **Step 4: Write the client**

Create `apps/tasks/src/pushover/client.ts`:

```ts
import { AppError, isRetryableHttpStatus } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import { pushoverResponseSchema } from './schemas.js'

const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json'
const REQUEST_TIMEOUT_MS = 10_000
// Normal priority: one banner, one sound, no repeat. Two passes a day are the redundancy, and a
// task ticked in Obsidian drops off the next pass on its own.
const PRIORITY = '0'

export type PushoverMessage = {
  title: string
  message: string
  /** Opened when the notification is tapped. Custom schemes (obsidian://) are allowed. */
  url: string
  urlTitle: string
}

export type PushoverClient = {
  send: (message: PushoverMessage) => Promise<{ requestId: string }>
}

/**
 * Pushover, the channel the due-date alerts go out on.
 *
 * A refusal throws rather than being logged and swallowed. A meds alert that vanishes quietly is
 * the worst outcome this job has, so the run exits non-zero and the launchd wrapper posts a macOS
 * notification about it.
 */
export function createPushoverClient({
  token,
  userKey,
}: {
  token: string
  userKey: string
}): PushoverClient {
  async function send({
    title,
    message,
    url,
    urlTitle,
  }: PushoverMessage): Promise<{ requestId: string }> {
    return await withRetry(async () => {
      const res = await fetch(PUSHOVER_MESSAGES_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token,
          user: userKey,
          title,
          message,
          url,
          url_title: urlTitle,
          priority: PRIORITY,
        }),
      })
      if (!res.ok) {
        throw new AppError({
          message: `Pushover refused the alert: ${res.status} ${await res.text()}`,
          retryable: isRetryableHttpStatus(res.status),
        })
      }

      return { requestId: pushoverResponseSchema.parse(await res.json()).request }
    })
  }

  return { send }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks/src/pushover/client.test.ts`
Expected: PASS, 3 tests, the last taking about a second.

- [ ] **Step 6: Commit**

```bash
git add apps/tasks/src/pushover
git commit -m "feat(tasks): post the alert to Pushover

Priority 0 and no repeat: two passes a day are the redundancy. A refusal
throws, so a dropped alert surfaces as a failed run rather than silence.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: A rewrite the clock does not read as a touch

**Files:**
- Modify: `apps/tasks/src/state/touch-clock.ts` (add `recordFingerprint`, rewrite `recordTouch`'s doc comment at `:110-116`)
- Modify: `apps/tasks/src/commands/task-io.ts` (add `fingerprintFor` after `touchFor` at `:199-216`)
- Modify: `docs/task-state-model.md:98-100`
- Test: `apps/tasks/src/state/touch-clock.test.ts` (add cases)

**Interfaces:**
- Produces: `recordFingerprint({ clock, key, fingerprint }): TouchClock`; `fingerprintFor({ clock, task, after }): TouchClock`. Task 7 calls `fingerprintFor` after each demotion write.

Why this exists: `reconcileTouchClock` stamps `now` on any task whose fingerprint changed, so the demotion's rewrite would make the *next* pass read it as a touch. Storing the new line's fingerprint against the old timestamp keeps the stored age honest.

- [ ] **Step 1: Write the failing tests**

Add to `apps/tasks/src/state/touch-clock.test.ts` (match the file's existing import style and helpers; add `recordFingerprint` to the import from `./touch-clock.js`):

```ts
describe('recordFingerprint', () => {
  it('takes the new line without moving the timestamp', () => {
    const key = touchKey({ list: 'todos', title: 'book india flights' })
    const clock = recordTouch({
      clock: emptyTouchClock(),
      key,
      fingerprint: fingerprintOf('- [ ] book india flights #active'),
      now: new Date('2026-07-01T12:00:00Z'),
    })

    const updated = recordFingerprint({
      clock,
      key,
      fingerprint: fingerprintOf('- [ ] book india flights #someday'),
    })

    expect(updated.tasks[key]).toEqual({
      fingerprint: fingerprintOf('- [ ] book india flights #someday'),
      lastTouched: '2026-07-01T12:00:00.000Z',
    })
  })

  // Unreachable through decay, which needs an age the clock can supply. Storing an invented
  // timestamp would be worse than storing nothing.
  it('leaves a clock that has never seen the task alone', () => {
    const clock = emptyTouchClock()

    expect(recordFingerprint({ clock, key: 'missing', fingerprint: 'sha256:x' })).toEqual(clock)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/state/touch-clock.test.ts`
Expected: FAIL, `recordFingerprint` is not exported.

- [ ] **Step 3: Add `recordFingerprint` and correct `recordTouch`'s doc comment**

In `apps/tasks/src/state/touch-clock.ts`, replace the last two sentences of `recordTouch`'s doc comment ("Promoting and scheduling are touches. Decay is not: the task is terminal by the time it decays.") with:

```ts
 * Used when this app writes a state change itself, rather than waiting to infer the touch from the
 * next run's fingerprint. Promoting and scheduling are touches. Decay is not, because the user did
 * not touch it: stamping it would hide how long the task had been ignored. Decay uses
 * `recordFingerprint` instead.
```

Add after `recordTouch`:

```ts
/**
 * The clock with one task's fingerprint replaced and its timestamp carried forward.
 *
 * This is how a rewrite that is not a touch stays that way. `reconcileTouchClock` stamps `now` on
 * any task whose fingerprint has changed, so demoting a task by rewriting its line would make the
 * next pass read the demotion as work the user did.
 *
 * A key the clock has never seen is left absent rather than invented: nothing that rewrites a line
 * here can reach a task the clock does not already hold.
 */
export function recordFingerprint({
  clock,
  key,
  fingerprint,
}: {
  clock: TouchClock
  key: string
  fingerprint: string
}): TouchClock {
  const stored = clock.tasks[key]
  if (!stored) return clock

  return {
    version: VERSION,
    tasks: { ...clock.tasks, [key]: { fingerprint, lastTouched: stored.lastTouched } },
  }
}
```

- [ ] **Step 4: Add `fingerprintFor` to task-io.ts**

In `apps/tasks/src/commands/task-io.ts`, add `recordFingerprint` to the import from `../state/touch-clock.js` and add this after `touchFor`:

```ts
/**
 * The clock with this task's fingerprint moved to the line as just written, and its timestamp left
 * where it was.
 *
 * For a rewrite the user did not ask for, which today means decay. Without it the next scan would
 * read the app's own edit as a touch and reset the age it was judging.
 */
export function fingerprintFor({
  clock,
  task,
  after,
}: {
  clock: TouchClock
  task: ScannedTask
  after: string
}): TouchClock {
  return recordFingerprint({
    clock,
    key: keyOf(task),
    fingerprint: fingerprintOf(rawOf({ lineText: after, notes: task.notes })),
  })
}
```

- [ ] **Step 5: Correct the model doc**

In `docs/task-state-model.md`, replace lines 98 to 100 with:

```markdown
When the app writes a state change itself, it records the touch directly rather than waiting to
infer it from the next run's fingerprint. Promotion and scheduling count as touches. Decay does not,
because the user did not touch it: stamping it would hide how long the task had been ignored. The
decay write therefore stores the rewritten line's fingerprint against the timestamp already held, so
the next run reads the line as unchanged.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks/src/state/touch-clock.test.ts apps/tasks/src/commands`
Expected: PASS, including the 2 new cases.

- [ ] **Step 7: Commit**

```bash
git add apps/tasks/src/state/touch-clock.ts apps/tasks/src/state/touch-clock.test.ts apps/tasks/src/commands/task-io.ts docs/task-state-model.md
git commit -m "feat(tasks): let the clock take a rewrite that was not a touch

reconcileTouchClock stamps now on any changed fingerprint, so a demotion
would read as work the user did on the next pass. Storing the new line
against the old timestamp keeps the age honest.

The doc comment and docs/task-state-model.md both gave the wrong reason for
decay not being a touch (they said the task is terminal by then). The reason
is that the user did not touch it.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: The alert command

**Files:**
- Create: `apps/tasks/src/commands/alert.ts`
- Modify: `apps/tasks/src/config.ts`, `apps/tasks/src/constants.ts`, `apps/tasks/.env`, `apps/tasks/.env.example`, `apps/tasks/src/run.e2e.test.ts:85-103`
- Test: `apps/tasks/src/commands/alert.e2e.test.ts`

**Interfaces:**
- Consumes: `dueForAlert` (Task 1), `decayed` (Task 2), `buildAlertMessage`, `DemotedItem`, `DueItem` (Task 3), `createPushoverClient`, `PushoverClient` (Task 4), `fingerprintFor` (Task 5), plus `withTaskClock`, `toCandidate`, `notEditable`, `writeTaskLine` from `./task-io.js`, `withStateTag` from `../tasks/obsidian/tags.js`, `untouchedDays` from `../state/stall.js`, `defaultTouchClockPath` from `../state/touch-clock.js`.
- Produces: `type AlertOptions = { dryRun: boolean }`; `type AlertResult = { kind: 'silent'; reason: 'nothing_due' } | { kind: 'dry_run'; title: string; message: string; dueCount: number; demotedCount: number } | { kind: 'sent'; requestId: string; dueCount: number; demotedCount: number }`; `runAlert({ config, scopes, opts, now?, clockPath?, pushover?, logger? }): Promise<AlertResult>`. Task 7 renders `AlertResult` and Task 8 needs nothing from it.
- Config gains: `dueAlertDays: number`, `alertUrl: string`, `pushoverToken: string`, `pushoverUserKey: string`.

`PUSHOVER_TOKEN` and `PUSHOVER_USER_KEY` are already in the monorepo-root `.env` and `.env.example`. They become required for every `tasks` command, which is correct: the app cannot run its schedule without them.

- [ ] **Step 1: Add the config and the constant**

In `apps/tasks/src/config.ts`, add to the schema after `TASKS_OVERRIDE_LIMIT`:

```ts
  TASKS_DUE_ALERT_DAYS: z.coerce.number().pipe(z.int().positive()),
  TASKS_ALERT_URL: z.string().min(1),
  PUSHOVER_TOKEN: z.string().min(1),
  PUSHOVER_USER_KEY: z.string().min(1),
```

Add to the `Config` type:

```ts
  /**
   * Days a dated one-off task keeps being pushed about, counting the due day. Recurring tasks
   * ignore it: an unticked chore is asked about every day until it is ticked.
   */
  dueAlertDays: number
  /** Where tapping the push lands. Held whole rather than composed, so it matches what was tested. */
  alertUrl: string
  pushoverToken: string
  pushoverUserKey: string
```

Add to the returned object in `loadConfig`:

```ts
    dueAlertDays: parsed.TASKS_DUE_ALERT_DAYS,
    alertUrl: parsed.TASKS_ALERT_URL,
    pushoverToken: parsed.PUSHOVER_TOKEN,
    pushoverUserKey: parsed.PUSHOVER_USER_KEY,
```

Update the comment at the top of `config.ts` (`:6-8`) so it names both schedule settings:

```ts
// TASKS_SCHEDULE (the review's days/times) and TASKS_ALERT_TIMES (the alert's times) aren't here:
// both are consumed only by the launchd plist generator at setup time, not at app runtime. launchd
// fires each job on its own schedule, so neither has a day-gate of its own: when invoked, it runs.
```

In `apps/tasks/src/constants.ts`, add:

```ts
/** The label under the push's tap target. Pushover shows it beside the link. */
export const ALERT_URL_TITLE = 'Open the dashboard'
```

Append to `apps/tasks/.env`:

```bash
# Days a dated one-off task keeps being pushed about, counting the due day. After that the
# twice-weekly review takes over. Recurring (🔁) tasks ignore this: an unticked chore is asked
# about every day it is late, because the Tasks plugin only rolls its date forward on the tick.
TASKS_DUE_ALERT_DAYS=7

# When the due-date alert runs: JSON array of "HH:MM" (24-hour), every day. The morning pass is
# easy to dismiss half-asleep, so the evening one names what is still not done. Re-run
# launchd/setup.sh after changing it.
TASKS_ALERT_TIMES=["08:00", "19:00"]

# Where tapping the push lands. The dashboard rather than todos.md, because that is the view
# actually read, and opening Obsidian puts the other active tasks in front of you.
TASKS_ALERT_URL=obsidian://open?vault=iphone&file=Todos/Dashboard.md
```

Append the same three to `apps/tasks/.env.example`, with `TASKS_ALERT_URL=obsidian://open?vault=<your vault name>&file=<your dashboard>.md`.

In `apps/tasks/src/run.e2e.test.ts`, add to `makeConfig`'s literal (`:85`):

```ts
    dueAlertDays: 7,
    alertUrl: 'obsidian://open?vault=test&file=Todos/Dashboard.md',
    pushoverToken: 'test-pushover-token',
    pushoverUserKey: 'test-pushover-user',
```

- [ ] **Step 2: Verify the existing suite still typechecks and passes**

Run: `pnpm typecheck && pnpm vitest run apps/tasks`
Expected: PASS. A failure here means a `Config` literal was missed.

- [ ] **Step 3: Write the failing end-to-end tests**

Create `apps/tasks/src/commands/alert.e2e.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import pino from 'pino'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Config } from '../config.js'
import { fingerprintOf, touchKey } from '../state/touch-clock.js'
import { type AlertResult, runAlert } from './alert.js'
import { readOpenTasks } from './task-io.js'

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json'
const NOW = new Date(2026, 7, 20, 8, 0)
// 31 calendar days before NOW, past the 28-day horizon.
const LONG_QUIET = new Date(2026, 6, 20, 8, 0)
const TODOS_FILE = 'Todos/todos.md'
const SCOPES = [TODOS_FILE]
const silentLogger = pino({ level: 'silent' })

const server = setupMswServer()

let vaultPath: string
let runsDir: string
let clockPath: string

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), 'tasks-vault-'))
  runsDir = mkdtempSync(join(tmpdir(), 'tasks-runs-'))
  clockPath = join(runsDir, 'touch-clock.json')
  mkdirSync(join(vaultPath, 'Todos'))
})

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true })
  rmSync(runsDir, { recursive: true, force: true })
})

function writeTodos(lines: string[]): void {
  writeFileSync(join(vaultPath, TODOS_FILE), `# Todos\n\n${lines.join('\n')}\n`)
}

function readTodos(): string {
  return readFileSync(join(vaultPath, TODOS_FILE), 'utf8')
}

// Stamps the tasks in the file as last touched on a given day, read through the same scanner the
// run uses so identities and fingerprints match. Without it every task reads as touched today.
async function seedClock({
  lastTouched,
  titles,
}: {
  lastTouched: Date
  titles?: string[]
}): Promise<void> {
  const open = await readOpenTasks({ vaultPath, scopes: SCOPES })
  const wanted = titles ? open.filter(task => titles.includes(task.title)) : open
  const seeded = Object.fromEntries(
    wanted.map(task => [
      touchKey({ list: task.list, title: task.title }),
      { fingerprint: fingerprintOf(task.raw), lastTouched: lastTouched.toISOString() },
    ]),
  )
  const stored = existsSync(clockPath) ? readClock().tasks : {}
  writeFileSync(clockPath, JSON.stringify({ version: 1, tasks: { ...stored, ...seeded } }))
}

function readClock(): { tasks: Record<string, { fingerprint: string; lastTouched: string }> } {
  return JSON.parse(readFileSync(clockPath, 'utf8')) as {
    tasks: Record<string, { fingerprint: string; lastTouched: string }>
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    toEmail: 'me@example.com',
    wipCap: 3,
    stallDays: 7,
    horizonDays: 28,
    doneWindowDays: 7,
    overrideWindowDays: 30,
    overrideLimit: 3,
    taskLists: SCOPES,
    obsidianVaultPath: vaultPath,
    model: 'claude-sonnet-5',
    anthropicApiKey: 'test-anthropic-key',
    gmailClientId: 'cid',
    gmailClientSecret: 'secret',
    gmailRefreshToken: 'rtok',
    dueAlertDays: 7,
    alertUrl: 'obsidian://open?vault=iphone&file=Todos/Dashboard.md',
    pushoverToken: 'app-token',
    pushoverUserKey: 'user-key',
    ...overrides,
  }
}

function run(overrides: { config?: Config; dryRun?: boolean } = {}): Promise<AlertResult> {
  return runAlert({
    config: overrides.config ?? makeConfig(),
    scopes: SCOPES,
    opts: { dryRun: overrides.dryRun ?? true },
    now: NOW,
    clockPath,
    logger: silentLogger,
  })
}

function captureSend(): { body: () => Record<string, string> } {
  let received: Record<string, string> = {}
  server.use(
    http.post(PUSHOVER_URL, async ({ request }) => {
      received = Object.fromEntries(new URLSearchParams(await request.text()))

      return HttpResponse.json({ status: 1, request: 'req-1' })
    }),
  )

  return { body: () => received }
}

// No handler is registered in the silent cases: a POST would fail the test through msw.
it('pushes nothing when nothing is due and nothing decayed', async () => {
  writeTodos(['- [ ] book india flights #active', '- [ ] water the plants 📅 2026-08-25'])

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
})

it('pushes nothing about a task that was already ticked', async () => {
  writeTodos(['- [x] give Dolly her meds 🔁 every day 📅 2026-08-19 ✅ 2026-08-19'])

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
})

it('lists what is due, most overdue first', async () => {
  writeTodos([
    '- [ ] water the schefflera 🔁 every week 📅 2026-08-20',
    '- [ ] give Dolly her meds 🔁 every day 📅 2026-08-18',
  ])

  const result = await run()

  expect(result).toMatchObject({ kind: 'dry_run', dueCount: 2, demotedCount: 0 })
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result.title).toBe('Due (2)')
  expect(result.message).toBe('• give Dolly her meds\n• water the schefflera')
})

// Putting a date on something is the reason to want reminding of it, whatever pool it sits in.
it('alerts on a dated #someday task', async () => {
  writeTodos(['- [ ] renew the passport #someday 📅 2026-08-20'])

  expect(await run()).toMatchObject({ kind: 'dry_run', dueCount: 1 })
})

it('sends the push with the deep link and normal priority', async () => {
  writeTodos(['- [ ] give Dolly her meds 🔁 every day 📅 2026-08-20'])
  const sent = captureSend()

  const result = await run({ dryRun: false })

  expect(result).toEqual({ kind: 'sent', requestId: 'req-1', dueCount: 1, demotedCount: 0 })
  expect(sent.body()).toMatchObject({
    title: 'Due (1)',
    message: '• give Dolly her meds',
    url: 'obsidian://open?vault=iphone&file=Todos/Dashboard.md',
    priority: '0',
  })
})

// The machine is dropping a commitment the user did not drop, so the push says so even on a day
// with nothing due, and the tag is rewritten rather than the box being closed.
it('demotes a task nothing has touched for the horizon and announces it', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: LONG_QUIET })
  const sent = captureSend()

  const result = await run({ dryRun: false })

  expect(result).toMatchObject({ kind: 'sent', dueCount: 0, demotedCount: 1 })
  expect(readTodos()).toContain('- [ ] book india flights #someday')
  expect(sent.body()).toMatchObject({
    title: 'Moved to someday (1)',
    message: 'Moved to someday:\n• book india flights, untouched 31 days',
  })
})

// The demotion is this app's own edit, so the age it was judging has to survive it. Without the
// fingerprint update the next pass would read the rewritten line as work the user did.
it('keeps the demoted task at the age it decayed at', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: LONG_QUIET })
  captureSend()

  await run({ dryRun: false })

  const key = touchKey({ list: 'todos', title: 'book india flights' })
  const entry = readClock().tasks[key]
  expect(entry?.lastTouched).toBe(LONG_QUIET.toISOString())
  expect(entry?.fingerprint).toBe(fingerprintOf('- [ ] book india flights #someday'))
})

it('leaves a #someday task and a recurring task where they are', async () => {
  writeTodos([
    '- [ ] hang the shelf #someday',
    '- [ ] water the schefflera 🔁 every week #active',
    '- [ ] fix the gate #active',
  ])
  await seedClock({ lastTouched: LONG_QUIET })

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
  expect(readTodos()).toContain('- [ ] hang the shelf #someday')
  expect(readTodos()).toContain('- [ ] water the schefflera 🔁 every week #active')
  expect(readTodos()).toContain('- [ ] fix the gate #active')
})

// Two state tags on one line is a contradiction nothing here resolves, and every write clears the
// old tags first, so acting on it would throw away whichever one was meant.
it('leaves a line carrying two state tags alone', async () => {
  writeTodos(['- [ ] book india flights #active #someday'])
  await seedClock({ lastTouched: LONG_QUIET })

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
  expect(readTodos()).toContain('- [ ] book india flights #active #someday')
})

it('fails the run when Pushover refuses, rather than reporting a push nobody got', async () => {
  writeTodos(['- [ ] give Dolly her meds 🔁 every day 📅 2026-08-20'])
  server.use(
    http.post(PUSHOVER_URL, () =>
      HttpResponse.json({ status: 0, errors: ['user key is invalid'] }, { status: 400 }),
    ),
  )

  await expect(run({ dryRun: false })).rejects.toThrow(/Pushover refused/)
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/commands/alert.e2e.test.ts`
Expected: FAIL, cannot resolve `./alert.js`.

- [ ] **Step 5: Write the command**

Create `apps/tasks/src/commands/alert.ts`:

```ts
import pino from 'pino'
import {
  type AlertMessage,
  buildAlertMessage,
  type DemotedItem,
  type DueItem,
} from '../alert-message.js'
import type { Config } from '../config.js'
import { ALERT_URL_TITLE } from '../constants.js'
import { createPushoverClient, type PushoverClient } from '../pushover/client.js'
import { decayed } from '../state/decay.js'
import { dueForAlert } from '../state/due.js'
import { untouchedDays } from '../state/stall.js'
import { defaultTouchClockPath, type TouchClock } from '../state/touch-clock.js'
import type { CapCandidate } from '../state/wip.js'
import type { ScannedTask } from '../tasks/obsidian/scan.js'
import { withStateTag } from '../tasks/obsidian/tags.js'
import {
  fingerprintFor,
  notEditable,
  toCandidate,
  withTaskClock,
  writeTaskLine,
} from './task-io.js'

export type AlertOptions = {
  dryRun: boolean
}

export type AlertResult =
  | { kind: 'silent'; reason: 'nothing_due' }
  | {
      kind: 'dry_run'
      title: string
      message: string
      dueCount: number
      demotedCount: number
    }
  | {
      kind: 'sent'
      requestId: string
      dueCount: number
      demotedCount: number
    }

/** A task as both the state model reads it and the vault holds it, so one pass can do both. */
type Aged = CapCandidate & { task: ScannedTask }

/** What one read of the vault produced. */
type Pass = {
  due: DueItem[]
  demoted: DemotedItem[]
}

/**
 * Pushes what is due to the phone, and demotes what has been sitting too long to still call
 * current.
 *
 * Two things the twice-weekly review cannot do. A recurring chore can never reach the review (the
 * cap and the stall rule both exclude it), so a missed dose has no other channel; and an `#active`
 * task nothing touches would otherwise hold its cap slot forever.
 *
 * Silence needs both halves empty. Nothing due and nothing demoted sends nothing, which is what the
 * evening pass usually does.
 */
export async function runAlert({
  config,
  scopes,
  opts,
  now = new Date(),
  clockPath = defaultTouchClockPath(),
  pushover,
  logger = pino({ level: 'info' }),
}: {
  config: Config
  scopes: readonly string[]
  opts: AlertOptions
  now?: Date
  clockPath?: string
  pushover?: PushoverClient
  logger?: pino.Logger
}): Promise<AlertResult> {
  const pass = await withTaskClock<Pass>({
    vaultPath: config.obsidianVaultPath,
    scopes,
    clockPath,
    now,
    act: async ({ open, clock }) => {
      const demotion = await demote({ open, clock, config, now, logger })
      // Read from the same scan the demotion started from. Rewriting a state tag changes neither
      // the due date nor the title, so which half runs first cannot change what is alerted.
      const due = dueForAlert({ tasks: open, dueAlertDays: config.dueAlertDays, now })
      logger.info(
        { open: open.length, due: due.length, demoted: demotion.items.length },
        'Read the vault.',
      )

      return { result: { due, demoted: demotion.items }, clock: demotion.clock }
    },
  })

  if (pass.due.length === 0 && pass.demoted.length === 0) {
    logger.info({}, 'Nothing due and nothing demoted; no push.')

    return { kind: 'silent', reason: 'nothing_due' }
  }

  // Sent after the clock is saved rather than inside the pass: a refused push must not throw away
  // the fingerprint update that keeps a demotion from reading as a touch on the next run.
  const rendered: AlertMessage = buildAlertMessage({ due: pass.due, demoted: pass.demoted })
  if (opts.dryRun) {
    return {
      kind: 'dry_run',
      title: rendered.title,
      message: rendered.message,
      dueCount: pass.due.length,
      demotedCount: pass.demoted.length,
    }
  }

  const client =
    pushover ??
    createPushoverClient({ token: config.pushoverToken, userKey: config.pushoverUserKey })
  const sent = await client.send({
    title: rendered.title,
    message: rendered.message,
    url: config.alertUrl,
    urlTitle: ALERT_URL_TITLE,
  })
  logger.info(
    { requestId: sent.requestId, due: pass.due.length, demoted: pass.demoted.length },
    'Alert sent.',
  )

  return {
    kind: 'sent',
    requestId: sent.requestId,
    dueCount: pass.due.length,
    demotedCount: pass.demoted.length,
  }
}

/**
 * Strips `#active` from every task past the horizon and writes `#someday` in its place, one line at
 * a time.
 *
 * A line that moved while the pass was reading it is skipped and picked up next time, rather than
 * failing the run: the push still has to go out.
 */
async function demote({
  open,
  clock,
  config,
  now,
  logger,
}: {
  open: ScannedTask[]
  clock: TouchClock
  config: Config
  now: Date
  logger: pino.Logger
}): Promise<{ clock: TouchClock; items: DemotedItem[] }> {
  const aged: Aged[] = open.map(task => ({ ...toCandidate({ task, clock }), task }))
  const items: DemotedItem[] = []
  let updated = clock

  for (const entry of decayed({ tasks: aged, horizonDays: config.horizonDays, now })) {
    const { task } = entry
    // Decay already requires open, `#active` and non-recurring, so the only refusal reachable here
    // is a line carrying two state tags.
    const blocked = notEditable(task)
    if (blocked) {
      logger.warn(
        { title: task.title, path: task.path, line: task.lineNumber },
        'Left where it is: the line carries more than one state tag.',
      )
      continue
    }
    // Unreachable: a task the clock has never seen never decays. Narrowed rather than defaulted, so
    // no invented day count can reach the push.
    const quietDays = untouchedDays({ task: entry, now })
    if (quietDays === undefined) continue

    const after = withStateTag({ line: task.lineText, state: 'someday' })
    if (!(await writeTaskLine({ vaultPath: config.obsidianVaultPath, task, after }))) {
      logger.warn(
        { title: task.title, path: task.path },
        'Left where it is: the line moved while the pass was reading it. The next pass picks it up.',
      )
      continue
    }

    items.push({ title: task.title, untouchedDays: quietDays })
    updated = fingerprintFor({ clock: updated, task, after })
  }

  return { clock: updated, items }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks/src/commands/alert.e2e.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/tasks/src/commands/alert.ts apps/tasks/src/commands/alert.e2e.test.ts apps/tasks/src/config.ts apps/tasks/src/constants.ts apps/tasks/src/run.e2e.test.ts apps/tasks/.env.example
git commit -m "feat(tasks): push what is due, and demote what has gone cold

One pass over the vault does both halves under the edit lock: the review can
never mention a missed chore, and an #active task nothing touches would hold
its cap slot forever. Silence needs both halves empty.

The push is sent after the clock is saved, so a refused POST cannot throw
away the fingerprint update that keeps the demotion from reading as a touch.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Note: `apps/tasks/.env` is gitignored, so it is edited but never staged.

---

### Task 7: Wire the command into the CLI

**Files:**
- Modify: `apps/tasks/src/cli-args.ts:4-38`, `apps/tasks/src/locks.ts:24-39`, `apps/tasks/src/index.ts`
- Test: `apps/tasks/src/cli-args.test.ts`, `apps/tasks/src/locks.test.ts`

**Interfaces:**
- Consumes: `AlertResult`, `runAlert` from `./commands/alert.js`.
- Produces: `Args` gains `{ command: 'alert'; dryRun: boolean }`.

`alert` takes `tasks-edit.lock`, the same lock the one-line commands use, because it writes single lines the same way. It deliberately does not take `tasks.lock`: the review holds that one for the length of a model call, and a due-date push must not wait behind it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/tasks/src/cli-args.test.ts`:

```ts
it('parses alert', () => {
  expect(parseArgs(['alert'])).toEqual({ command: 'alert', dryRun: false })
  expect(parseArgs(['alert', '--dry-run'])).toEqual({ command: 'alert', dryRun: true })
})

it('rejects an unknown flag on alert', () => {
  expect(() => parseArgs(['alert', '--force'])).toThrow(/Unknown argument: --force/)
})
```

Add to `apps/tasks/src/locks.test.ts` (match the assertions the file already makes about which lock a command takes):

```ts
// The push writes single lines the same way promote and abandon do, and must not wait behind a
// review holding tasks.lock for the length of a model call.
it('puts alert on the edit lock', () => {
  expect(lockPathFor('alert')).toBe(lockPathFor('promote'))
  expect(lockPathFor('alert')).not.toBe(lockPathFor('digest'))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/cli-args.test.ts apps/tasks/src/locks.test.ts`
Expected: FAIL, `Unknown command: alert`.

- [ ] **Step 3: Add the command to the parser and the lock table**

In `apps/tasks/src/cli-args.ts`, add to the `Args` union after the `digest` member:

```ts
  | { command: 'alert'; dryRun: boolean }
```

and add to the switch, next to `digest`:

```ts
    case 'alert':
      assertKnownFlags({ rest, known: ['--dry-run'] })

      return { command: 'alert', dryRun: rest.includes('--dry-run') }
```

In `apps/tasks/src/locks.ts`, add `case 'alert':` to the group returning `EDIT_LOCK`, and extend that constant's doc comment with:

```ts
 * The alert takes it too: it writes single lines the same way, and a due-date push must not wait
 * behind a review holding the run lock for the length of a model call.
```

- [ ] **Step 4: Dispatch it in index.ts**

Add to the imports:

```ts
import { type AlertResult, runAlert } from './commands/alert.js'
```

Add to `printHelp`, after the `digest` block:

```text
  alert               Push what is due to the phone, and move any
                      #active task untouched for TASKS_HORIZON_DAYS to
                      #someday. Pushes nothing when both are empty.
    --dry-run         Print the push to the console instead of sending
```

Add the result printer beside `logDigestResult`:

```ts
function logAlertResult(result: AlertResult): void {
  switch (result.kind) {
    case 'silent':
      console.log('Nothing is due and nothing has gone cold. No push.')
      break
    case 'dry_run':
      console.log(`\n${result.title}\n\n${result.message}\n`)
      console.log(
        `[dry run] ${result.dueCount} due, ${result.demotedCount} moved to someday. Not sent.`,
      )
      break
    case 'sent':
      console.log(
        `Pushed: ${result.dueCount} due, ${result.demotedCount} moved to someday (request_id=${result.requestId}).`,
      )
      break
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled alert result: ${JSON.stringify(_exhaustive)}` })
    }
  }
}
```

Add the dispatch inside `runWithLock`'s `run`, after the `digest` branch:

```ts
      if (args.command === 'alert') {
        logAlertResult(await runAlert({ config, scopes: configured, opts: { dryRun: args.dryRun } }))

        return
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/tasks && pnpm typecheck`
Expected: PASS. `tsc` proves the `lockPathFor` switch is exhaustive over the new `Args` member.

- [ ] **Step 6: Check the command by hand against a copy of the vault**

```bash
cp -R "$OBSIDIAN_VAULT_PATH" /tmp/vault-alert-check
OBSIDIAN_VAULT_PATH=/tmp/vault-alert-check pnpm --filter @personal-automation/tasks tasks alert --dry-run
```

Expected: either the silent line or a rendered title and message. Nothing is sent, and the real vault is untouched. Read the output for em dashes and for anything that reads as an accusation.

- [ ] **Step 7: Commit**

```bash
git add apps/tasks/src/cli-args.ts apps/tasks/src/cli-args.test.ts apps/tasks/src/locks.ts apps/tasks/src/locks.test.ts apps/tasks/src/index.ts
git commit -m "feat(tasks): add the alert command to the CLI

It takes tasks-edit.lock, not the review's tasks.lock: a due-date push must
not wait behind a model call, and it writes single lines the same way
promote and abandon do.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: The launchd agent

**Files:**
- Modify: `apps/tasks/src/schedule.ts`, `apps/tasks/src/generate-launchd-plist.ts`, `launchd/setup.sh`, `launchd/newsyslog.personal-automation.conf.template`
- Create: `launchd/run-tasks-alert.sh`
- Test: `apps/tasks/src/schedule.test.ts`

**Interfaces:**
- Produces: `type TimeSlot = { hour: number; minute: number }`; `parseAlertTimes(entries: readonly string[]): TimeSlot[]`; `buildTasksAlertPlist({ projectDir, times }): string`.

One agent covers both passes, because they run identical arguments: a plist's `StartCalendarInterval` can list many times, and an entry with no `Weekday` fires every day.

- [ ] **Step 1: Write the failing tests**

Add to `apps/tasks/src/schedule.test.ts` (add `buildTasksAlertPlist` and `parseAlertTimes` to the import):

```ts
describe('parseAlertTimes', () => {
  it('parses 24-hour times', () => {
    expect(parseAlertTimes(['08:00', '19:30'])).toEqual([
      { hour: 8, minute: 0 },
      { hour: 19, minute: 30 },
    ])
  })

  it('rejects an empty list', () => {
    expect(() => parseAlertTimes([])).toThrow(AppError)
  })

  it('rejects a time that is not HH:MM', () => {
    expect(() => parseAlertTimes(['8am'])).toThrow(/8am/)
  })

  it('rejects an hour or minute out of range', () => {
    expect(() => parseAlertTimes(['24:00'])).toThrow(/24:00/)
    expect(() => parseAlertTimes(['08:60'])).toThrow(/08:60/)
  })
})

describe('buildTasksAlertPlist', () => {
  it('fires every day at each time, with no weekday', () => {
    const plist = buildTasksAlertPlist({
      projectDir: '/Users/me/personal-automation',
      times: [
        { hour: 8, minute: 0 },
        { hour: 19, minute: 0 },
      ],
    })

    expect(plist).toContain('<string>com.personal-automation.tasks-alert</string>')
    expect(plist).toContain('/Users/me/personal-automation/launchd/run-tasks-alert.sh')
    expect(plist).toContain('<key>Hour</key><integer>8</integer>')
    expect(plist).toContain('<key>Hour</key><integer>19</integer>')
    expect(plist).not.toContain('Weekday')
    expect(plist).toContain('launchd/logs/tasks-alert.err.log')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/tasks/src/schedule.test.ts`
Expected: FAIL, `parseAlertTimes` is not exported.

- [ ] **Step 3: Add the parser and the plist builder**

Add to `apps/tasks/src/schedule.ts`:

```ts
/** A time of day the alert fires, every day. */
export type TimeSlot = {
  hour: number
  minute: number
}

/**
 * Parses `TASKS_ALERT_TIMES` entries like "08:00" into launchd calendar slots. No day: the alert
 * runs every day, so an entry carries a time and nothing else.
 */
export function parseAlertTimes(entries: readonly string[]): TimeSlot[] {
  if (entries.length === 0) {
    throw new AppError({
      message: 'TASKS_ALERT_TIMES is empty. Add at least one "HH:MM" entry.',
    })
  }

  return entries.map(parseTime)
}

function parseTime(entry: string): TimeSlot {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(entry)
  if (!match) {
    throw new AppError({
      message: `Invalid alert time "${entry}". Expected 24-hour HH:MM, e.g. "08:00".`,
    })
  }
  const [, hourRaw = '', minuteRaw = ''] = match
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (hour > 23 || minute > 59) {
    throw new AppError({ message: `Invalid alert time "${entry}". Use 00:00 to 23:59.` })
  }

  return { hour, minute }
}

/**
 * Builds the launchd agent plist for the due-date alert. One agent covers every pass: they run the
 * same command with the same arguments, and a `StartCalendarInterval` entry with no `Weekday` fires
 * every day.
 */
export function buildTasksAlertPlist({
  projectDir,
  times,
}: {
  projectDir: string
  times: TimeSlot[]
}): string {
  const intervals = times
    .map(
      slot => `    <dict>
      <key>Hour</key><integer>${slot.hour}</integer>
      <key>Minute</key><integer>${slot.minute}</integer>
    </dict>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
${PLIST_DOCTYPE}
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.personal-automation.tasks-alert</string>

    <key>ProgramArguments</key>
    <array>
        <string>${projectDir}/launchd/run-tasks-alert.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>

    <key>StandardOutPath</key>
    <string>${projectDir}/launchd/logs/tasks-alert.out.log</string>
    <key>StandardErrorPath</key>
    <string>${projectDir}/launchd/logs/tasks-alert.err.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`
}
```

- [ ] **Step 4: Emit both plists**

Rewrite `main()` in `apps/tasks/src/generate-launchd-plist.ts`:

```ts
function main(): void {
  const projectDir = resolveWorkspaceRoot(import.meta.url)
  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const scheduleEntries = jsonValue.pipe(z.array(z.string())).parse(process.env['TASKS_SCHEDULE'])
  const schedule = parseSchedule(scheduleEntries)
  const digestPath = join(projectDir, 'launchd', 'com.personal-automation.tasks.plist')
  writeFileSync(digestPath, buildTasksDigestPlist({ projectDir, schedule }))
  console.log(`Generated ${digestPath}`)
  for (const slot of schedule) {
    console.log(`  • ${slot.day} ${hhmm(slot)}`)
  }

  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const timeEntries = jsonValue.pipe(z.array(z.string())).parse(process.env['TASKS_ALERT_TIMES'])
  const times = parseAlertTimes(timeEntries)
  const alertPath = join(projectDir, 'launchd', 'com.personal-automation.tasks-alert.plist')
  writeFileSync(alertPath, buildTasksAlertPlist({ projectDir, times }))
  console.log(`Generated ${alertPath}`)
  for (const slot of times) {
    console.log(`  • every day ${hhmm(slot)}`)
  }
}

function hhmm({ hour, minute }: { hour: number; minute: number }): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
```

Update the import to `import { buildTasksAlertPlist, buildTasksDigestPlist, parseAlertTimes, parseSchedule } from './schedule.js'` and the file's top comment to say it reads `TASKS_SCHEDULE` and `TASKS_ALERT_TIMES` and writes both agents.

- [ ] **Step 5: Write the launchd wrapper**

Create `launchd/run-tasks-alert.sh`:

```bash
#!/usr/bin/env bash
# launchd wrapper for the due-date alert. Its own agent
# (com.personal-automation.tasks-alert) fires it at each time in TASKS_ALERT_TIMES, every day.
# Posts a macOS notification on failure so a dropped alert isn't silent. Same failure-surfacing as
# run.sh.

set -u
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

err_log="$(mktemp -t personal-automation-tasks-alert.XXXXXX)"
trap 'rm -f "$err_log"' EXIT

/bin/zsh -lc "pnpm --filter @personal-automation/tasks tasks alert" 2> >(tee -a "$err_log" >&2)
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  last_err="$(tail -3 "$err_log" | tr '\n' ' ' | sed 's/"/\\"/g')"
  /usr/bin/osascript \
    -e "display notification \"${last_err:-See $PROJECT_DIR/launchd/logs/tasks-alert.err.log}\" with title \"Task alert FAILED (exit $exit_code)\" sound name \"Basso\""
fi

exit "$exit_code"
```

Then `chmod +x launchd/run-tasks-alert.sh`.

- [ ] **Step 6: Add the agent to setup.sh and the log rotation**

In `launchd/setup.sh`, change the generation comment and the printed instructions to cover four agents: add `com.personal-automation.tasks-alert.plist` to the `cp` and `launchctl bootstrap` lists, and extend the "Changed TASKS_SCHEDULE later?" block to say "Changed TASKS_SCHEDULE or TASKS_ALERT_TIMES later?" with the matching `bootout`/`cp`/`bootstrap` lines for the alert agent.

In `launchd/newsyslog.personal-automation.conf.template`, add beneath the digest rows:

```text
{{PROJECT_DIR}}/launchd/logs/tasks-alert.out.log    {{USERNAME}}:staff  644  4  1024  $W0  Z
{{PROJECT_DIR}}/launchd/logs/tasks-alert.err.log    {{USERNAME}}:staff  644  4  1024  $W0  Z
```

- [ ] **Step 7: Generate the plists and check them**

```bash
./launchd/setup.sh
grep -c "<key>Hour</key>" launchd/com.personal-automation.tasks-alert.plist   # expect 2
grep "Weekday" launchd/com.personal-automation.tasks-alert.plist              # expect no output
plutil -lint launchd/com.personal-automation.tasks-alert.plist                # expect OK
```

Both plists stay out of git: `.gitignore` already carries `launchd/*.plist`.

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run apps/tasks/src/schedule.test.ts && pnpm typecheck`
Expected: PASS, including the 5 new cases.

- [ ] **Step 9: Commit**

```bash
git add apps/tasks/src/schedule.ts apps/tasks/src/schedule.test.ts apps/tasks/src/generate-launchd-plist.ts launchd/run-tasks-alert.sh launchd/setup.sh launchd/newsyslog.personal-automation.conf.template
git commit -m "feat(tasks): a launchd agent for the due-date alert

One agent covers both passes: they run identical arguments, and a
StartCalendarInterval entry with no Weekday fires every day. The wrapper
posts a macOS notification on a non-zero exit, like the other three.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Document it

**Files:**
- Modify: `README.md` (the `## tasks` section at `:96-110`, and `## Production` at `:112-137`), `docs/task-state-model.md`

The correction to `docs/task-state-model.md:98-100` landed in Task 5. This task adds what the model doc is missing: the alert rule and the decay behavior as built.

- [ ] **Step 1: Add the alert and decay sections to the model doc**

In `docs/task-state-model.md`, add a `## Due-date alerts` section after `## The review`, saying:

- The rule: open, dated, and the date has arrived or gone by. State tags are not read, so a dated `#someday` task alerts like a dated `#active` one.
- Recurring tasks are in scope here and nowhere else in the model. The cap, the stall rule and decay all exclude them, so a missed chore has no other channel. Name the asymmetry that is now closed: the review already reported recurring tasks that were completed.
- The taper: `TASKS_DUE_ALERT_DAYS` for one-off tasks, no limit for recurring ones, and why (the Tasks plugin rolls the date forward only on a tick).
- Two passes a day, both the same query, silent on an empty list. The evening one names what is still not done.
- The channel: Pushover, priority 0, the message carries no HTML, items separated by `•`, and the deep link opens `Todos/Dashboard.md`.
- Nothing is written by this half.

Add a `## Decay` section after it:

- An `#active`, non-recurring, open task untouched for `TASKS_HORIZON_DAYS` has `#active` stripped and `#someday` written, and its cap slot is freed. `tasks promote` puts it back.
- Why demote rather than close the box: the machine must not drop a commitment the user never agreed to drop, and terminal states refuse every command.
- Why it is announced in the push rather than held for the review: the user learns it when it happens, on the channel they read.
- It runs on both passes, and the evening one is a no-op because the morning already rewrote the tag.
- A line with two state tags is skipped, and so is a line that moved while the pass was reading it.

Add `TASKS_DUE_ALERT_DAYS` to the thresholds table at `:131`:

```markdown
| `TASKS_DUE_ALERT_DAYS` | 7 | Days a dated one-off task keeps being pushed about. Recurring tasks ignore it. |
```

- [ ] **Step 2: Update the README**

In the `## tasks` section, add a paragraph after the review paragraphs covering: the daily alert at the `TASKS_ALERT_TIMES` times, that it pushes through Pushover with a deep link into `Todos/Dashboard.md`, that recurring chores are the case it exists for since the review can never mention one, the taper for one-off tasks, and that the same job demotes an `#active` task untouched for `TASKS_HORIZON_DAYS` to `#someday` and says so in the push.

In `## Production`, change "Three launchd agents" to four and add:

```markdown
- `com.personal-automation.tasks-alert` runs `launchd/run-tasks-alert.sh` at each time in `TASKS_ALERT_TIMES`, every day: the due-date push, and the decay pass that goes with it.
```

Add the plist to the three `cp` and `launchctl bootstrap` lines in the code block, and extend the sentence about re-running `setup.sh` so it names `TASKS_ALERT_TIMES` as well as `TASKS_SCHEDULE`. Add the alert agent to the `launchctl list` sample output in `## Checking status`.

- [ ] **Step 3: Check the prose**

```bash
rg -n "—" README.md docs/task-state-model.md   # expect no output
```

Read both changed sections once for vague words: name the setting, the count, the file.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/task-state-model.md
git commit -m "docs: the due-date alert and what decay does

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Gates, then the real channel

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Run the whole gate**

```bash
pnpm check && pnpm typecheck && pnpm test
```

Expected: Biome clean, `tsc -b` clean, every test passing. Read the failures rather than the summary if any of the three is red.

- [ ] **Step 2: Check coverage against the 80/80/80/75 gate**

```bash
pnpm vitest run --coverage 2>&1 | tail -30
```

Expected: lines, functions and statements at or above 80, branches at or above 75. If a new file drags it down, the gap is a missing test, not a threshold to lower.

- [ ] **Step 3: Dry run against a copy of the real vault**

```bash
rm -rf /tmp/vault-alert-check && cp -R "$OBSIDIAN_VAULT_PATH" /tmp/vault-alert-check
OBSIDIAN_VAULT_PATH=/tmp/vault-alert-check pnpm --filter @personal-automation/tasks tasks alert --dry-run
git -C /tmp/vault-alert-check diff --stat
```

Expected: the rendered push (or the silent line), and no writes, since a dry run still demotes nothing only if nothing has decayed. If the diff shows a demotion, that is the decay half working: check the rewritten line carries `#someday`, keeps its dates, and lost only `#active`.

Note the two tasks dated 2026-07-18 in the real vault: at 26 days overdue they are past the 7-day taper, so a one-off dated that long ago should not appear. A recurring one should.

- [ ] **Step 4: One real push**

```bash
pnpm --filter @personal-automation/tasks tasks alert
```

Only when the dry run above showed something worth sending. Confirm on the phone: the banner arrives, it makes a sound, the items read as separate, and tapping it opens Obsidian on the dashboard.

- [ ] **Step 5: Load the agent**

```bash
cp launchd/com.personal-automation.tasks-alert.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-automation.tasks-alert.plist
launchctl list | grep personal-automation
```

Expected: four labels, each with a `0` or a `-` in the exit column.

- [ ] **Step 6: Commit anything the gates changed**

Only if a gate produced an edit. Amend it into the task's own commit rather than adding a "fix lint" commit.

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: the job and its two halves (Tasks 1, 2, 6), the push and its exact fields (Tasks 3, 4), the fingerprint rule and the two wrong doc comments (Task 5), config (Task 6), launchd (Task 8), errors (Task 4's throw plus Task 6's skip-and-continue on a conflict), testing (each task's tests plus Task 10's coverage check), and "what this does not do" (nothing here adds a state tag, a priority marker, or a write in the alert half).

**Two things the spec left open, decided here.** The push title says `Due (N)` whatever the dates are, because a title naming today would be a lie about an overdue item. The due list is ordered most overdue first with alphabetical ties. Both are in Tasks 1 and 3 and are easy to change if the user disagrees after reading the first real push.

**One accepted limit, new here.** If the Pushover POST fails after a demotion, the vault keeps the demotion and the clock keeps the honest fingerprint (the clock is saved before the push), so the next pass sees an already-demoted task and nothing to alert about. The failure surfaces through the launchd wrapper's notification.
