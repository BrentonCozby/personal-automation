# Task state model

How the `tasks` app decides what you are committed to, what has gone quiet, and what to stop
carrying. Read this before changing anything in `apps/tasks/src/state/`.

## States

Two states are written as tags on the task line. Two more are read if a tag says them but nothing
writes them, because the checkbox says the same thing better. A fifth is computed and never stored,
and a sixth is the absence of a tag.

| State | Storage | Meaning |
| --- | --- | --- |
| `#someday` | tag, written | Holding pool. Never scanned, never counted, never shown. |
| `#active` | tag, written | The closed list. Subject to the work-in-progress cap. |
| `#done` | tag, read only | Terminal. Recorded by a ticked box and a `✅` date instead. |
| `#abandoned` | tag, read only | Terminal. Recorded by a cancelled box and an `❌` date instead. |
| stalled | computed | An `#active` task with no touch inside the stall window. |
| untagged | absence | Ignored by every part of the system. Permanently valid. |

Finishing and dropping are recorded by the checkbox, not by a tag. A ticked or cancelled box already
says the task is over, the counts read its `✅` or `❌` date, and the cap only ever looks at open
boxes, so a tag beside the box would state the same fact twice. It also has to work the other way
round: a task you tick or cancel directly in Obsidian has to count exactly like one this app closed,
and it does, because both are just a closed box with a date. The two terminal tags stay readable so
that a line already carrying one is left alone rather than reopened.

The states are mutually exclusive: a task carries one tag or none. A line carrying two is a
contradiction, and nothing resolves it silently. It counts as neither state, so it holds no place
against the cap and sits in no holding pool; every command refuses it, naming both tags and the
file and line; and the migration leaves it alone and reports it. Resolving it by taking the first
tag would make the meaning depend on which one happened to be typed first, and every write here
clears the old tags before writing, so acting on such a line would throw away whichever of the two
was meant. This is the state a line lands in when a tag is added by hand in Obsidian without the
old one being deleted, which is the most likely way to get here.

Untagged is not a backlog to clear. New captures arrive untagged forever and that is the designed
steady state. Nothing reports on it, counts it, or asks about it.

One command can move a task out of untagged: scheduling one past the horizon routes it to
`#someday`, because a date you can't honestly see is what the holding pool is for. Nothing else
writes a tag onto a task you left alone.

Recurring tasks (those carrying a `🔁` rule) stay untagged, and no command will write a state or a
date onto one. A recurring chore is a live commitment that the Tasks plugin already manages through
its recurrence rule and due date, so none of the stored states describe it correctly and any date
written by hand would fight the plugin for control of it. They never count toward the cap, never
decay, and never stall.

## Identity

A task's identity is its list plus its title, with state tags and Tasks-plugin metadata stripped.
Line position is not identity: tasks move when lines are inserted above them, and a task that moved
has not been touched.

Stripping state tags before computing identity is what lets a task keep its identity across a
promotion. Without it, adding `#active` would read as a brand new task.

Editing a title does break identity, and the replacement is stamped as touched now. That is the
correct outcome, because editing the title was itself a touch.

Two open tasks with the same title in the same list therefore share one identity. The touch clock
treats them as a single task and keeps the first, rather than letting them overwrite each other on
every run, and the commands report them as ambiguous rather than picking one. Renaming either is
the fix, and the ambiguous message is what tells you to.

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

Only open tasks are tracked, and a task the run doesn't see is dropped from the file. Completing a
task therefore clears its entry; reopening it stamps a new one, which is right, because reopening
was a touch.

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

One scanner reads it: `scanFileTasks` in `tasks/obsidian/scan.ts` returns every task line in a file
with its position, its text, its notes, and its state. The digest, the migration, and `promote` all
go through it, so none of them can decide a checkbox is a task while another decides it isn't. An
in-progress `[/]` box counts as open, because the task is live.

One writer writes it: `writeChangedLines` in `tasks/obsidian/write.ts`. Before rewriting a line it
confirms the line still matches the text it was read as. A mismatch means Obsidian Sync or a hand
edit moved it, so nothing in that file is written and the caller reports a conflict. Both Sync and
the Git plugin are live on this vault, so a write can always land underneath a concurrent edit.

The write path is not on `TaskSource`. Every writer here is Obsidian-specific, and a provider-
neutral change type with only one implementation behind it would be a seam holding nothing. The
scanner and the writer are the seam; a second provider moves them, and until then `TaskSource`
stays read-only.

Outcomes are tagged unions (`promoted`, `at_cap`, `conflict`, and the rest) rather than thrown
errors, so callers branch on a value. "You are at the cap" is an answer, not a failure.

## The three commands

Each takes any part of a task's title, so nothing needs quoting. An exact title wins over a longer
task that contains it, and anything still ambiguous is listed rather than guessed at.

| Command | What it writes | Counts as a touch |
| --- | --- | --- |
| `promote <title>` | `#active`, up to the cap | Yes |
| `schedule <title> <date>` | A `📅` date, and `#someday` if the date is past the horizon | Yes |
| `abandon <title>` | A cancelled box and an `❌` date, and takes the state tag off | No |

All three refuse, without writing, on a recurring task and on one already tagged `#done` or
`#abandoned`. Every refusal names what it refused and changes nothing.

Abandoning is not a touch: the box is closed, so the clock drops the task on the next run rather
than carrying a timestamp nothing will read. Promoting and scheduling are touches, which is what
lets scheduling answer a stalled task.

There is deliberately no command that clears a stall without changing anything. A stalled task is
answered by naming a date, by dropping it, or by actually working on it, since an edit to the line
or its notes is itself a touch. A bare reset button would be the cheapest possible answer, and a
signal that can be dismissed for free stops being a signal.

Unlike the migration, these do not check git first. The migration rewrites lines across dozens of
files at once and needs a one-command undo; these each rewrite one line, and the line-match check
already refuses to overwrite anything it didn't read.

### Dates

`schedule` takes `YYYY-MM-DD` or `+Nd`, resolved as local dates. A date already gone by is refused
rather than written, and a day that doesn't exist (`2026-02-30`, which the Date constructor would
quietly roll into March) is refused too.

A date inside the horizon leaves the task where it is, holding its place on the active list if it
had one: naming a day inside the next few weeks is a commitment, not a deferral. A date beyond the
horizon is not a plan, so the task moves to `#someday`, which frees its place if it had one.

## Migration

One pass, run once. `tasks migrate` prints a diff and stops; `tasks migrate --apply` writes.

| Source | Target |
| --- | --- |
| `[ ]` open, no `🔁` | `#someday` |
| `[ ]` open, with `🔁` | left untagged |
| `[x]` completed | left untagged |
| `[-]` cancelled | left untagged |
| already tagged | left alone |

Everything open goes to `#someday`. No heuristic promotes anything to `#active`, because recency,
priority, and tag proximity would each invent commitments that were never made. `#active` starts
empty and you fill it by hand, up to the cap.

Finished tasks are left untagged rather than tagged `#done` or `#abandoned`. The checkbox already
records them, the done list reads the `✅` date rather than a tag, and the cap only counts tasks
whose box is open, so the tag would be inert everywhere. On a reusable checklist it would be worse
than inert: it would freeze the last run's ticks into the template.

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
