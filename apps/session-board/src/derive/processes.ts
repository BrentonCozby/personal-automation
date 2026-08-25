import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessInfo } from './liveness.js'

const execFileAsync = promisify(execFile)

// `ps -o lstart=` prints "Mon Aug 24 12:56:14 2026". There is no elapsed-seconds
// keyword on macOS (`etimes` is Linux only), so the date is parsed instead.
const PS_LINE = /^\s*(\d+)\s+(\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/

const MILLISECONDS_PER_SECOND = 1000

export function parseProcessList(stdout: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>()

  for (const line of stdout.split('\n')) {
    const match = PS_LINE.exec(line)
    if (!match) continue

    const [, rawPid, rawStart, rawCommand] = match
    if (!rawPid || !rawStart || !rawCommand) continue

    const startedAtMs = Date.parse(rawStart)
    if (Number.isNaN(startedAtMs)) continue

    processes.set(Number(rawPid), {
      pid: Number(rawPid),
      startedAt: Math.floor(startedAtMs / MILLISECONDS_PER_SECOND),
      // A process launched through a shim reports a bare name, one launched by
      // path reports the path. Only the last segment is comparable.
      command: rawCommand.trim().split('/').pop() ?? '',
    })
  }

  return processes
}

export async function listProcesses(): Promise<Map<number, ProcessInfo>> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,lstart=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
  })

  return parseProcessList(stdout)
}
