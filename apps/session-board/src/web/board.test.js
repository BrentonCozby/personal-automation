/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './board.js'

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

it('shows the working directory for a named row that has no progress file', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/Users/x/Code/repo-worktrees/perf' })]))

  expect(rowNode().querySelector('.cwd .label').textContent).toBe('repo-worktrees/perf')
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

  expect(rowNode().querySelector('.progress').classList.contains('missing')).toBe(true)
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

it('puts resume out of reach on a session with no transcript on disk', () => {
  render(boardWith([aRow({ name: 'perf', cwd: '/repo', isTranscriptMissing: true })]))

  const resume = buttonNamed('resume ↗')

  expect(resume.disabled).toBe(true)
  expect(resume.title).toBe(
    'Claude Code has no transcript for this session, so it cannot be resumed',
  )
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
