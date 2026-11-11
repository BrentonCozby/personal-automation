import { execFile } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { listProcesses, parseProcessList } from './processes.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(null, { stdout: '29194 Mon Aug 24 12:56:14 2026     claude\n', stderr: '' })
  }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

it('reads pid, start time and command off a ps line', () => {
  const processes = parseProcessList('29194 Mon Aug 24 12:56:14 2026     claude')

  expect(processes.get(29_194)).toEqual({
    pid: 29_194,
    startedAt: Date.UTC(2026, 7, 24, 12, 56, 14) / 1000,
    command: 'claude',
  })
})

it('reads the start time as UTC whatever zone the board thinks it is in', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles')

  const processes = parseProcessList('29194 Mon Aug 24 12:56:14 2026     claude')

  expect(processes.get(29_194)?.startedAt).toBe(Date.UTC(2026, 7, 24, 12, 56, 14) / 1000)
})

it('asks ps for start times in UTC and English', async () => {
  vi.stubEnv('TZ', 'America/Chicago')
  vi.stubEnv('LC_ALL', 'fr_FR.UTF-8')

  const processes = await listProcesses()

  expect(vi.mocked(execFile).mock.calls[0]?.[2]).toMatchObject({
    env: { TZ: 'UTC0', LC_ALL: 'C' },
  })
  expect(processes.get(29_194)?.startedAt).toBe(Date.UTC(2026, 7, 24, 12, 56, 14) / 1000)
})

it('reduces a command given by path to its last segment', () => {
  const processes = parseProcessList(
    '48447 Fri Aug 14 11:29:23 2026 /Applications/Ghostty.app/Contents/MacOS/ghostty',
  )

  expect(processes.get(48_447)?.command).toBe('ghostty')
})

it('handles a single-digit day, which ps pads with an extra space', () => {
  const processes = parseProcessList('77 Mon Aug  4 09:05:01 2026 claude')

  expect(processes.get(77)?.command).toBe('claude')
})

it('skips lines that are not process rows', () => {
  const processes = parseProcessList(
    ['  PID STARTED COMM', '', '12 Mon Aug 24 12:00:00 2026 claude'].join('\n'),
  )

  expect([...processes.keys()]).toEqual([12])
})

it('reads every process in the listing', () => {
  const processes = parseProcessList(
    ['1 Mon Aug 24 12:00:00 2026 launchd', '2 Mon Aug 24 12:00:01 2026 claude'].join('\n'),
  )

  expect(processes.size).toBe(2)
})
