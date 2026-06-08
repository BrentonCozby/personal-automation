# Hand-off: Obsidian migration & iPhone capture

This is an execution plan for a **Claude instance running locally on Brenton's
laptop**, which (unlike the cloud session that wrote this) has the Obsidian vault
on disk and the user's authenticated `gh`/git. Pick up from here.

Read `CLAUDE.md` first — repo conventions (pnpm, Biome, Vitest, object-args,
factory functions, env rules) are binding.

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
- **Recurring todos stay ignored** by the digest (as today) — the parser must
  flag `🔁` items so the app drops them.
- Losing Apple's push notification for recurring items is acceptable; they resurface
  in an Obsidian "Today" view instead. Email is the digest channel.

## Already done in `personal-automation` (committed to `main`)

- `apps/stalled-tasks/src/tasks/` — the provider seam:
  - `types.ts` — neutral `Task` / `TaskSource`
  - `source.ts` — `createTaskSource({ provider, lists })` + `TASK_PROVIDERS`
    (`apple` | `google`); `google` throws not-implemented
  - `apple/` — the EventKit bridge (still the default)
  - selected by `TASK_PROVIDER` + `TASK_LISTS`
- `docs/obsidian-capture.md` — full user setup guide (repo, push, token, the iOS
  Shortcut recipe). Reference it; don't duplicate it.
- `docs/google-migration.md` — earlier analysis, now largely superseded by the
  Obsidian decision (leave it, or fold the still-relevant bits — §3 host move — into
  a new doc).

---

## Tasks

### 1. Create the private vault repo and push it  — you can do this locally
The cloud session could not (its GitHub token lacks repo-create permission). From
the **vault folder**:

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

### 5. Implement `createObsidianTaskSource`  — the coding task
Add an Obsidian provider behind the existing seam. Suggested shape:

- `apps/stalled-tasks/src/tasks/obsidian/source.ts`
  - `createObsidianTaskSource({ vaultPath, lists }): TaskSource`
  - Walk `*.md` under `vaultPath` (respect a configured subset if `lists` is used).
  - Parse open-task lines `- [ ] …` (skip `- [x]` / `- [-]`). Extract Tasks
    metadata: `➕`→`created`, `📅`→`due`, `🔁`→ set `recurring: true`.
  - Map to `Task`. Keep a **pure** parser fn (markdown string → `Task[]`) so it's
    unit-testable like `apple/source.ts`'s `parseBridgeOutput`.
- Wire-up:
  - Add `'obsidian'` to `TASK_PROVIDERS` and a `case` in `createTaskSource`.
  - `config.ts`: add `OBSIDIAN_VAULT_PATH` (required; no `.default()` per repo
    rule) and surface `taskProvider`/`taskLists` as today.
  - Update `apps/stalled-tasks/.env.example`, `README.md`, `CLAUDE.md`.

Design decisions to make (note them in the PR/commit):
- **Stable `id`** — Tasks doesn't add block-ids by default. Options: hash of
  normalized line text, or `relativePath:lineText`. Needs to be stable across runs
  so the run-log/staleness join holds. Recommend a content hash.
- **`created` fallback** when `➕` is absent — options: git history (first commit
  touching the line), file mtime, or `null`. Decide one explicitly; don't let
  `null` happen silently (it weakens staleness).
- **`list`** — map to top-level folder, a `#tag`, or the file. `todos.md` is the
  inbox; pick a convention and document it.

Validate the parser against a **real sample** from the user's vault before
finalizing the format assumptions.

**Definition of done:** `pnpm typecheck`, `pnpm exec biome ci .`,
`pnpm test:coverage` (thresholds 80/80/80/75) all green; flipping
`TASK_PROVIDER=obsidian` produces a correct digest from the vault on a dry run
(`pnpm --filter @personal-automation/stalled-tasks test:stalled-tasks`).

### 6. (Later) De-Apple the rest
Out of scope for the source swap, but tracked: launchd → cron/systemd or a
scheduled GitHub Action; `osascript` failure notification → email/ntfy/Pushover;
ephemeral-filesystem handling for audit/runs on a cloud host. Once Obsidian works,
`tasks/apple/` + `launchd/` can be removed.

---

## References
- `docs/obsidian-capture.md` — user-facing setup (repo, token, Shortcut)
- `apps/stalled-tasks/src/tasks/` — the seam to extend
- `CLAUDE.md` — repo conventions (read before coding)
