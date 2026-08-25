/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, start } from './board.js'

// Far enough in the future that a row written with a fixed `lastActive` has a
// predictable age. Real time would make the age move between runs.
const NOW_SECONDS = 1_800_000_000

function boardWith(rows) {
  return {
    claimedCount: rows.length,
    staleSeconds: 4 * 86_400,
    groups: [{ name: 'Bug week', rows }],
    unclaimed: [],
  }
}

function boardWithGroups(groups, unclaimed = []) {
  return {
    claimedCount: groups.reduce((total, group) => total + group.rows.length, 0),
    staleSeconds: 4 * 86_400,
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
    lastActive: NOW_SECONDS - 600,
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

/** Waits out the picker's fetch, which no timer advances. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="toolbar"><span id="count"></span></div><div id="board"></div><div id="drawer"></div>'
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW_SECONDS * 1000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows the age worked out from the timestamp, not counted up', () => {
  render(boardWith([aRow({ name: 'perf', lastActive: NOW_SECONDS - 3 * 3600 })]))

  expect(rowNode().querySelector('.age').textContent).toBe('3h')
})

it('marks a session that has been quiet longer than the stale window', () => {
  render(boardWith([aRow({ name: 'perf', lastActive: NOW_SECONDS - 5 * 86_400 })]))

  expect(rowNode().querySelector('.age').classList.contains('stale')).toBe(true)
})

it('offers to name a session that has none', () => {
  render(boardWith([aRow({})]))

  expect(rowNode().querySelector('.name').textContent).toBe('unnamed')
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
  expect(JSON.parse(patch?.[1].body)).toEqual({ group: 'Stash' })
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

  expect(JSON.parse(patch?.[1].body)).toEqual({ group: null })
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
  expect(JSON.parse(patch?.[1].body)).toEqual({ group: 'Bug week' })
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
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(type, handler) {
        onMessage[type] = handler
      }
    },
  )
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
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(type, handler) {
        onMessage[type] = handler
      }
    },
  )
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
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(type, handler) {
        onMessage[type] = handler
      }
    },
  )
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
    staleSeconds: 4 * 86_400,
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

  render({ claimedCount: 0, staleSeconds: 4 * 86_400, groups: [], unclaimed: [] })
  render(boardWithGroups([{ name: 'Persist', rows: [aRow({ name: 'a' })] }]))

  expect(isOnlyGroupCollapsed()).toBe(true)
  document.querySelector('.chevron-hit').click()
})
