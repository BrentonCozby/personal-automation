import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The `src/web` entry is browser code, served to the page as-is and never
    // compiled, so its tests are `.js` too and pick the happy-dom environment
    // through a docblock of their own. The path is narrow on purpose: a plain
    // `**/*.test.js` also matches the compiled copies under `dist`, which then
    // run twice and from stale output.
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/src/web/*.test.js'],
    environment: 'node',
    // Over the 5 second default, because these tests do real work: they start
    // HTTP servers, spawn `git` and `ps`, and stat every Claude Code transcript
    // on the machine. This machine also runs a dozen Claude sessions at once,
    // and at a load average near its core count a `git init` alone has taken
    // more than five seconds. A passing test never waits this out.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/schemas.ts',
        'apps/*/src/index.ts',
        'apps/tasks/src/generate-launchd-plist.ts',
        'packages/gmail/src/bootstrap.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
})
