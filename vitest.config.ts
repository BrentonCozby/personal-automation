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
