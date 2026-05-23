import ora, { type Ora } from 'ora'

export type Progress = {
  update: (text: string) => void
  succeed: (text: string) => void
  fail: (text: string) => void
}

// When `enabled` is false, all methods are no-ops so callers don't have to branch on whether
// a spinner exists.
export function createProgress({ enabled, text }: { enabled: boolean; text: string }): Progress {
  if (!enabled) return noopProgress

  const spinner: Ora = ora(text).start()

  function update(t: string): void {
    spinner.text = t
  }

  function succeed(t: string): void {
    spinner.succeed(t)
  }

  function fail(t: string): void {
    spinner.fail(t)
  }

  return { update, succeed, fail }
}

const noopProgress: Progress = {
  update: () => {
    /* no-op */
  },
  succeed: () => {
    /* no-op */
  },
  fail: () => {
    /* no-op */
  },
}
