# Task state model

How the `tasks` app decides what you are committed to, what has gone quiet, and what to stop
carrying. Read this before changing anything in `apps/tasks/src/state/`.

## States

Four stored states, written as tags on the task line in the vault. A fifth state is computed and
never stored. A sixth is the absence of a tag.

| State | Storage | Meaning |
| --- | --- | --- |
| `#someday` | tag | Holding pool. Never scanned, never counted, never shown. |
| `#active` | tag | The closed list. Subject to the work-in-progress cap. |
| `#done` | tag | Terminal. |
| `#abandoned` | tag | Terminal. Deliberately dropped, counted as a win. |
| stalled | computed | An `#active` task with no touch inside the stall window. |
| untagged | absence | Ignored by every part of the system. Permanently valid. |

Untagged is not a backlog to clear. New captures arrive untagged forever and that is the designed
steady state. Nothing reports on it, counts it, or asks about it.

Recurring tasks (those carrying a `🔁` rule) stay untagged. A recurring chore is a live commitment
that the Tasks plugin already manages through its recurrence rule and due date, so none of the four
stored states describe it correctly. They never count toward the cap, never decay, and never stall.

## Identity

A task's identity is its list plus its title, with state tags and Tasks-plugin metadata stripped.
Line position is not identity: tasks move when lines are inserted above them, and a task that moved
has not been touched.

Stripping state tags before computing identity is what lets a task keep its identity across a
promotion. Without it, adding `#active` would read as a brand new task.

Editing a title does break identity, and the replacement is stamped as touched now. That is the
correct outcome, because editing the title was itself a touch.

## The touch clock

Obsidian has no per-task last-modified timestamp. Frontmatter does not exist in the todo files and
is per-file regardless. The Tasks plugin has no last-modified marker; `➕` is creation and never
changes. File modification time is per-file while tasks are per-line, so a single file holding
every task would report one shared timestamp for all of them. Vault git history starts months after
the oldest open task and records mechanical daily backup commits, so it cannot say when a task was
worked on.

So the clock is synthesized and stored outside the vault, in `apps/tasks/runs/touch-clock.json`:

```json
{
  "version": 1,
  "tasks": {
    "<task id>": { "fingerprint": "sha256:...", "lastTouched": "2026-08-12T09:00:00.000Z" }
  }
}
```

Each run hashes every task line together with its indented notes. A fingerprint that differs from
the stored one means the task was touched, so `lastTouched` becomes now. An unchanged fingerprint
carries the previous value forward.

The file is rebuildable. Deleting it stamps every task as touched on the next run, which costs one
stall window of signal and nothing else. It holds no data that does not exist elsewhere.

When the app writes a state change itself, it records the touch directly rather than waiting to
infer it from the next run's fingerprint. Promotion and scheduling count as touches. Decay does
not, because the task is terminal by then.

### Cold start

The first run stamps every task as touched now. This never causes a wrong decay, because only
`#active` tasks decay and the migration leaves `#active` empty. The clock starts when you promote
something, which is the moment it should start.

## Day counting

Every threshold is a count of calendar days in local time, never a division of milliseconds.

```ts
const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())

return (end - start) / MS_PER_DAY
```

Reading the local calendar date and rebuilding it in UTC drops the clock time and the offset
together, so daylight saving never reaches the arithmetic and the division stays exact. Subtracting
raw timestamps and flooring, which is what the old staleness code did, loses an hour across a
spring-forward: a 30-day span reports 29 and every threshold fires a day late.

Tests pin `TZ` explicitly rather than trusting the machine's zone, and cover both the spring-forward
and fall-back boundaries.

## Thresholds

All three live in `apps/tasks/src/config.ts` and nowhere else.

| Setting | Default | Used by |
| --- | --- | --- |
| `TASKS_WIP_CAP` | 3 | Promotion. |
| `TASKS_STALL_DAYS` | 7 | The computed stalled state. |
| `TASKS_HORIZON_DAYS` | 28 | Decay threshold and scheduling ceiling, read from this one value. |

The decay threshold and the scheduling ceiling are the same number because they are the same claim
about how far ahead you can honestly see. A date past the horizon is routed to `#someday`.

## Scope

`TASK_LISTS` decides which files hold tasks, for the migration and the digest alike. Both read the
same setting, so neither can decide a checkbox is a task while the other decides it isn't.

Most checkboxes in a vault are not tasks. Of the 718 in this one, 643 sit inside working documents:
steps in a design doc under `Projects/`, research sub-items in the notes linked from a todo, a list
of personality traits in an imported Google Keep note, and a reusable packing checklist whose items
are all ticked from the last trip. Tagging those would write state into documents that were never
task lists, and nothing would ever read it.

`migrate --scope <path>` overrides the setting for one run. It exists for checking a folder before
deciding to include it, not as a routine argument.

## Reading and writing the vault

`TaskSource` gains a write operation:

```ts
export type TaskSource = {
  list: () => Promise<Task[]>
  applyChanges: (args: {
    changes: TaskChange[]
    dryRun: boolean
  }) => Promise<ChangeResult>
}
```

`ChangeResult` is a tagged union of `applied`, `dry_run`, and `conflict` rather than a thrown error,
so callers branch on a value instead of on an exception type.

Before rewriting a line, the writer confirms the line still matches the fingerprint it read. A
mismatch means Obsidian Sync or a hand edit moved it, so the change is reported as a conflict and
nothing is written. Obsidian Sync and the Git plugin are both live on this vault, so a write can
always land underneath a concurrent edit.

## Migration

One pass, run once. `tasks migrate` prints a diff and stops; `tasks migrate --apply` writes.

| Source | Target |
| --- | --- |
| `[x]` completed | `#done` |
| `[-]` cancelled | `#abandoned` |
| `[ ]` open, no `🔁` | `#someday` |
| `[ ]` open, with `🔁` | left untagged |
| already tagged | left alone |

Everything open goes to `#someday`. No heuristic promotes anything to `#active`, because recency,
priority, and tag proximity would each invent commitments that were never made. `#active` starts
empty and you fill it by hand, up to the cap.

Leaving already-tagged lines alone makes the pass idempotent, so a second run is a no-op.

Scope is `TASK_LISTS`. Within it, dot-prefixed folders and everything that is not `.md` are skipped,
which covers `.trash/` (Obsidian's deleted copies, whose tasks would otherwise come back), and
`.obsidian/`.

Before writing, the pass checks that each file it would modify is tracked by git and has no
unstaged changes, then reports the ones that fail and exits without writing. The check is per file
rather than whole-tree, because `.obsidian/plugins/` carries permanent uncommitted churn and a
whole-tree cleanliness check would never pass. Per-file tracking is also what makes the revert a
scoped `git checkout` rather than one that would discard plugin state.

Quit Obsidian before applying. Writing across dozens of files while Sync is live invites conflicts
that the per-line fingerprint check will correctly refuse, leaving the pass half-applied.

## Tag placement

State tags go at the end of the description text, before the first Tasks-plugin emoji:

```text
- [ ] heath ceramics second hand #someday ➕ 2025-05-23
```

Placing a tag after the emoji metadata risks it being absorbed into the trailing signifier's value.
The title parser strips state tags, so they never reach the digest or the task's identity.

## Ordering by closest to done

Promotion at cap names the current `#active` items ordered by most recently touched first, with
soonest due date breaking ties.

There is no completion data to work from. The vault contains no subtasks anywhere, so no completion
fraction exists, and no task carries an effort estimate. Momentum is the only signal the data
actually holds: the task you touched yesterday is the one you are part way through. Asking the model
for an estimate would put a call taking tens of seconds inside an interactive command.

The error copy names the proxy so the ordering is never mysterious.

## Overrides

Raising the cap for a single invocation is a legitimate use of the system. It requires no reason,
prints no warning, and is not an error.

Each override appends one line to `apps/tasks/runs/overrides.jsonl`. When more than three land
inside a rolling 30 days, the digest suggests raising the default cap, on the grounds that a rule
routed around this often is a rule that does not fit. It never suggests trying harder.

Override records must stay out of `apps/*/audit/`. The `notify` app globs that path and would mail
them to you as failures.
