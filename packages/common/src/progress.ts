import cliSpinners from 'cli-spinners'
import logUpdate from 'log-update'

type ActiveBar = {
  render: () => void
  clear: () => void
}

let active: ActiveBar | null = null

// Write text to stdout, cooperatively clearing/redrawing any active progress bar so the
// text lands above the bar instead of on top of it. The logger routes pino-pretty's output
// through here so log lines coexist with the bar — including in verbose mode.
export function writeWithProgress(text: string): void {
  if (active === null) {
    process.stdout.write(text)

    return
  }

  active.clear()
  process.stdout.write(text)
  active.render()
}

export type Progress = {
  /** Replace the visible text. Use this for indeterminate spinners (no `total`). */
  update: (text: string) => void
  /** Advance the bar by one. No-op when `total` was not provided. */
  tick: () => void
  succeed: (text: string) => void
  fail: (text: string) => void
}

const SPINNER = cliSpinners.dots
const ANSI_CYAN = '\x1b[36m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_RED = '\x1b[31m'
const ANSI_RESET = '\x1b[0m'
const BAR_WIDTH = 24

// When `enabled` is false, all methods are no-ops so callers don't have to branch on whether
// a spinner exists. Passing `total` switches to a determinate progress bar; without it the
// spinner is indeterminate and only `update`/`succeed`/`fail` are meaningful.
export function createProgress({
  enabled,
  label,
  total,
}: {
  enabled: boolean
  label: string
  total?: number
}): Progress {
  if (!enabled) return noopProgress

  // Defensive: if a previous bar wasn't finalized (caller bug), clear it before claiming
  // the region.
  if (active !== null) {
    active.clear()
    active = null
  }

  const trackTo: number | undefined = typeof total === 'number' && total > 0 ? total : undefined
  let done = 0
  let bodyText = trackTo === undefined ? label : renderBar({ label, done, total: trackTo })
  let frameIdx = 0
  let stopped = false

  function compose(): string {
    return `${ANSI_CYAN}${SPINNER.frames[frameIdx]}${ANSI_RESET} ${bodyText}`
  }

  function render(): void {
    if (stopped) return
    logUpdate(compose())
  }

  function clear(): void {
    logUpdate.clear()
  }

  active = { render, clear }

  const interval = setInterval(() => {
    frameIdx = (frameIdx + 1) % SPINNER.frames.length
    render()
  }, SPINNER.interval)
  // Don't keep the event loop alive just for the spinner.
  interval.unref()

  render()

  function update(text: string): void {
    bodyText = text
    render()
  }

  function tick(): void {
    if (trackTo === undefined) return
    done = Math.min(done + 1, trackTo)
    bodyText = renderBar({ label, done, total: trackTo })
    render()
  }

  function succeed(text: string): void {
    finalize(`${ANSI_GREEN}✔${ANSI_RESET} ${text}`)
  }

  function fail(text: string): void {
    finalize(`${ANSI_RED}✖${ANSI_RESET} ${text}`)
  }

  function finalize(line: string): void {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    logUpdate(line)
    logUpdate.done()
    active = null
  }

  return { update, tick, succeed, fail }
}

function renderBar({ label, done, total }: { label: string; done: number; total: number }): string {
  const filled = Math.round((done / total) * BAR_WIDTH)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)

  return `${label} [${bar}] ${done}/${total}`
}

const noopProgress: Progress = {
  update: () => {
    /* no-op */
  },
  tick: () => {
    /* no-op */
  },
  succeed: () => {
    /* no-op */
  },
  fail: () => {
    /* no-op */
  },
}
