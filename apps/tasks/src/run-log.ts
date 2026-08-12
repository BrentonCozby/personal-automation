import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNS_DIR_NAME } from './constants.js'

// Resolved relative to this module (app dir), not CWD, so the records always land in
// apps/tasks/runs/ — outside notify's apps/*/audit/* glob.
const DEFAULT_RUNS_DIR = fileURLToPath(new URL(`../${RUNS_DIR_NAME}/`, import.meta.url))

export type RunLogEntry = {
  timestamp: string
  date: string
  dry_run: boolean
  title: string
  list: string
  classification: string
  priority: string
  stale_days: number | null
  due_status: string
  suggested_next_action: string | null
  shown: boolean
}

/**
 * One JSONL line per analyzed task, appended to runs/run-<today>.jsonl. This is the corrections
 * substrate for tuning the prompt later (compare classifications to what I'd have wanted), so it
 * records every task — not just the ones that made the digest.
 */
export function appendRunLog({
  entries,
  today,
  dir = DEFAULT_RUNS_DIR,
}: {
  entries: RunLogEntry[]
  today: string
  dir?: string
}): void {
  if (entries.length === 0) return
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `run-${today}.jsonl`)
  const lines = entries.map(entry => JSON.stringify(entry)).join('\n')
  appendFileSync(path, `${lines}\n`)
}
