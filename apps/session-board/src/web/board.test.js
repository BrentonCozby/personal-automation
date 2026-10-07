/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, start } from './board.js'

function boardWith(rows) {
  return {
    claimedCount: rows.length,
    groups: [{ name: 'Bug week', rows }],
    unclaimed: [],
  }
}

function boardWithGroups(groups, unclaimed = []) {
  return {
    claimedCount: groups.reduce((total, group) => total + group.rows.length, 0),
    groups,
    unclaimed,
  }
}

/** A drag event happy-dom does not build for us: it has no DataTransfer. */
function dragEvent(type, transfer) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  event.dataTransfer = transfer

  return event
}

function newTransfer() {
  const data = {}

  return {
    effectAllowed: undefined,
    dropEffect: undefined,
    setData: (kind, value) => {
      data[kind] = value
    },
    getData: kind => data[kind],
  }
}

/** Drag the row whose name is `from` onto the group headed `toGroup`. */
function dragRowToGroup(from, toGroup) {
  const row = [...document.querySelectorAll('.row')].find(
    node => node.querySelector('.name').textContent === from,
  )
  const target = [...document.querySelectorAll('.group')].find(
    node => node.querySelector('.group-label').textContent === toGroup,
  )
  const transfer = newTransfer()

  row.dispatchEvent(dragEvent('dragstart', transfer))
  target.dispatchEvent(dragEvent('dragover', transfer))
  target.dispatchEvent(dragEvent('drop', transfer))
  row.dispatchEvent(dragEvent('dragend', transfer))

  return { row, target }
}

function aRow(overrides) {
  return {
    sessionId: 'abc',
    status: 'gone',
    lastActive: 1_800_000_000,
    ...overrides,
  }
}

function rowNode() {
  return document.querySelector('.row')
}

function buttonNamed(name) {
  return [...document.querySelectorAll('.actions button')].find(
    button => button.textContent === name,
  )
}

/**
 * Stand in for `EventSource`, handing each listener back through `handlers`.
 *
 * `close` and `readyState` are real parts of the interface the client uses to
 * reconnect, so a stub without them passes tests the browser would fail.
 */
function fakeStreamInto(handlers) {
  const opened = []

  class FakeStream {
    static CLOSED = 2
    static opened = opened

    constructor() {
      this.readyState = 0
      opened.push(this)
    }

    addEventListener(type, handler) {
      handlers[type] = handler
    }

    close() {
      this.readyState = FakeStream.CLOSED
    }
  }

  return FakeStream
}

/** Waits out the picker's fetch, which no timer advances. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  // The same elements index.html carries. The client looks each one up by id,
  // so the two have to stay in step.
  document.body.innerHTML =
    '<div id="toolbar"><span id="offline"></span><span id="count"></span></div><div id="board"></div><div id="drawer"></div><datalist id="board-repos"></datalist>'
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([
  [182_400, '182k'],
  [999_499, '999k'],
  [999_500, '1.0M'],
  [640, '640'],
])('shows a context of %i tokens as %s', (contextTokens, text) => {
  render(boardWith([aRow({ name: 'perf', contextTokens })]))

  expect(rowNode().querySelector('.context').textContent).toBe(text)
})

it('shows a dash for a session with no assistant turn yet', () => {
  render(boardWith([aRow({ name: 'perf' })]))

  expect(rowNode().querySelector('.context').textContent).toBe('–')
})

it.each([
  [450_000, 'context'],
  [450_001, 'context growing'],
  [600_000, 'context growing'],
  [600_001, 'context large'],
])('marks a context of %i tokens as "%s"', (contextTokens, className) => {
  render(boardWith([aRow({ name: 'perf', contextTokens })]))

  expect(rowNode().querySelector('.context').className).toBe(className)
})

it.each([
  [10 * 60, '50m', 'cache'],
  [50 * 60, '10m', 'cache cooling'],
  [56 * 60 + 15, '3:45', 'cache cold-soon'],
  [60 * 60, '', 'cache'],
])('counts the cache down %i seconds after the last turn as "%s"', (age, text, className) => {
  vi.setSystemTime(new Date(1_800_000_000_000))
  render(boardWith([aRow({ name: 'perf', lastTurnAt: 1_800_000_000 - age })]))

  const cache = rowNode().querySelector('.cache')
  expect([cache.textContent, cache.className]).toEqual([text, className])
})

it('keeps counting the cache down between frames', async () => {
  vi.setSystemTime(new Date(1_800_000_000_000))
  vi.stubGlobal('EventSource', fakeStreamInto(vi.fn()))
  start()
  render(boardWith([aRow({ name: 'perf', lastTurnAt: 1_800_000_000 - 50 * 60 })]))

  await vi.advanceTimersByTimeAsync(2 * 60 * 1000)

  expect(rowNode().querySelector('.cache').textContent).toBe('8:00')
})

it('offers to name a session that has none', () => {
  render(boardWith([aRow({})]))

  expect(rowNode().querySelector('.name').textContent).toBe('unnamed')
})

it('draws the name read out of the session in place of "unnamed"', () => {
  render(boardWith([aRow({ derivedName: 'best-sandwich' })]))

  const name = rowNode().querySelector('.name')

  expect(name.textContent).toBe('best-sandwich')
  expect(name.classList.contains('derived')).toBe(true)
  expect(name.classList.contains('unnamed')).toBe(false)
})

it('prefers a name you typed over one read out of the session', () => {
  render(boardWith([aRow({ name: 'review-perf', derivedName: 'best-sandwich' })]))

  const name = rowNode().querySelector('.name')

  expect(name.textContent).toBe('review-perf')
  expect(name.classList.contains('derived')).toBe(false)
})

// The name is a guess and the path is not, so it is still the thing that tells
// two rows in the same repository apart.
it('keeps the directory line under a row named from the session itself', () => {
  render(boardWith([aRow({ derivedName: 'best-sandwich', cwd: '/Users/x/Code/repo' })]))

  expect(rowNode().querySelector('.cwd .label').textContent).toBe('Code/repo')
})

it('claims a row on the name read out of it, with nothing typed', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ derivedName: 'best-sandwich' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  name.querySelector('input.edit').dispatchEvent(new Event('blur'))

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(JSON.parse(patch?.[1].body)).toEqual({ name: 'best-sandwich' })
})

it('opens the field on the name read out of the session, ready to be replaced', () => {
  render(boardWith([aRow({ derivedName: 'best-sandwich' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(name.querySelector('input.edit').value).toBe('best-sandwich')
})

// Enter on an unchanged field commits it, so Escape has to stay the way out or
// there would be none.
it('claims nothing when the field opened on a suggestion is escaped', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ derivedName: 'best-sandwich' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  name
    .querySelector('input.edit')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  expect(fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')).toBe(undefined)
})

it('keeps the directory as text on an unnamed row, which has nothing else to go by', () => {
  render(boardWith([aRow({ cwd: '/Users/x/Code/repo-worktrees/perf' })]))

  // The drawer is 16 rows all called "unnamed", so this line is what tells one
  // from another. It is the one place a second line still earns its space.
  expect(rowNode().querySelector('.cwd .label').textContent).toBe('repo-worktrees/perf')
  expect(rowNode().querySelector('.pin')).toBe(null)
})

it('gives a named row a pin instead of a second line', () => {
  render(
    boardWith([
      aRow({
        name: 'code-gardener',
        cwd: '/Users/x/Code/repo-worktrees/code-gardener',
        progressPath: '/repo/code-gardener.progress.local.md',
        progressLabel: 'code-gardener',
      }),
    ]),
  )

  // 8 of 15 rows on the real board repeated the name directly above them.
  expect(rowNode().querySelector('.sub')).toBe(null)
  expect(rowNode().querySelector('.pin .icon').textContent).toBe('≡')
})

it('names the project in the popover, and the file path under it', () => {
  render(
    boardWith([
      aRow({
        name: 'perf',
        cwd: '/Users/x/Code/repo-worktrees/perf',
        progressPath: '/repo/marketplace-perf.progress.local.md',
        progressLabel: 'marketplace-perf',
      }),
    ]),
  )

  // The project is what the row stopped saying anywhere. The slug is not
  // repeated: it is the row's own name on most sessions, and the path spells
  // it out for the rest.
  expect(rowNode().querySelector('.popover-title').textContent).toBe('repo-worktrees/perf')
  expect(rowNode().querySelector('.popover-path').textContent).toBe(
    '/repo/marketplace-perf.progress.local.md',
  )
})

it('leaves the project line out when the session never recorded a directory', () => {
  render(
    boardWith([
      aRow({
        name: 'perf',
        progressPath: '/repo/marketplace-perf.progress.local.md',
        progressLabel: 'marketplace-perf',
      }),
    ]),
  )

  expect(rowNode().querySelector('.popover-title')).toBe(null)
  expect(rowNode().querySelector('.popover-path').textContent).toBe(
    '/repo/marketplace-perf.progress.local.md',
  )
})

it('falls back to a directory pin on a named row with no progress file', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/Users/x/Code/repo-worktrees/perf' })]))

  // A pin, not a line: the row stays one line whatever it has to point at.
  expect(rowNode().querySelector('.sub')).toBe(null)
  expect(rowNode().querySelector('.pin .icon').textContent).toBe('⌂')
  expect(rowNode().querySelector('.popover-title').textContent).toBe('repo-worktrees/perf')
  expect(rowNode().querySelector('.popover-path').textContent).toBe(
    '/Users/x/Code/repo-worktrees/perf',
  )
})

it('gives the directory pin no tab stop, since there is nothing to open', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/Users/x/Code/repo-worktrees/perf' })]))

  expect(rowNode().querySelector('.pin').getAttribute('role')).toBe(null)
})

it('carries no pin at all when a named row has nothing to point at', () => {
  render(boardWith([aRow({ name: 'perf' })]))

  expect(rowNode().querySelector('.pin')).toBe(null)
})

it('opens the progress file from the pin, as the second line used to', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWith([
      aRow({
        name: 'perf',
        progressPath: '/repo/perf-work.progress.local.md',
        progressLabel: 'perf-work',
      }),
    ]),
  )

  rowNode().querySelector('.pin').click()
  await settle()

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/sessions/abc/open-progress',
    expect.objectContaining({ method: 'POST' }),
  )
})

it('strikes through a progress file that is no longer on disk', () => {
  render(
    boardWith([
      aRow({
        name: 'perf',
        progressPath: '/repo/perf-work.progress.local.md',
        progressLabel: 'perf-work',
        isProgressFileMissing: true,
      }),
    ]),
  )

  expect(rowNode().querySelector('.pin').classList.contains('missing')).toBe(true)
  expect(rowNode().querySelector('.popover-path').textContent).toContain('no longer on disk')
})

it('corrects a typed name to kebab-case rather than refusing it', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ name: 'perf' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = name.querySelector('input.edit')
  input.value = 'Review Perf'
  input.dispatchEvent(new Event('blur'))

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(JSON.parse(patch?.[1].body)).toEqual({ name: 'review-perf' })
})

it('clears the name when nothing usable was typed', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ name: 'perf' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = name.querySelector('input.edit')
  input.value = '!!!'
  input.dispatchEvent(new Event('blur'))

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(JSON.parse(patch?.[1].body)).toEqual({ name: null })
})

it('says why on the redrawn row when a snapshot replaced it before the refusal came back', async () => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'other is already on the board' }),
    })),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {
    // The client logs every refusal. This test is about the row.
  })
  start()
  onMessage.message({
    data: JSON.stringify(boardWith([aRow({ name: 'perf', status: 'running' })])),
  })

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'perf', status: 'idle' })])) })
  const input = name.querySelector('input.edit')
  input.value = 'other'
  input.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(0)
  await settle()

  expect(rowNode().querySelector('.edit-line .pending')?.textContent).toBe(
    'other is already on the board',
  )
})

it('says why when the server refuses a name', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'a session name is kebab-case' }),
    })),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {
    // The client logs every refusal. This test is about the row.
  })
  render(boardWith([aRow({ name: 'perf' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = name.querySelector('input.edit')
  input.value = 'other'
  input.dispatchEvent(new Event('blur'))
  await settle()

  // Nothing repaints on a refusal, so without this the edit just looks ignored.
  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe(
    'a session name is kebab-case',
  )
  // And the field itself has to go, or the refusal is written under a box still
  // holding the name the server would not take.
  expect(rowNode().querySelector('input.edit')).toBeNull()
})

it('closes the field on commit, since a save that changes nothing repaints nothing', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ name: 'soc2' })]))

  const name = rowNode().querySelector('.name')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = name.querySelector('input.edit')
  // Kebab-cases straight back to the name the row already has, so the server
  // writes the same value, the snapshot comes out identical and the frame is
  // dropped. Nothing repaints, so the field has to take itself away.
  input.value = 'SOC2'
  input.dispatchEvent(new Event('blur'))

  expect(rowNode().querySelector('input.edit')).toBeNull()
  expect(rowNode().querySelector('.name').textContent).toBe('soc2')
})

it('takes the parked field away on commit rather than leaving an empty line', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ name: 'soc2' })]))

  buttonNamed('park').click()
  const input = rowNode().querySelector('.edit-line input.edit')
  input.value = 'a review'
  input.dispatchEvent(new Event('blur'))

  // The line was made to carry this field and nothing else, so it goes with it.
  expect(rowNode().querySelector('.edit-line')).toBeNull()
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ parkedReason: 'a review' })
})

it('locks resume while the tab opens, so a second press cannot start a second session', async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetchSpy)
  render(boardWith([aRow({ name: 'perf', cwd: '/repo' })]))

  const resume = buttonNamed('resume ↗')
  resume.click()
  resume.click()
  await settle()

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe('opening a tab…')
})

it('says so on the row when a tab could not be opened', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'osascript failed' }),
    })),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {
    // The client logs every refusal. This test is about the row.
  })
  render(boardWith([aRow({ name: 'perf', cwd: '/repo' })]))

  buttonNamed('resume ↗').click()
  await settle()

  // Replaced rather than stacked under the line that said it was opening.
  expect(rowNode().querySelectorAll('.edit-line')).toHaveLength(1)
  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe('osascript failed')
})

it('names the status of the dot, which otherwise carries it in hue alone', () => {
  render(boardWith([aRow({ name: 'perf', status: 'waiting' })]))

  expect(rowNode().querySelector('.dot').getAttribute('aria-label')).toBe('waiting for you')
})

it('puts resume out of reach on a session that is still running', () => {
  render(boardWith([aRow({ name: 'perf', status: 'running', cwd: '/repo' })]))

  const resume = buttonNamed('resume ↗')

  expect(resume.disabled).toBe(true)
  expect(resume.title).toBe('Still running in a terminal tab, so there is nothing to resume')
})

it('puts resume out of reach on a session with no directory recorded', () => {
  render(boardWith([aRow({ name: 'perf' })]))

  expect(buttonNamed('resume ↗').disabled).toBe(true)
})

it('offers resume on a finished session that has a directory', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/repo' })]))

  expect(buttonNamed('resume ↗').disabled).toBe(false)
})

it('puts resume out of reach with neither a transcript nor a progress file', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/repo', isTranscriptMissing: true })]))

  const resume = buttonNamed('resume ↗')

  expect(resume.disabled).toBe(true)
  expect(resume.title).toBe(
    'No progress file and no transcript on disk, so there is nothing to pick up',
  )
})

it('offers resume with no transcript when a progress file can carry the work', () => {
  render(
    boardWith([
      aRow({
        name: 'perf',
        cwd: '/repo',
        isTranscriptMissing: true,
        progressPath: '/repo/marketplace-perf.progress.local.md',
        progressLabel: 'marketplace-perf',
      }),
    ]),
  )

  const resume = buttonNamed('resume ↗')

  // The new session never reads the old transcript, so its absence is no
  // longer a reason to refuse.
  expect(resume.disabled).toBe(false)
  expect(resume.title).toBe('Start a new session named perf and point it at marketplace-perf')
})

it('says it will reopen the old session when there is no progress file', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/repo' })]))

  expect(buttonNamed('resume ↗').title).toBe('Reopen this session in a new Ghostty tab')
})

it('falls back to the old session when the progress file has gone missing', () => {
  render(
    boardWith([
      aRow({
        name: 'perf',
        cwd: '/repo',
        progressPath: '/repo/gone.progress.local.md',
        progressLabel: 'gone',
        isProgressFileMissing: true,
      }),
    ]),
  )

  expect(buttonNamed('resume ↗').title).toBe('Reopen this session in a new Ghostty tab')
})

it('strikes through the name of a session with no transcript, as it does a lost file', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/repo', isTranscriptMissing: true })]))

  expect(rowNode().querySelector('.name').classList.contains('missing')).toBe(true)
})

it('still calls an unnamed session something in its tooltip when it has no transcript', () => {
  render(boardWith([aRow({ isTranscriptMissing: true })]))

  expect(rowNode().querySelector('.name').title).toBe(
    'unnamed · abc · no transcript on disk, so this session cannot be resumed',
  )
})

it('leaves the name alone while the transcript is there', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/repo' })]))

  expect(rowNode().querySelector('.name').classList.contains('missing')).toBe(false)
})

it('opens the name editor from the keyboard', () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const name = rowNode().querySelector('.name')

  expect(name.tabIndex).toBe(0)

  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(rowNode().querySelector('input.edit').value).toBe('perf')
})

it('stops calling itself a button while it holds a text field', () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const name = rowNode().querySelector('.name')

  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(name.getAttribute('role')).toBe(null)

  name.querySelector('input.edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

  expect(name.getAttribute('role')).toBe('button')
})

it('says it is looking while the candidates are being fetched', async () => {
  let answer
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise(resolve => {
          answer = resolve
        }),
    ),
  )
  render(boardWith([aRow({ name: 'perf' })]))

  buttonNamed('link').click()
  await settle()

  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe(
    'looking for progress files…',
  )

  answer({ ok: true, json: async () => ({ files: [] }) })
  await settle()

  // The answer takes the same slot the picker would have, rather than a toast
  // in the corner of the row.
  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe(
    'no progress files in this repo',
  )

  vi.advanceTimersByTime(4000)

  expect(rowNode().querySelector('.edit-line')).toBe(null)
})

it('offers every candidate plus a placeholder when no file is linked', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        files: [
          { path: '/repo/a-task.progress.local.md', slug: 'a-task' },
          { path: '/repo/b-task.progress.local.md', slug: 'b-task', linkedTo: 'other' },
        ],
      }),
    })),
  )
  render(boardWith([aRow({ name: 'perf' })]))

  buttonNamed('link').click()
  await settle()

  expect([...rowNode().querySelector('select.edit').options].map(o => o.textContent)).toEqual([
    'link a progress file…',
    'a-task',
    'b-task (used by other)',
  ])
})

it('preselects the linked file and drops the placeholder when relinking', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ files: [{ path: '/repo/a-task.progress.local.md', slug: 'a-task' }] }),
    })),
  )
  render(
    boardWith([
      aRow({
        name: 'perf',
        progressPath: '/repo/a-task.progress.local.md',
        progressLabel: 'a-task',
      }),
    ]),
  )

  buttonNamed('relink').click()
  await settle()

  const select = rowNode().querySelector('select.edit')

  expect(select.value).toBe('/repo/a-task.progress.local.md')
  expect([...select.options].map(o => o.value)).toEqual(['/repo/a-task.progress.local.md'])
})

it('keeps an option for a linked file the repo no longer holds', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ files: [{ path: '/repo/b-task.progress.local.md', slug: 'b-task' }] }),
    })),
  )
  render(
    boardWith([
      aRow({
        name: 'perf',
        progressPath: '/repo/gone.progress.local.md',
        progressLabel: 'gone',
        isProgressFileMissing: true,
      }),
    ]),
  )

  buttonNamed('relink').click()
  await settle()

  const select = rowNode().querySelector('select.edit')

  expect(select.value).toBe('/repo/gone.progress.local.md')
  expect(select.options[0].textContent).toBe('gone (no longer on disk)')
})

it('saves the chosen file', async () => {
  const fetchMock = vi.fn(async (_path, options) =>
    options?.method === 'PATCH'
      ? { ok: true, json: async () => ({}) }
      : {
          ok: true,
          json: async () => ({
            files: [{ path: '/repo/a-task.progress.local.md', slug: 'a-task' }],
          }),
        },
  )
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ name: 'perf' })]))

  buttonNamed('link').click()
  await settle()
  const select = rowNode().querySelector('select.edit')
  select.value = '/repo/a-task.progress.local.md'
  select.dispatchEvent(new Event('change'))
  await settle()

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(patch?.[0]).toBe('/api/sessions/abc')
  expect(JSON.parse(patch?.[1].body)).toEqual({
    progressPath: '/repo/a-task.progress.local.md',
  })
  expect(rowNode().querySelector('select.edit')).toBe(null)
})

it('writes nothing when the picker is dismissed', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ files: [{ path: '/repo/a-task.progress.local.md', slug: 'a-task' }] }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWith([aRow({ name: 'perf' })]))

  buttonNamed('link').click()
  await settle()
  rowNode()
    .querySelector('select.edit')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await settle()

  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false)
  expect(rowNode().querySelector('select.edit')).toBe(null)
})

it('draws the snapshot the picker held back once it is dismissed', async () => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ files: [{ path: '/repo/a-task.progress.local.md', slug: 'a-task' }] }),
    })),
  )
  start()
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'perf' })])) })

  buttonNamed('link').click()
  await settle()
  const select = rowNode().querySelector('select.edit')
  select.focus()
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'held' })])) })
  select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await settle()

  expect(rowNode().querySelector('.name').textContent).toBe('held')
})

it('keeps the field focus moved to when the picker closes by losing focus', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ files: [{ path: '/repo/a-task.progress.local.md', slug: 'a-task' }] }),
    })),
  )
  render(
    boardWith([
      aRow({ sessionId: 'abc', name: 'perf' }),
      aRow({ sessionId: 'xyz', name: 'other' }),
    ]),
  )

  buttonNamed('link').click()
  await settle()
  rowNode().querySelector('select.edit').focus()
  const other = document.querySelector('.row[data-session-id="xyz"] .name')
  other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  await settle()

  // A repaint here would rebuild the row and throw the new field away mid-edit.
  expect(document.activeElement?.matches('.row[data-session-id="xyz"] input.edit')).toBe(true)
})

it('says so rather than opening an empty picker when the repo has no progress files', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ files: [] }) })),
  )
  render(boardWith([aRow({ name: 'perf' })]))

  buttonNamed('link').click()
  await settle()

  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe(
    'no progress files in this repo',
  )
  expect(rowNode().querySelector('select.edit')).toBe(null)
})

it('passes on what the server said when it refuses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'no working directory recorded' }),
    })),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {
    // The client logs every refusal. This test is about the message on the row.
  })
  render(boardWith([aRow({ name: 'perf' })]))

  buttonNamed('link').click()
  await settle()

  expect(rowNode().querySelector('.edit-line .pending').textContent).toBe(
    'no working directory recorded',
  )
})

it('moves a row into the group it is dropped on', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups([
      { name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] },
      { name: 'Stash', rows: [aRow({ sessionId: 'b', name: 'other' })] },
    ]),
  )

  dragRowToGroup('perf', 'Stash')

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(patch?.[0]).toBe('/api/sessions/a')
  expect(JSON.parse(patch?.[1].body)).toEqual({ group: 'Stash', before: null })
})

it('clears the group rather than writing the word when dropped on Ungrouped', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups([
      { name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] },
      { name: 'Ungrouped', rows: [aRow({ sessionId: 'b', name: 'loose' })] },
    ]),
  )

  dragRowToGroup('perf', 'Ungrouped')

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(JSON.parse(patch?.[1].body)).toEqual({ group: null, before: null })
})

it('writes nothing when a row is dropped back on the group it came from', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWithGroups([{ name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] }]))

  dragRowToGroup('perf', 'Bug week')

  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false)
})

it('claims a drawer row into the group it is dropped on', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups(
      [{ name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] }],
      [aRow({ sessionId: 'z' })],
    ),
  )

  dragRowToGroup('unnamed', 'Bug week')

  const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')

  expect(patch?.[0]).toBe('/api/sessions/z')
  expect(JSON.parse(patch?.[1].body)).toEqual({ group: 'Bug week', before: null })
})

/**
 * Drag `source` and drop it on `target`, over its top or bottom half.
 *
 * happy-dom lays nothing out, so the target is given a 20px box at y 100.
 */
function dragOnto({ source, target, half }) {
  target.getBoundingClientRect = () => ({ top: 100, height: 20 })
  const transfer = newTransfer()
  const at = type => {
    const event = dragEvent(type, transfer)
    event.clientY = half === 'top' ? 105 : 115

    return event
  }

  source.dispatchEvent(dragEvent('dragstart', transfer))
  target.dispatchEvent(at('dragover'))
  const marked = [...document.querySelectorAll('.drop-above, .drop-below')]
  target.dispatchEvent(at('drop'))
  source.dispatchEvent(dragEvent('dragend', transfer))

  return { marked }
}

function rowNamed(name) {
  return [...document.querySelectorAll('.row')].find(
    node => node.querySelector('.name').textContent === name,
  )
}

function headerOf(name) {
  return document.querySelector(`.group[data-group="${name}"] .group-header`)
}

function patchBodies(fetchMock) {
  return fetchMock.mock.calls
    .filter(([, options]) => options?.method === 'PATCH')
    .map(([path, options]) => [path, JSON.parse(options.body)])
}

const threeRows = () =>
  boardWithGroups([
    {
      name: 'Bug week',
      rows: [
        aRow({ sessionId: 'a', name: 'one' }),
        aRow({ sessionId: 'b', name: 'two' }),
        aRow({ sessionId: 'c', name: 'three' }),
      ],
    },
  ])

it.each([
  { name: 'three', onto: 'one', half: 'top', before: 'a' },
  { name: 'one', onto: 'two', half: 'bottom', before: 'c' },
  { name: 'one', onto: 'three', half: 'bottom', before: null },
])('moves $name to the $half of $onto inside its group', ({ name, onto, half, before }) => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(threeRows())

  const { marked } = dragOnto({ source: rowNamed(name), target: rowNamed(onto), half })

  expect(marked).toEqual([rowNamed(onto)])
  expect(patchBodies(fetchMock)).toEqual([[expect.any(String), { before }]])
})

it.each([
  { onto: 'two', half: 'top' },
  { onto: 'one', half: 'bottom' },
  { onto: 'two', half: 'bottom' },
])('writes nothing when a row is dropped on its own spot ($half of $onto)', ({ onto, half }) => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(threeRows())

  const { marked } = dragOnto({ source: rowNamed('two'), target: rowNamed(onto), half })

  expect(marked).toEqual([])
  expect(patchBodies(fetchMock)).toEqual([])
})

it('leaves the board as dropped until the move comes back, rather than redrawing the old spot', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  render(threeRows())
  const source = rowNamed('three')

  dragOnto({ source, target: rowNamed('one'), half: 'top' })

  expect(source.isConnected).toBe(true)
})

it('moves a row to the top of a group when it is dropped on the header', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(threeRows())

  dragOnto({ source: rowNamed('three'), target: headerOf('Bug week'), half: 'bottom' })

  expect(patchBodies(fetchMock)).toEqual([['/api/sessions/c', { before: 'a' }]])
})

it('moves a row into another group above the row it is dropped on', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups([
      { name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] },
      { name: 'Stash', rows: [aRow({ sessionId: 'b', name: 'other' })] },
    ]),
  )

  dragOnto({ source: rowNamed('perf'), target: rowNamed('other'), half: 'top' })

  expect(patchBodies(fetchMock)).toEqual([['/api/sessions/a', { before: 'b', group: 'Stash' }]])
})

it('says why on the group when a move is refused', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'perf is already on the board' }),
    })),
  )
  render(threeRows())

  dragOnto({ source: rowNamed('three'), target: rowNamed('one'), half: 'top' })
  await settle()

  expect(document.querySelector('.group .edit-line .pending')?.textContent).toBe(
    'perf is already on the board',
  )
})

const threeGroups = () =>
  boardWithGroups([
    { name: 'A', rows: [] },
    { name: 'B', rows: [] },
    { name: 'C', rows: [] },
    { name: 'Ungrouped', rows: [aRow({ sessionId: 'u', name: 'loose' })] },
  ])

function groupNode(name) {
  return document.querySelector(`.group[data-group="${name}"]`)
}

it.each([
  { name: 'C', onto: 'A', half: 'top', before: 'A' },
  { name: 'A', onto: 'B', half: 'bottom', before: 'C' },
  { name: 'A', onto: 'C', half: 'bottom', before: null },
  { name: 'A', onto: 'Ungrouped', half: 'top', before: null },
])('moves group $name to the $half of $onto', ({ name, onto, half, before }) => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(threeGroups())

  dragOnto({ source: headerOf(name), target: groupNode(onto), half })

  expect(patchBodies(fetchMock)).toEqual([[`/api/groups/${name}`, { before }]])
})

it.each([
  { onto: 'B', half: 'top' },
  { onto: 'A', half: 'bottom' },
  { onto: 'C', half: 'top' },
])('writes nothing when group B is dropped on its own spot ($half of $onto)', ({ onto, half }) => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(threeGroups())

  dragOnto({ source: headerOf('B'), target: groupNode(onto), half })

  expect(patchBodies(fetchMock)).toEqual([])
})

it('lets only a named group be dragged, since Ungrouped and the drawer have fixed spots', () => {
  render(
    boardWithGroups(
      [
        { name: 'A', rows: [] },
        { name: 'Ungrouped', rows: [aRow({ sessionId: 'u' })] },
      ],
      [aRow({ sessionId: 'z' })],
    ),
  )

  const draggable = [...document.querySelectorAll('.group-header')].map(
    header => header.draggable === true,
  )

  expect(draggable).toEqual([true, false, false])
})

it('takes no drops on the drawer, so a row cannot be removed by dropping it', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups(
      [{ name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] }],
      [aRow({ sessionId: 'z' })],
    ),
  )

  dragRowToGroup('perf', 'Off the board')

  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false)
})

it('holds the repaint while a row is being dragged', () => {
  // Driven through the real event stream, since that is where the guard sits:
  // calling `render` by hand would test a path no snapshot ever takes.
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  start()

  const board = boardWithGroups([
    { name: 'Bug week', rows: [aRow({ sessionId: 'a', name: 'perf' })] },
    { name: 'Stash', rows: [aRow({ sessionId: 'b', name: 'other' })] },
  ])
  onMessage.message({ data: JSON.stringify(board) })
  const row = [...document.querySelectorAll('.row')].find(
    node => node.querySelector('.name').textContent === 'perf',
  )

  row.dispatchEvent(dragEvent('dragstart', newTransfer()))

  // Rebuilding the board mid-drag destroys the element under the pointer and
  // the drag dies with it, so a snapshot arriving now is set aside.
  onMessage.message({ data: JSON.stringify(boardWithGroups([{ name: 'Bug week', rows: [] }])) })

  expect(row.isConnected).toBe(true)

  row.dispatchEvent(dragEvent('dragend', newTransfer()))

  expect(document.querySelector('.row')).toBe(null)
})

it('holds the repaint while the pointer is down, so a click is not swallowed', () => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  start()
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'perf' })])) })

  const row = rowNode()
  document.dispatchEvent(new Event('pointerdown', { bubbles: true }))

  // A browser sends `click` to the nearest ancestor the press and the release
  // still share. Rebuilding between the two leaves no shared ancestor in the
  // document, and no click is dispatched at all: measured in Chrome, one press
  // gave one mousedown, one mouseup and zero clicks.
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'renamed' })])) })

  expect(row.isConnected).toBe(true)

  document.dispatchEvent(new Event('pointerup', { bubbles: true }))

  // `click` follows `pointerup` with no timer in between, so drawing here
  // throws the pressed node away before the browser can dispatch it.
  expect(row.isConnected).toBe(true)

  vi.advanceTimersByTime(0)

  // Whatever arrived while the button was held is drawn once the click is past.
  expect(rowNode().querySelector('.name').textContent).toBe('renamed')
})

it('leaves the board alone on a release that had no snapshot to catch up on', () => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  start()
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'perf' })])) })

  const row = rowNode()
  document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('pointerup', { bubbles: true }))
  vi.advanceTimersByTime(0)

  // A button writes its own feedback into the row it sits in, so a release that
  // repaints with nothing new to show wipes the answer to the press.
  expect(rowNode()).toBe(row)
})

it.each([
  ['Escape', input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
  [
    'Enter on an unchanged value',
    input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })),
  ],
])('draws the snapshot a field held back once %s closes it', (_case, close) => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  start()
  onMessage.message({
    data: JSON.stringify(boardWith([aRow({ name: 'perf', status: 'running' })])),
  })

  rowNode()
    .querySelector('.name')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  onMessage.message({ data: JSON.stringify(boardWith([aRow({ name: 'perf', status: 'idle' })])) })
  close(rowNode().querySelector('input.edit'))
  vi.advanceTimersByTime(0)

  // The server sends nothing more until the board changes again, so a frame
  // set aside here would leave stale statuses on screen indefinitely.
  expect(rowNode().classList.contains('status-idle')).toBe(true)
})

it('draws the snapshot the delete question held back once focus leaves it', () => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  start()
  onMessage.message({
    data: JSON.stringify(boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' })] }])),
  })

  document.querySelector('.group-delete').click()
  onMessage.message({
    data: JSON.stringify(boardWithGroups([{ name: 'Renamed', rows: [aRow({ sessionId: 'a' })] }])),
  })
  document.querySelector('.group-delete').blur()
  vi.advanceTimersByTime(0)

  expect(document.querySelector('.group-name').textContent).toBe('Renamed')
})

it('lets a field be selected by giving up the drag while it is open', () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const row = rowNode()

  expect(row.draggable).toBe(true)

  row.querySelector('.name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

  // Text inside a draggable element cannot be selected with the mouse.
  expect(row.draggable).toBe(false)

  row.querySelector('input.edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

  expect(row.draggable).toBe(true)
})

it('gives an unclaimed row no board controls of its own', () => {
  render({
    claimedCount: 0,
    groups: [],
    unclaimed: [aRow({ sessionId: 'zzz' })],
  })

  expect(buttonNamed('link')).toBeUndefined()
  expect(buttonNamed('park')).toBeUndefined()
})

/** Collapse the one group on the page, the way the chevron does. */
function collapseOnlyGroup() {
  document.querySelector('.chevron-hit').click()
}

function isOnlyGroupCollapsed() {
  return document.querySelector('.group').classList.contains('collapsed')
}

it('carries a collapsed group to its new name instead of springing it open', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  render(boardWithGroups([{ name: 'Rename Me', rows: [aRow({ name: 'perf' })] }]))
  collapseOnlyGroup()
  expect(isOnlyGroupCollapsed()).toBe(true)

  const title = document.querySelector('.group-name')
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = title.querySelector('input.edit')
  input.value = 'Renamed'
  input.dispatchEvent(new Event('blur'))
  await settle()

  // The mark is filed under the name, so a rename leaves it on a name nothing
  // has any more unless it is moved across.
  render(boardWithGroups([{ name: 'Renamed', rows: [aRow({ name: 'perf' })] }]))

  expect(isOnlyGroupCollapsed()).toBe(true)
})

it('says why when the server refuses a group rename', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'Ungrouped is where a row with no group goes' }),
    })),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {
    // The client logs every refusal. This test is about the group.
  })
  render(boardWithGroups([{ name: 'Rename Me', rows: [aRow({ name: 'perf' })] }]))

  const title = document.querySelector('.group-name')
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = title.querySelector('input.edit')
  input.value = 'Ungrouped'
  input.dispatchEvent(new Event('blur'))
  await settle()

  // Nothing repaints on a refusal, so the header goes back to the old name with
  // no word of why. Every other field on this board says.
  expect(document.querySelector('.group .edit-line .pending').textContent).toBe(
    'Ungrouped is where a row with no group goes',
  )
})

it('leaves a collapsed group collapsed under its own name when a rename is refused', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 400, text: async () => '{}' })),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {
    // The client logs every refusal. This test is about the mark.
  })
  render(boardWithGroups([{ name: 'Rename Me', rows: [aRow({ name: 'perf' })] }]))
  collapseOnlyGroup()

  const title = document.querySelector('.group-name')
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = title.querySelector('input.edit')
  input.value = 'Ungrouped'
  input.dispatchEvent(new Event('blur'))
  await settle()

  // The mark moves before the request so the frame the rename pushes finds it
  // already filed. A refused rename has to put it back, or it sits under a name
  // no group has and the group springs open, or worse: under Ungrouped, which
  // is a real heading and would collapse instead.
  render(boardWithGroups([{ name: 'Rename Me', rows: [aRow({ name: 'perf' })] }]))

  expect(isOnlyGroupCollapsed()).toBe(true)
})

it('renames a group in one request rather than one per row', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups([
      { name: 'Rename Me', rows: [aRow({ sessionId: 'a' }), aRow({ sessionId: 'b' })] },
    ]),
  )

  const title = document.querySelector('.group-name')
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = title.querySelector('input.edit')
  input.value = 'Renamed'
  input.dispatchEvent(new Event('blur'))
  await settle()

  // The group carries the name too, so the server moves it and the rows
  // together: a row left behind brings the old group back on the next snapshot.
  expect(fetchMock.mock.calls).toEqual([
    [
      '/api/groups/Rename%20Me',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }),
    ],
  ])
})

it('deletes a group when its name is cleared', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWithGroups([{ name: 'Doomed', rows: [aRow({ sessionId: 'a' })] }]))

  const title = document.querySelector('.group-name')
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = title.querySelector('input.edit')
  input.value = ''
  input.dispatchEvent(new Event('blur'))
  await settle()

  expect(fetchMock.mock.calls).toEqual([
    ['/api/groups/Doomed', expect.objectContaining({ method: 'DELETE' })],
  ])
})

it('deletes an empty group on one press of its ×', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(boardWithGroups([{ name: 'Empty', rows: [] }]))

  document.querySelector('.group-delete').click()
  await settle()

  expect(fetchMock.mock.calls).toEqual([
    ['/api/groups/Empty', expect.objectContaining({ method: 'DELETE' })],
  ])
})

it('asks again before deleting a group that still holds sessions', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' }), aRow({ sessionId: 'b' })] }]),
  )

  document.querySelector('.group-delete').click()
  await settle()

  // One stray click would otherwise scatter every row into Ungrouped, and
  // putting them back means dragging each one.
  expect(fetchMock).not.toHaveBeenCalled()
  const confirm = document.querySelector('.group-delete')
  expect(confirm.textContent).toBe('delete? 2 sessions to Ungrouped')

  confirm.click()
  await settle()

  expect(fetchMock.mock.calls).toEqual([
    ['/api/groups/Busy', expect.objectContaining({ method: 'DELETE' })],
  ])
})

it('holds the repaint while the delete question is up', () => {
  render(boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' })] }]))

  document.querySelector('.group-delete').click()

  // An unrelated session's event would otherwise rebuild the header and take
  // the question away mid-click.
  expect(document.activeElement.classList.contains('edit')).toBe(true)
})

it('lets go of the repaint the moment the delete is answered', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  render(boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' })] }]))

  document.querySelector('.group-delete').click()
  const confirm = document.querySelector('.group-delete')
  confirm.click()
  await settle()

  // The question is what held the repaint off, and the repaint is what takes
  // the group away, so holding on past the press leaves the board sitting there
  // as though the button did nothing.
  expect(document.activeElement.classList.contains('edit')).toBe(false)
  expect(confirm.textContent).toBe('deleting…')
})

it('keeps the question up when the press lands somewhere else', () => {
  render(boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' })] }]))

  document.querySelector('.group-delete').click()
  document.querySelector('.group-delete').blur()

  expect(document.querySelector('.group-delete').textContent).toBe('×')
})

function refuseEveryRequest(error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error }) })),
  )
}

it('gives the × back and says why when a delete is refused', async () => {
  refuseEveryRequest('could not write groups.json')
  render(boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' })] }]))

  document.querySelector('.group-delete').click()
  document.querySelector('.group-delete').click()
  await settle()

  expect(document.querySelector('.group-delete').textContent).toBe('×')
  expect(document.querySelector('.group .edit-line .pending')?.textContent).toBe(
    'could not write groups.json',
  )
})

it('says why when deleting an empty group is refused', async () => {
  refuseEveryRequest('could not write groups.json')
  render(boardWithGroups([{ name: 'Empty', rows: [] }]))

  document.querySelector('.group-delete').click()
  await settle()

  expect(document.querySelector('.group .edit-line .pending')?.textContent).toBe(
    'could not write groups.json',
  )
})

it('draws the snapshot the delete question held back once a delete is refused', async () => {
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  refuseEveryRequest('could not write groups.json')
  start()
  const send = rows =>
    onMessage.message({ data: JSON.stringify(boardWithGroups([{ name: 'Busy', rows }])) })
  send([aRow({ sessionId: 'a', name: 'perf' })])

  document.querySelector('.group-delete').click()
  // Arrives while the question holds the repaint off.
  send([aRow({ sessionId: 'a', name: 'held' })])
  document.querySelector('.group-delete').click()
  await settle()

  expect(document.querySelector('.row .name').textContent).toBe('held')
})

it('gives an empty group something to drop a session onto', () => {
  render(boardWithGroups([{ name: 'Empty', rows: [] }]))

  // The header alone is 38px of target on the real board, against 29px per row,
  // and it is the same band that holds the rename field and the ×.
  expect(document.querySelector('.drop-hint').textContent).toBe('Drag a session here')
})

it('draws no drop hint on a group that has sessions in it', () => {
  render(boardWithGroups([{ name: 'Busy', rows: [aRow({ sessionId: 'a' })] }]))

  expect(document.querySelector('.drop-hint')).toBe(null)
})

it('draws no drop hint on a collapsed group, which shows nothing else either', () => {
  render(boardWithGroups([{ name: 'Empty', rows: [] }]))
  collapseOnlyGroup()

  expect(document.querySelector('.drop-hint')).toBe(null)
})

it('offers no × on Ungrouped, which is the absence of a group', () => {
  render(boardWithGroups([{ name: 'Ungrouped', rows: [aRow({ sessionId: 'a' })] }]))

  expect(document.querySelector('.group-delete')).toBe(null)
})

it('creates a group from the toolbar, with no session in it yet', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  const onMessage = {}
  vi.stubGlobal('EventSource', fakeStreamInto(onMessage))
  start()

  const host = document.querySelector('.new-group')
  host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = host.querySelector('input.edit')
  input.value = 'Bug week'
  input.dispatchEvent(new Event('blur'))
  await settle()

  expect(fetchMock.mock.calls).toEqual([
    [
      '/api/groups',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Bug week' }) }),
    ],
  ])
  // The toolbar is outside the part a repaint rebuilds, so the field would
  // otherwise sit there for the rest of the session.
  expect(host.textContent).toBe('+ new group')
})

it('forgets a group that is gone, so a later one reusing the name opens', () => {
  render(boardWithGroups([{ name: 'Vanisher', rows: [aRow({ name: 'a' })] }]))
  collapseOnlyGroup()
  expect(isOnlyGroupCollapsed()).toBe(true)

  render(boardWithGroups([{ name: 'Something Else', rows: [aRow({ name: 'b' })] }]))
  render(boardWithGroups([{ name: 'Vanisher', rows: [aRow({ name: 'c' })] }]))

  // Otherwise a brand new group opens collapsed, hiding rows nobody hid.
  expect(isOnlyGroupCollapsed()).toBe(false)
})

it('keeps collapsed groups when a frame arrives carrying none', () => {
  render(boardWithGroups([{ name: 'Persist', rows: [aRow({ name: 'a' })] }]))
  collapseOnlyGroup()
  expect(isOnlyGroupCollapsed()).toBe(true)

  render({ claimedCount: 0, groups: [], unclaimed: [] })
  render(boardWithGroups([{ name: 'Persist', rows: [aRow({ name: 'a' })] }]))

  expect(isOnlyGroupCollapsed()).toBe(true)
  document.querySelector('.chevron-hit').click()
})

/** The `+` on the header of the group named `label`. */
function startButton(label) {
  const group = [...document.querySelectorAll('.group')].find(
    node => node.querySelector('.group-label').textContent === label,
  )

  return group.querySelector('.group-start')
}

function startPanel() {
  return document.querySelector('.start-panel')
}

/**
 * Open a group's start panel and wait out the repo fetch.
 *
 * `element.click()` rather than a real pointer, which is what a test can do:
 * this proves the handler and the markup, not the layout.
 */
async function openStartPanel(label, repos = ['/Users/me/Code/marketplace']) {
  const fetchMock = vi.fn((_path, options) => {
    if (options?.method === 'POST')
      return { ok: true, json: async () => ({ sessionId: 'pending-1' }) }

    return { ok: true, json: async () => ({ repos }) }
  })
  vi.stubGlobal('fetch', fetchMock)

  startButton(label).click()
  await settle()

  return fetchMock
}

it('offers a + on every group header, including Ungrouped', () => {
  render(
    boardWithGroups([
      { name: 'Bug week', rows: [aRow({ name: 'perf' })] },
      { name: 'Ungrouped', rows: [aRow({ sessionId: 'def', name: 'loose' })] },
    ]),
  )

  expect(startButton('Bug week')).not.toBe(null)
  expect(startButton('Ungrouped')).not.toBe(null)
})

// The drawer holds sessions nobody claimed, which is not somewhere to put a new
// one.
it('offers no + on the drawer', () => {
  render(boardWithGroups([], [aRow({ sessionId: 'zzz' })]))

  expect(document.querySelector('#drawer .group-start')).toBe(null)
})

it('keeps the press after a repaint that took the start panel away', async () => {
  const board = boardWith([aRow({ name: 'perf' })])
  render(board)
  await openStartPanel('Bug week')

  // What a drag ending does while the panel is open.
  render(board)
  const row = rowNode()
  row.dispatchEvent(new Event('pointerdown', { bubbles: true }))

  expect(row.isConnected).toBe(true)
})

it('opens a panel asking for a name, a repo and a progress file', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  const panel = startPanel()
  expect(panel).not.toBe(null)
  expect(panel.querySelectorAll('input.edit[type="text"], input.edit:not([type])').length).toBe(2)
  expect(panel.querySelector('input[type="checkbox"]').checked).toBe(true)
})

it("asks the server for the group's own repositories first", async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const fetchMock = await openStartPanel('Bug week')

  expect(fetchMock).toHaveBeenCalledWith('/api/repos?group=Bug%20week')
})

it('fills the directory field with the first repository, so nothing is typed', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week', ['/Users/me/Code/marketplace', '/Users/me/Code/other'])

  expect(startPanel().querySelectorAll('input.edit')[1].value).toBe('/Users/me/Code/marketplace')
})

it('lists every repository as a suggestion the field can be typed against', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week', ['/Users/me/Code/marketplace', '/Users/me/Code/other'])

  const options = [...document.querySelectorAll('#board-repos option')].map(node => node.value)
  expect(options).toEqual(['/Users/me/Code/marketplace', '/Users/me/Code/other'])
})

it('holds the repaint off while the panel is open', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  // A snapshot arriving now would rebuild the header the panel hangs off and
  // take it away mid-edit.
  render(boardWith([aRow({ name: 'perf' })]))
  document.dispatchEvent(new Event('pointerdown'))
  document.dispatchEvent(new Event('pointerup'))
  await settle()

  expect(startPanel()).toBe(null)
})

it('posts the name, the group, the repo and the checkbox', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const fetchMock = await openStartPanel('Bug week')

  const panel = startPanel()
  const [name, where] = panel.querySelectorAll('input.edit')
  name.value = 'review-perf'
  where.value = '/Users/me/Code/marketplace'
  panel.querySelector('.start-go').click()
  await settle()

  const post = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')
  expect(post[0]).toBe('/api/sessions')
  expect(JSON.parse(post[1].body)).toEqual({
    name: 'review-perf',
    group: 'Bug week',
    cwd: '/Users/me/Code/marketplace',
    createProgressFile: true,
  })
})

it('corrects the name to kebab-case in the field before sending it', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const fetchMock = await openStartPanel('Bug week')

  const panel = startPanel()
  const name = panel.querySelectorAll('input.edit')[0]
  name.value = 'Review Perf'
  panel.querySelector('.start-go').click()
  await settle()

  const post = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')
  expect(JSON.parse(post[1].body).name).toBe('review-perf')
})

it('sends nothing and says so when the name has nothing usable in it', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const fetchMock = await openStartPanel('Bug week')

  const panel = startPanel()
  panel.querySelectorAll('input.edit')[0].value = '!!!'
  panel.querySelector('.start-go').click()
  await settle()

  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  expect(panel.querySelector('.start-answer').textContent).toBe('a session needs a name')
  expect(startPanel()).not.toBe(null)
})

it('closes on cancel without sending anything', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  const fetchMock = await openStartPanel('Bug week')

  const cancel = [...startPanel().querySelectorAll('button')].find(
    button => button.textContent === 'cancel',
  )
  cancel.click()

  expect(startPanel()).toBe(null)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('closes on Escape', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  startPanel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  expect(startPanel()).toBe(null)
})

it('walks Enter from the directory field to start, once the browser has let go', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  const panel = startPanel()
  const where = panel.querySelectorAll('input.edit')[1]
  where.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  // Not on the same tick: Chrome closes the suggestion popup this Enter picked
  // from afterwards, and takes focus with it.
  expect(document.activeElement).not.toBe(panel.querySelector('.start-go'))
  await settle()
  expect(document.activeElement).toBe(panel.querySelector('.start-go'))
})

it('closes when the page behind it is pressed', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

  expect(startPanel()).toBe(null)
})

it('closes when the keyboard walks focus out of it', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  startPanel()
    .querySelectorAll('input.edit')[0]
    .dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: document.getElementById('count'),
      }),
    )

  expect(startPanel()).toBe(null)
})

it('keeps what was typed when its own empty space is pressed', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  const panel = startPanel()
  const name = panel.querySelectorAll('input.edit')[0]
  name.value = 'review-perf'
  // What the browser gives for a press on anything that cannot take focus: the
  // panel's own padding, the row of buttons between them. Measured in Chrome,
  // where it also took the panel away mid-press, so the click never arrived.
  panel
    .querySelector('.start-actions')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  name.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))

  expect(startPanel()?.querySelectorAll('input.edit')[0].value).toBe('review-perf')
})

it('keeps what was typed when the window loses focus', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  const name = startPanel().querySelectorAll('input.edit')[0]
  name.value = 'review-perf'
  name.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))

  expect(startPanel()?.querySelectorAll('input.edit')[0].value).toBe('review-perf')
})

it('closes once the session has started and nothing needs saying', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  await openStartPanel('Bug week')

  const panel = startPanel()
  panel.querySelectorAll('input.edit')[0].value = 'review-perf'
  panel.querySelector('.start-go').click()
  await settle()

  // The row appearing is the confirmation, so there is nothing to read.
  expect(startPanel()).toBe(null)
})

it('stays open to say the directory was corrected to a repository root', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  vi.stubGlobal(
    'fetch',
    vi.fn((_path, options) => {
      if (options?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ sessionId: 'pending-1', cwd: '/Users/me/Code/marketplace' }),
        }
      }

      return { ok: true, json: async () => ({ repos: ['/Users/me/Code/marketplace'] }) }
    }),
  )
  startButton('Bug week').click()
  await settle()

  const panel = startPanel()
  panel.querySelectorAll('input.edit')[0].value = 'review-perf'
  panel.querySelectorAll('input.edit')[1].value = '/Users/me/Code/marketplace-worktrees/soc2'
  panel.querySelector('.start-go').click()
  await settle()

  expect(panel.querySelector('.start-answer').textContent).toBe('started in Code/marketplace')
})

it('keeps the panel open with the reason when the server refuses', async () => {
  render(boardWith([aRow({ name: 'perf' })]))
  vi.stubGlobal(
    'fetch',
    vi.fn((_path, options) => {
      if (options?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'review-perf is already on the board' }),
        }
      }

      return { ok: true, json: async () => ({ repos: ['/Users/me/Code/marketplace'] }) }
    }),
  )
  startButton('Bug week').click()
  await settle()

  const panel = startPanel()
  panel.querySelectorAll('input.edit')[0].value = 'review-perf'
  panel.querySelector('.start-go').click()
  await settle()

  // Left open so the name can be fixed rather than typed again from nothing.
  expect(startPanel()).not.toBe(null)
  expect(panel.querySelector('.start-answer').textContent).toBe(
    'review-perf is already on the board',
  )
})

it('reopens a stream the browser gave up on, and says the board is not live meanwhile', async () => {
  const handlers = {}
  const FakeStream = fakeStreamInto(handlers)
  vi.stubGlobal('EventSource', FakeStream)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  start()

  // What restarting the server looks like from the page: the retry `EventSource`
  // makes on its own is refused, and it closes for good.
  FakeStream.opened.at(-1).readyState = FakeStream.CLOSED
  handlers.error(new Event('error'))

  expect(document.getElementById('offline').textContent).toBe('not live, reconnecting')
  expect(FakeStream.opened).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(2000)

  expect(FakeStream.opened).toHaveLength(2)

  handlers.message({ data: JSON.stringify(boardWith([aRow({ name: 'perf' })])) })

  expect(document.getElementById('offline').textContent).toBe('')
})

it('leaves a stream the browser is still retrying alone', async () => {
  const handlers = {}
  const FakeStream = fakeStreamInto(handlers)
  vi.stubGlobal('EventSource', FakeStream)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  )
  start()

  // `CONNECTING`, which is `EventSource` retrying by itself. Opening a second
  // stream here would leave two of them running against one board.
  FakeStream.opened.at(-1).readyState = 0
  handlers.error(new Event('error'))
  await vi.advanceTimersByTimeAsync(5000)

  expect(FakeStream.opened).toHaveLength(1)
  expect(document.getElementById('offline').textContent).toBe('not live, reconnecting')
})
