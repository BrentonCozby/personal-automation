# Project rules for AI agents

These are the conventions this monorepo follows that aren't visible from just reading the source. Read these before doing real work in here. The user's global `~/.claude/CLAUDE.md` rules also apply.

## Tooling

- **Package manager**: pnpm 11 with workspaces. Never run `npm` or `yarn`. Workspace packages declare dependencies on each other via `"workspace:*"`.
- **Lint + format**: Biome 2. Run `pnpm check` from the root. Don't add ESLint or Prettier.
- **Tests**: Vitest. Tests live next to source as `<name>.test.ts`. E2E tests use `<name>.e2e.test.ts` and msw to mock HTTP. `pnpm test` runs the whole workspace.
- **Typecheck**: `pnpm typecheck` invokes `tsc -b` which builds the project-reference graph for all packages and apps.
- **Commit messages**: Conventional Commits, enforced by a husky `commit-msg` hook. Use `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`, `ci:`, `build:`, `perf:`. Multi-type commits should pick the most user-visible type.
- **Coverage**: thresholds in root `vitest.config.ts` (80/80/80/75). Don't drop below.

## Code style (beyond what Biome enforces)

- **Object args for multi-param functions.** Any function/method/constructor with 2+ args takes a single destructured object: `function foo({ a, b }: { a: T; b: U })`. Only use a single positional arg for a function if it will never need another arg.
- **Blank line before `return`** unless (a) it's an inline return after an `if` (`if (x) return y`) or (b) the return is the only statement in its block.
- **Factory functions, not classes.** External-system adapters are factory functions named `createX` that return an object of operations. Mutable state lives in the closure.
- **Named inner functions, not arrows in the returned object.** Inside `createX`, use `function info(...)` not `info: (...) => ...`. Better stack traces.

## Monorepo layout

```text
apps/
  ynab-categorize/     # daily Amazon-categorizer CLI
  ynab-enrich-memos/   # writes Amazon receipt items into transaction memos; runs before ynab-categorize
  notify/              # emails a digest after the daily run on audit-log errors
  tasks/               # Obsidian task state model: the twice-weekly review of #active tasks that
                       # have gone quiet, plus promote/schedule/abandon (own launchd agent)
  session-board/       # local web panel of claimed Claude Code sessions, read from a hook event
                       # log; a server on :4747, not a scheduled job (own launchd agent)
packages/
  anthropic/           # Claude API client (messages.parse + zodOutputFormat)
  ynab/                # YNAB client, schemas, types, milliunits
  gmail/               # Gmail API client (OAuth, send w/ optional multipart HTML, read/search)
  common/              # errors, retry, lock, logger, progress, json, chunks, date
launchd/               # macOS scheduling: run.sh, run-tasks-digest.sh, run-vault-backup.sh, run-session-board.sh, setup.sh, plist templates, newsyslog conf
```

- **Cross-package imports** use the package name + subpath: `import { withRetry } from '@personal-automation/common/retry'`. Each package's `exports` map in its `package.json` declares the public API. Internal package files import via relative paths (`./errors.js`).
- **Apps** depend on packages via `"workspace:*"` in their `package.json`. They don't depend on each other.
- **Each package has its own `tsconfig.json`** extending `tsconfig.base.json`, with `references` for cross-package deps so `tsc -b` builds them in order.
- **Schemas are the source of truth for types** in `packages/ynab`. `types.ts` does `z.infer<typeof schema>` so schema changes can't silently drift from types.

## Architecture

- **External services**: shared ones are a package (`packages/ynab/`, `packages/gmail/`, `packages/anthropic/` for the Claude API client); app-specific ones live in `apps/<app>/src/<service>/` (e.g. each app's thin `anthropic/` wrapper over the shared client). Inside: `client.ts` (factory), `schemas.ts` (zod), `types.ts` (derived). Anything specific stays in that folder.
- **Constants**: code-shape constants (flag name/color, payee filter, batch sizes) live in `apps/ynab-categorize/src/constants.ts`. The single YNAB-wide constant `YNAB_API_BASE_URL` lives in `packages/ynab/src/constants.ts`. These aren't env-tunable.
- **Env vars**: split across `.env` files, all gitignored. Shared secrets and ids live in the monorepo-root `.env` (`YNAB_TOKEN`, `YNAB_BUDGET_ID`, `ALLOWED_ACCOUNT_IDS`, `ANTHROPIC_API_KEY`, `GMAIL_OAUTH_*`); each app's own tuning, recipients, and per-app model live in `apps/<app>/.env` (e.g. `LOOKBACK_DAYS`/`EXCLUDED_CATEGORY_GROUPS` for ynab-categorize, `ENRICH_LOOKBACK_DAYS`/`GMAIL_RECEIPT_WINDOW_DAYS`/`GMAIL_FROM_FILTER` for ynab-enrich-memos, `TASK_LISTS`/`OBSIDIAN_VAULT_PATH`/`TASKS_*` for tasks); apps never read another app's `.env`. An app's `config.ts` calls `loadAppEnv(import.meta.url)` (from `@personal-automation/common/env`), which loads the root `.env` then the app's `.env` on top; package-level scripts with no app `.env` use `loadRootEnv`. No `.default()` calls in `config.ts`: loaders throw if any required var is missing. A `.env.example` sits next to every `.env` (root + per-app) with generic placeholders so nothing personal lives in tracked files.
- **Errors**: extend `AppError` from `@personal-automation/common/errors`. Set `retryable: true` for transient failures so `withRetry` picks them up. Don't add new error subclasses unless callers actually need to branch on them.
- **Logging**: structured via pino, wrapped in `createLogger` so call sites are `logger.info({ msg, extra })`. The audit log (JSONL) is a separate concern from pino, written via `logger.audit(entry)`.
- **Audit-log layout**: the writer (`createLogger`) and the reader (`notify`) share one convention from `@personal-automation/common/audit-path` so they can't drift: each app writes `apps/<app>/audit/<app>-<date>.jsonl`. An app's `config.ts` sets `auditDir` via `appAuditDir(import.meta.url)` (module-relative, not CWD); `notify` reads the same path via `AUDIT_DIR_NAME` + `auditFileName`.

## Workflow

- Local runs: no app has a root-level shortcut. Run any app via `pnpm --filter @personal-automation/<app> <script>` (e.g. `pnpm --filter @personal-automation/ynab-categorize test:ynab-categorize` for a dry run).
- Daily run: launchd invokes `launchd/run.sh`, which loops over the `APPS` array. The plist is generated by `./launchd/setup.sh` from a committed template; the actual plist is gitignored. `tasks` is not in `APPS`: it has its own agent on `TASKS_SCHEDULE`. Nor is `session-board`, which is a server rather than a job: its agent sets `RunAtLoad` and `KeepAlive` with no schedule, and its wrapper runs through `/bin/zsh -lc` because `node` is a Volta shim that launchd's bare PATH cannot see.
- Apps that can run concurrently guard with a PID lockfile in `$TMPDIR` (e.g. `ynab-categorize.lock`, `tasks.lock`). Failed runs leave a stale lock which the next run claims automatically.
- Failures trigger a macOS notification via `launchd/run.sh`. Don't replace that wrapper with a direct `pnpm` invocation, or you'd lose the notification.

## Things to never do

- Commit any `.env`, the root one or `apps/*/.env` (all gitignored, but worth saying). The `.env.example` files next to them are the only tracked env files.
- Commit the generated `launchd/*.plist` or `launchd/newsyslog.personal-automation.conf` files (only the `.template` versions are tracked).
- Add a `.default()` in any config loader for an env var: env is the source of truth.
- Skip the husky hooks with `--no-verify` (per global rules).
- Force-push to `main` without explicit user permission for that specific push.
- Add a class when a factory function would work just as well.
- Reach for `instanceof` to branch on fall-back logic when a tagged-union return value would express the same thing.
- Add cross-app dependencies. Apps depend on packages, never on other apps.
