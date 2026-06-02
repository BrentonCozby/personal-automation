import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AppError } from '@personal-automation/common/errors'
import { z } from 'zod'
import type { Task } from './types.js'

const execFileAsync = promisify(execFile)

// The bridge ships as Swift source and is compiled on demand into a standalone, ad-hoc-signed
// binary. That's a TCC requirement, not an optimization: `swift reminders.swift` runs
// /usr/bin/swift (an Apple platform binary), so macOS walks Reminders-access attribution past
// it to the Node runtime that spawned it — and Volta's execve makes that runtime impossible to
// grant reliably. A compiled, non-platform, signed binary is its own "responsible process", so
// the grant attaches to it and holds whether launched by launchd or a terminal.
const SWIFTC_BIN = '/usr/bin/swiftc'
const CODESIGN_BIN = '/usr/bin/codesign'
const BRIDGE_SOURCE = fileURLToPath(new URL('./reminders.swift', import.meta.url))
const BRIDGE_BIN = fileURLToPath(new URL('./reminders-bridge', import.meta.url))
// Bridge JSON grows with the reminder count; 16 MB is far more than any real list needs.
const MAX_BUFFER = 16 * 1024 * 1024

export type TaskSource = {
  list: () => Promise<Task[]>
}

// Swift's JSONEncoder omits keys for nil optionals (it emits no `null`), so notes/due and
// the timestamps arrive absent rather than null. nullish() accepts both; toTask normalizes
// undefined → null.
const reminderSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullish(),
  list: z.string(),
  created: z.string().nullish(),
  lastModified: z.string().nullish(),
  due: z.string().nullish(),
  recurring: z.boolean().optional(),
})
const bridgeSuccessSchema = z.object({ reminders: z.array(reminderSchema) })
const bridgeErrorSchema = z.object({ error: z.string(), status: z.number().optional() })

type RawReminder = z.infer<typeof reminderSchema>

export function createAppleRemindersSource({ lists }: { lists: readonly string[] }): TaskSource {
  async function list(): Promise<Task[]> {
    const stdout = await runBridge()

    return parseBridgeOutput({ raw: stdout, lists })
  }

  return { list }
}

async function runBridge(): Promise<string> {
  const bin = await buildBridge()
  try {
    const { stdout } = await execFileAsync(bin, [], { maxBuffer: MAX_BUFFER })

    return stdout
  } catch (err) {
    // The bridge prints a JSON error payload to stdout and exits non-zero for the
    // not-authorized / fetch-failed cases. Re-read it so the caller gets the precise
    // AppError (with the grant instructions) instead of a generic "command failed".
    throwIfBridgeError(readStdout(err))

    throw new AppError({
      message: `Apple Reminders bridge failed: ${(err as Error).message}`,
      cause: err,
    })
  }
}

// Compile + ad-hoc sign the Swift source into a standalone binary, skipping the build when the
// binary is already newer than the source (so this is a one-time cost, not per-run).
async function buildBridge(): Promise<string> {
  if (await isBuildFresh()) return BRIDGE_BIN
  try {
    await execFileAsync(SWIFTC_BIN, ['-O', BRIDGE_SOURCE, '-o', BRIDGE_BIN])
    await execFileAsync(CODESIGN_BIN, ['--force', '--sign', '-', BRIDGE_BIN])
  } catch (err) {
    if (isEnoent(err)) {
      throw new AppError({
        message:
          'Could not build the Reminders bridge: `swiftc` not found. Install the Xcode Command Line Tools with `xcode-select --install`.',
        cause: err,
      })
    }

    throw new AppError({
      message: `Could not build the Reminders bridge: ${(err as Error).message}`,
      cause: err,
    })
  }

  return BRIDGE_BIN
}

async function isBuildFresh(): Promise<boolean> {
  try {
    const [bin, source] = await Promise.all([stat(BRIDGE_BIN), stat(BRIDGE_SOURCE)])

    return bin.mtimeMs >= source.mtimeMs
  } catch {
    return false
  }
}

// Pure: maps the bridge's JSON to Task[], dropping recurring reminders (their own alert is
// the channel for them) and filtering to the requested lists ([] = all). Throws a clear
// AppError on an error payload or unparseable output so a permission problem never returns an
// empty list that would read as "nothing is stalled".
export function parseBridgeOutput({
  raw,
  lists,
}: {
  raw: string
  lists: readonly string[]
}): Task[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new AppError({
      message: `Apple Reminders bridge returned invalid JSON: ${truncate(raw)}`,
    })
  }

  throwIfBridgeError(raw, json)

  const { reminders } = bridgeSuccessSchema.parse(json)
  const wanted = new Set(lists)

  return reminders
    .filter(r => !r.recurring)
    .filter(r => wanted.size === 0 || wanted.has(r.list))
    .map(toTask)
}

function throwIfBridgeError(raw: string, preParsed?: unknown): void {
  if (!raw.trim()) return
  let json = preParsed
  if (json === undefined) {
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
  }
  const payload = bridgeErrorSchema.safeParse(json)
  if (!payload.success) return
  if (payload.data.error === 'not_authorized') {
    throw new AppError({
      message: `Could not read Apple Reminders: access not granted (EventKit status ${payload.data.status ?? 'unknown'}). The bridge requests access on first run — click Allow on the prompt, or enable "reminders-bridge" under System Settings → Privacy & Security → Reminders, then re-run.`,
    })
  }

  throw new AppError({ message: `Apple Reminders bridge error: ${payload.data.error}` })
}

function toTask(r: RawReminder): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes ?? null,
    created: toDate(r.created),
    lastModified: toDate(r.lastModified),
    due: toDate(r.due),
    list: r.list,
  }
}

function toDate(iso: string | null | undefined): Date | null {
  return iso ? new Date(iso) : null
}

function readStdout(err: unknown): string {
  const stdout = (err as { stdout?: unknown }).stdout

  return typeof stdout === 'string' ? stdout : ''
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown }).code === 'ENOENT'
}

function truncate(s: string): string {
  const trimmed = s.trim()

  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}
