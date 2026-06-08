# Hand-off: Obsidian migration & iPhone capture

This is an execution plan for a **Claude instance running locally on Brenton's
laptop**, which (unlike the cloud session that wrote this) has the Obsidian vault
on disk and the user's authenticated `gh`/git. Pick up from here.

Read `CLAUDE.md` first — repo conventions (pnpm, Biome, Vitest, object-args,
factory functions, env rules) are binding.

> **STATUS (2026-06-08): the core migration is done.** The vault is on GitHub, the
> `obsidian` task source is implemented and tested, capture works end-to-end, and a
> weekly git backup runs via launchd. Two things below changed during execution and
> override what the original plan assumed:
> - **Sync is Obsidian Sync, not the Git plugin.** Obsidian Sync is the live
>   cross-device path; git/GitHub is *weekly backup only* (a launchd one-way push).
> - **Capture is the Advanced URI plugin, not the GitHub API.** The iOS Shortcut
>   appends to `todos.md` via `obsidian://adv-uri?...&mode=append`, and Obsidian Sync
>   propagates it — no GitHub token, no GitHub-API Shortcut.
>
> `docs/obsidian-capture.md` is the current, accurate setup guide. The active task
> provider is still `apple`; flip to `obsidian` (`TASK_PROVIDER=obsidian`,
> `TASK_LISTS=[]`) when ready. Tasks 2–4 below are superseded by that doc.

---

## Background (why we're here)

`stalled-tasks` reviews open todos, classifies why each has stalled, and emails a
short "act on these" digest. Its task source was **Apple Reminders** (an
EventKit/Swift bridge, macOS-only). The user is moving off Apple toward a
git-backed **Obsidian** vault as the system of record, heading toward a
Linux/cloud host eventually.

A provider-neutral seam is already in place, so swapping the backend is additive,
not a rewrite.

## Decisions already made (do not re-litigate)

- **Source = Obsidian**, not Google Tasks. (Google Tasks lacks a creation
  timestamp, which staleness depends on; Obsidian keeps todos as plain Markdown in
  git — no OAuth, Linux-friendly, and co-located with goals/notes for richer
  classification.)
- **Vault repo:** `github.com/brentoncozby/obsidian-vault`, **private**.
- **Capture file:** `todos.md` at vault root; each capture **appends one line**.
- **Line format:** `- [ ] <text> ➕ <YYYY-MM-DD>` (Obsidian Tasks syntax; the `➕`
  created-date preserves staleness).
- **Recurring todos stay ignored** by the digest (as today) — the pure parser
  drops `🔁` lines itself, the way the Apple source filters recurring before it
  maps to `Task`. `recurring` stays an internal parser detail; it never reaches
  the neutral `Task` (which has no such field).
- Losing Apple's push notification for recurring items is acceptable; they resurface
  in an Obsidian "Today" view instead. Email is the digest channel.

## Already done in `personal-automation` (committed to `main`)

- `apps/stalled-tasks/src/tasks/` — the provider seam:
  - `types.ts` — neutral `Task` / `TaskSource`
  - `source.ts` — `createTaskSource({ provider, lists, vaultPath })` + `TASK_PROVIDERS`
    (`apple` | `google` | `obsidian`); `google` throws not-implemented
  - `apple/` — the EventKit bridge (still the active provider)
  - `obsidian/` — the Markdown vault source (implemented; see Task 5)
  - selected by `TASK_PROVIDER` + `TASK_LISTS` (+ `OBSIDIAN_VAULT_PATH` for obsidian)
- `docs/obsidian-capture.md` — the current user setup guide (Obsidian Sync + the
  Advanced URI capture Shortcut + the launchd git backup). Reference it; don't
  duplicate it.
- `docs/linux-migration.md` — the plan for the remaining macOS couplings
  (scheduling, notifications, ephemeral filesystem) once the run moves off the Mac.

---

## Tasks

### 1. Create the private vault repo and push it  — DONE (2026-06-08)
Created `github.com/BrentonCozby/obsidian-vault` (private) and pushed the vault
(initial commit `db231a0`). `.gitignore` excludes `.trash/` (369 MB of importer
leftovers stayed local); `todos.md` created at the root. Original steps below for
reference.

From the **vault folder**:

```bash
cd "/path/to/your/vault"   # the folder with the notes + .obsidian

cat > .gitignore <<'EOF'
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
EOF

[ -f todos.md ] || printf '# Todos\n' > todos.md   # capture target must exist

git init
git add .
git commit -m "Initial vault import"
git branch -M main

# With gh (preferred):
gh repo create brentoncozby/obsidian-vault --private --source=. --remote=origin --push
# …or manually create the empty private repo on github.com, then:
#   git remote add origin https://github.com/brentoncozby/obsidian-vault.git
#   git push -u origin main
```

⚠️ Confirm with the user before pushing — the vault becomes **plaintext in a
private GitHub repo**. If any notes are sensitive, scope the repo down or add
`git-crypt` first.

### 2. Obsidian Git plugin  — human step (guide them)
Install "Obsidian Git", set a backup interval (~10 min) + auto-pull. See
`docs/obsidian-capture.md` §1c.

### 3. GitHub token for the Shortcut  — human step (guide them)
Fine-grained token, repo = `obsidian-vault` only, **Contents: read/write**. See
`docs/obsidian-capture.md` §2.

### 4. iOS capture Shortcut  — human step (on the phone)
You can't build this for them; walk them through `docs/obsidian-capture.md` §3–4
(Ask for Input → GitHub Contents API GET/append/PUT to `todos.md` → Add to Home
Screen). Offer to verify the GET/PUT calls with their token via `curl` if a step
misbehaves.

### 5. Implement `createObsidianTaskSource`  — DONE (2026-06-08)
Implemented at `apps/stalled-tasks/src/tasks/obsidian/source.ts` (pure
`parseTodoMarkdown` + read-only file I/O), wired into the seam (`TASK_PROVIDER=obsidian`,
`OBSIDIAN_VAULT_PATH` optional-in-schema/validated-at-seam), with unit + temp-dir
tests. typecheck, biome, and coverage (87/85/87/88 vs 80/80/80/75) all green; a
dry run against a sample vault produced a correct digest (dropped the `🔁` task,
skipped `[x]`/`[/]`, parsed dates as local midnight). The active provider is still
`apple` — flip `TASK_PROVIDER=obsidian` + `TASK_LISTS=[]` when ready. Decisions made
below were followed as written. Original brief retained for reference.

Add an Obsidian provider behind the existing seam. Before writing the regex, read
**20–30 real lines** from the user's actual `todos.md` (include any hand-typed
lines, nested subtasks, and lines with no `➕`) so the format assumptions match
reality, not this doc.

Suggested shape:

- `apps/stalled-tasks/src/tasks/obsidian/source.ts`
  - `createObsidianTaskSource({ vaultPath, lists }): TaskSource`
  - Keep a **pure** parser fn (markdown string → `Task[]`) split from the file
    I/O, exactly like `apple/source.ts` splits `parseBridgeOutput` from
    `runBridge`. The pure fn is what gets the unit tests.
- Wire-up:
  - Add `'obsidian'` to `TASK_PROVIDERS` and a `case` in `createTaskSource`.
  - `config.ts`: surface `taskProvider`/`taskLists` as today, plus
    `OBSIDIAN_VAULT_PATH` — see the config note below.
  - Update `apps/stalled-tasks/.env.example`, the **root** `README.md` (the
    provider section, lines ~95–97; there is no per-app README), and `CLAUDE.md`.

#### What to read, and from where
- **v1: read `todos.md` only** (plus any extra files/folders named in `lists`).
  Do **not** walk the whole vault: arbitrary notes, templates, and READMEs in the
  vault contain incidental `- [ ]` checkboxes that aren't todos and would pollute
  the digest. `todos.md` is the inbox by design (Task 4) — read it directly.
- **Read the live `vaultPath` read-only; never write to it, and don't `git pull`
  it yourself.** Obsidian Git owns that working copy; a concurrent pull/reset
  races its auto-commit over `.git/index.lock` and can blow away uncommitted
  edits. The tradeoff: the digest sees the last state Obsidian Git synced to disk,
  so a phone capture (which PUTs straight to GitHub) is missed until the next
  auto-pull — and if Obsidian isn't running at fire time, the snapshot can be
  hours stale. Acceptable for a Mac-only v1; **document it**. The fix (an owned
  read-only clone the source `git fetch`es before each read) belongs with the
  cloud-host move in §6, not here — don't build it now.
- **Throw, don't return `[]`, on a missing/unreadable vault path.** `run.ts`
  treats an empty list as "nothing is stalled"; a misconfigured path must surface
  as a clear `AppError`, the way the Apple source throws on a permission failure.

#### Parsing rules (the edge cases that bite)
- **Open = `[ ]` with a single space, nothing else.** Don't enumerate skips
  (`[x]`, `[-]`): Obsidian Tasks supports custom statuses (`[/]`, `[>]`, `[?]`…).
  Treat *only* a single-space box as open; everything else is not-open.
- **Markers + indentation.** Match `-`, `*`, and `+` bullets, and allow leading
  whitespace (nested subtasks). Obsidian Tasks recognizes all three markers.
- **Dates are date-only and drive staleness — parse as LOCAL midnight.**
  `➕`/`📅` carry bare `YYYY-MM-DD`. `new Date('2026-06-01')` parses as **UTC**
  midnight, which is the previous calendar day in any negative-offset zone — an
  off-by-one on `created` (and on the `dueStatus` past/future cut). The Apple
  source's `toDate` is fine for full ISO strings but wrong here. Parse these as
  local dates and add a test. (A date-only `due` would be low-impact, but here
  `created` drives staleness, so the off-by-one matters.)
- **Strip metadata from the title.** Pull out `➕`→`created` and `📅`→`due`, drop
  `🔁` lines entirely (recurring — see Decisions), and remove **all** Tasks emoji
  +their trailing values from the title text so the digest/prompt get a clean
  `"buy milk"`, not `"buy milk ➕ 2026-06-01 📅 2026-06-10"`. Don't choke on the
  other Tasks emoji (`⏳ 🛫 ✅`, the priority arrows, `#tags`) — ignore them.

#### Decisions to make (note them in the PR/commit)
- **`id` is not load-bearing — keep it trivial.** `Task.id` is set by the Apple
  source but **read nowhere** in the pipeline (the run-log keys by `title`+`list`,
  analyses join by array index, staleness uses timestamps). It only needs to be
  unique within one `list()` call. `relativePath:lineNumber` is plenty — **no
  content hash**, no cross-run stability requirement.
- **`created` fallback when `➕` is absent → `null`, never file mtime.** Captured
  todos always carry `➕` (the Shortcut writes it), so this only hits hand-typed
  lines. `todos.md` is append-only, so its mtime is "time of the last capture" for
  *every* line — using mtime would make all hand-typed todos look brand new.
  Return `null` (staleness unknown) instead; don't invent a date.
- **`list`** — `todos.md` maps to a single inbox list (e.g. `"todos"`). If `lists`
  later names extra files/folders, map `Task.list` to the file stem or folder
  name. Pick one and document it; the neutral `Task.list` stays a display name.
- **`OBSIDIAN_VAULT_PATH` is provider-specific — make it optional in the schema,
  required at the seam.** An unconditionally-required field would force
  `apple` users to set an unused path. Declare it `z.string().optional()` in
  `config.ts` (not a `.default()`, so the repo rule holds), then throw a clear
  `AppError` for "provider=obsidian but OBSIDIAN_VAULT_PATH unset" inside
  `createTaskSource`/`createObsidianTaskSource` — mirroring how the `google` case
  throws not-implemented.

**Definition of done:** `pnpm typecheck`, `pnpm check`, `pnpm test:coverage`
(thresholds 80/80/80/75) all green; flipping `TASK_PROVIDER=obsidian` produces a
correct digest from the real vault on a dry run
(`pnpm --filter @personal-automation/stalled-tasks test:stalled-tasks`).

### 6. (Later) De-Apple the rest — see `docs/linux-migration.md`
Out of scope for the source swap, but tracked there: launchd → cron/systemd or a
scheduled GitHub Action; `osascript` failure notification → email/ntfy/Pushover;
ephemeral-filesystem handling for audit/runs on a cloud host. Once Obsidian works,
`tasks/apple/` + `launchd/` can be removed.

---

## References
- `docs/obsidian-capture.md` — user-facing setup (repo, token, Shortcut)
- `apps/stalled-tasks/src/tasks/` — the seam to extend
- `CLAUDE.md` — repo conventions (read before coding)
