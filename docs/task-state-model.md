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

The checkbox records finishing and dropping; no tag does. A ticked or cancelled box already
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
its recurrence rule and due date, so none of the stored states describe it, and any date
written by hand would fight the plugin for control of it. They never count toward the cap, never
decay, and never stall. The one rule that does read them is the due-date alert, which reads the date
the plugin manages and writes nothing (see [Due-date alerts](#due-date-alerts)).

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
infer it from the next run's fingerprint. Promotion and scheduling count as touches. Decay does not,
because the user did not touch it: stamping it would hide how long the task had been ignored. The
decay write therefore stores the rewritten line's fingerprint against the timestamp already held, so
the next run reads the line as unchanged.

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
raw timestamps and flooring loses an hour across a spring-forward: a 30-day span reports 29 and
every threshold fires a day late.

Tests pin `TZ` explicitly rather than trusting the machine's zone, and cover both the spring-forward
and fall-back boundaries.

## Thresholds

They all live in `apps/tasks/src/config.ts` and nowhere else.

| Setting | Default | Used by |
| --- | --- | --- |
| `TASKS_WIP_CAP` | 3 | Promotion. |
| `TASKS_STALL_DAYS` | 7 | The computed stalled state, which is what the review reports. |
| `TASKS_HORIZON_DAYS` | 28 | Decay threshold and scheduling ceiling, read from this one value. |
| `TASKS_DONE_WINDOW_DAYS` | 7 | How far back the done list reaches, counting today. |
| `TASKS_DUE_ALERT_DAYS` | 7 | Days a dated one-off task keeps being pushed about. Recurring tasks ignore it. |
| `TASKS_OVERRIDE_WINDOW_DAYS` | 30 | How far back the review counts raised caps, counting today. |
| `TASKS_OVERRIDE_LIMIT` | 3 | Raises inside that window before the review suggests raising the cap for good. |

The decay threshold and the scheduling ceiling are the same number because they are the same claim
about how far ahead you can honestly see. A date past the horizon is routed to `#someday`.

The done window is deliberately its own number rather than a reuse of the stall window. They are
different claims: one is how long silence on a commitment is tolerable, the other is how far back a
record of what you did stays worth reading.

## Scope

`TASK_LISTS` decides which files hold tasks, for the migration and the digest alike. Both read the
same setting, so neither can look at a file the other ignores.

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

No provider seam sits above them. Every reader and writer here is Obsidian-specific, and the
state model is Obsidian-shaped throughout: tags on the line, checkbox statuses, `✅`/`❌` dates. A
provider-neutral task type in front of that would be a seam holding nothing, because a second
backend would have to reproduce the whole model rather than supply a list of tasks. The scanner and
the writer are the seam; a second backend moves them.

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

No command clears a stall without changing anything, deliberately. A stalled task is
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

The scanner reads the vault's own `📅` markers through the same check, so a day typed by hand in
Obsidian that does not exist leaves the task undated rather than alerting on the day it rolls into.
The task still reaches the review once it goes quiet.

A date inside the horizon leaves the task where it is, holding its place on the active list if it
had one: naming a day inside the next few weeks is a commitment, not a deferral. A date beyond the
horizon is not a plan, so the task moves to `#someday`, which frees its place if it had one.

## The review

The scheduled digest reads `#active` and nothing else. `#someday` is a holding pool and untagged is
the permanent steady state, so counting or reporting either one would turn the whole vault back into
a backlog to answer for.

A task is reported when it is `#active`, has no touch inside the stall window, and carries no date
still ahead of it. The date rule and the stall rule cannot fight each other, because scheduling is
itself a touch: naming a day both resets the window and puts the date in the future.

Quiet tasks are listed **closest to done first**, the same order the cap reports (see [Ordering by
closest to done](#ordering-by-closest-to-done)). Nothing else about the order is a ranking, and
nothing asks the model for one.

**There is no ask to make in two cases.** No task is `#active`, or nothing has gone quiet. A message
saying you have committed to nothing is exactly the deficit feeling this model exists to prevent, and
a message saying everything is moving is a notification about the absence of a problem. A report that
always arrives has to find something to say, and what it finds is fault.

Each reported task gets three ways out, and the email prints all three: do the next physical step
(the model names it), give the task a date, or drop it. Not promotion, which would make no sense for
a task already on the active list.

All three are written as things to do in Obsidian, not as commands to paste. The email is read on a
phone, where there is no shell, and the vault is where tasks are edited in the first place. A
runnable line would name an action the reader cannot take from what they are holding.

Only the quiet tasks are sent to the model, so at most `TASKS_WIP_CAP` tasks are analysed instead of
every open task in the vault.

### The done list

The other half of the review is the record of what the last `TASKS_DONE_WINDOW_DAYS` days produced:
what was finished, what was dropped, and how many of the tasks being carried moved at all.

**It sends on its own.** A review with nothing quiet in it still goes out when something was finished
or dropped, and it costs no model call to build. This is the one thing the whole model would be
missing without it: a to-do list can only ever show you the shortfall, so the counterweight has to be
able to arrive on a week when nothing is wrong. Tying it to a quiet task would mean the record of your
wins only ever appeared next to a complaint, and a clean week would show nothing at all.

Silence therefore needs both halves to be empty: nothing quiet, and nothing closed inside the window.
The note about the cap (see [Overrides](#overrides)) is not a third half. It rides along on a review
that was already sending, so it can wait for the next one.

Dropping is reported as a result rather than a gap, because choosing what not to carry is the
mechanism the cap runs on. A count of zero is left out rather than printed as a zero, since a row of
noughts is a scorecard, and there are no streaks, no percentages, and no count of `#someday`.

The done list comes straight from the `✅` and `❌` dates on the line, so no extra state has to be
kept anywhere (see [States](#states)). A task can appear in two consecutive reviews when the windows
overlap. That is accepted: seeing a win
twice costs nothing, and the alternative is a stored last-reviewed date that the vault can already
answer for itself.

The review is also what keeps the touch clock current between edits, since it reconciles the clock
like every other command. Reviewing a task is not touching it, so the clock goes back unchanged
apart from that reconcile.

Register: the email says "gone quiet" and "untouched for N days". It never says overdue, failing,
behind, or should have. The model is given the same rule, because its reasoning is printed as
written.

## Due-date alerts

A daily job pushes what is due to the phone, at each time in `TASKS_ALERT_TIMES`. It reads the vault
once and saves the touch clock once per pass, under `tasks-edit.lock`: the lock the one-line commands
already take, and deliberately not the review's `tasks.lock`, so a pass cannot race a `promote` or an
`abandon`. Holding a different lock from the review means nothing stops the two agents saving the
clock at the same second, and each save writes the whole file, so the plist generator refuses an
alert time on a minute `TASKS_SCHEDULE` already names. The schedules are what keep them apart.

The rule is: open, dated, and the date has arrived or gone by. No state tag is read, so a dated
`#someday` task alerts exactly like a dated `#active` one. Putting a date on something is the reason
to want reminding of it, and the holding pool is a claim about what you are carrying now, not about
what a calendar already says.

Recurring (`🔁`) tasks are in scope here and nowhere else in the model. The cap, the stall rule and
decay all exclude them, so until this job existed the only thing the system ever said about a chore
was congratulations: the done list reports recurring tasks that were completed, and nothing could
report one that was missed. Closing that asymmetry is why this half exists.

How long a task keeps being asked about depends on its kind. A recurring one is pushed every day
until it is ticked, with no limit, because the Tasks plugin rolls its date forward only on the tick,
so a date still in the past is exactly the signal that the chore was missed. Everything else is
pushed for `TASKS_DUE_ALERT_DAYS` days from its due date and then left to the twice-weekly review,
which is what stops a task dated months ago pushing daily forever.

Two passes a day run the same query, and both are silent on an empty list. The evening one exists
because a single morning banner is easy to dismiss half awake, which is how a dose gets missed. It
names what is still not done.

The channel is Pushover, at normal priority: one banner, one sound, no repeat. Two passes a day are
the redundancy, and a task ticked in Obsidian drops off the next pass on its own. Pushover's
priority 2, which repeats until acknowledged, was tested and rejected on those grounds. The message
carries no HTML, because Pushover strips tags out of the notification and renders them only once the
app is opened, and the notification is the only part that has to be readable. A `•` separates the
items for the same reason: shown as one run of text, newlines alone do not read as separate items.
The limits are 1024 UTF-8 bytes for the message and 250 for the title, and a list too long to fit is
truncated with a final line naming the count left out, rather than cut mid-title.

Tapping the push opens `TASKS_ALERT_URL`, an Obsidian deep link to the dashboard note
(`Todos/Dashboard.md` on this vault) rather than to `todos.md`, because the dashboard is what gets
read, and opening the vault puts the rest of the active list in front of you. The link is an
`obsidian://open` one rather than `obsidian://adv-uri`: both were tested and work, and `open` needs
no plugin installed in the phone's vault.

ntfy was the original choice and was rejected after testing on the real phone. Three pushes landed
inside the ntfy iOS app and none produced an iOS banner, with notifications enabled, and the fix
ntfy documents (unsubscribe, then re-subscribe) changed nothing. Its own iOS improvement plan
(https://github.com/binwiederhier/ntfy/issues/1680) lists silent delivery failure as affecting every
user and only probably fixed, and no sound on iOS 26+ as reproducible and open. This phone runs
iOS 26+.

A failed Pushover POST fails the run, so the wrapper's macOS notification fires. A silently dropped
meds alert is the worst outcome this half has, worse than a noisy failure. The job also runs from
launchd on the Mac, so an alert fires on wake rather than on time if the Mac is asleep.

This half writes nothing. Nothing is tagged, dated or promoted because it came due. That holds the
rule that nothing writes a tag onto a task you left alone, and it keeps a due date from pushing the
active list past `TASKS_WIP_CAP` on a morning you had no say in.

## Decay

An `#active`, non-recurring, open task that nothing has touched for `TASKS_HORIZON_DAYS` days has
`#active` stripped and `#someday` written in its place, which frees its slot against the cap.
`tasks promote` puts it straight back.

It demotes rather than closing the checkbox. Closing it is what `abandon` does, and doing that here
would be the machine dropping a commitment you never agreed to drop; terminal states also refuse
every command, so reviving one means editing the vault by hand. The other option was leaving the tag
alone and just not reporting the task, and that keeps a task proven inactive holding a slot against
the cap.

A demotion is announced in the push, and is a reason to send one even when nothing is due. The
machine changed something you did not ask it to change, so you learn it the moment it happens, on
the one channel you read. Holding it for the twice-weekly review would delay the news by up to three
days and would need a new section in the review to carry it.

It runs on both passes, and the evening one is a no-op: a task demoted in the morning carries
`#someday` by the evening, and the threshold is calendar-day arithmetic that changes only at
midnight. A `--with-decay` flag was designed and dropped: it bought nothing, and it would have forced
a second launchd agent to carry the different arguments.

A line carrying two state tags is never demoted: it holds no slot against the cap, so there is
nothing to free (see [States](#states)). A line that moved while the pass was reading it fails the
line-match check, and
the pass reports it and carries on to the next one rather than failing, because the push still has
to go out. The next pass picks it up.

Decay is not a touch (see [The touch clock](#the-touch-clock)).

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

Before writing, the pass checks that git tracks each file it would modify and that none of them has
unstaged changes, then reports the ones that fail and exits without writing. The check is per file
rather than whole-tree, because `.obsidian/plugins/` carries permanent uncommitted churn and a
whole-tree cleanliness check would never pass. Per-file tracking is also what makes the revert a
scoped `git checkout` rather than one that would discard plugin state.

Quit Obsidian before applying. Writing across dozens of files while Sync is live invites conflicts
that the per-line fingerprint check will refuse, leaving the pass half-applied.

## Tag placement

State tags go at the end of the description text, before the first Tasks-plugin emoji:

```text
- [ ] heath ceramics second hand #someday ➕ 2025-05-23
```

Placing a tag after the emoji metadata risks it being absorbed into the trailing signifier's value.
The title parser strips state tags, so they never reach the digest or the task's identity.

## Ordering by closest to done

Two places use one order: promotion at the cap names the current `#active` items, and the review
lists the quiet ones. Both put the most recently touched first, with the soonest due date breaking
ties. Longest-untouched-first was tried and reversed: it points at the task hardest to restart, when
finishing one thing beats resuming everything.

No completion data exists to work from. The vault contains no subtasks anywhere, so no completion
fraction exists, and no task carries an effort estimate. Momentum is the only signal the data
actually holds: the task you touched yesterday is the one you are part way through. Asking the model
for an estimate would put a call taking tens of seconds inside an interactive command.

Both places name the proxy in what they print, so the ordering is never mysterious.

## Overrides

Raising the cap for a single invocation is a legitimate use of the system. It requires no reason,
prints no warning, and is not an error.

Each override appends one line to `apps/tasks/runs/overrides.jsonl`, carrying the cap in force at the
time and how many tasks were already active. One file holds every entry, so the nightly sweep that
trims JSONL older than 90 days skips it by name: an mtime rule would delete the whole ledger rather
than rotate it. More than `TASKS_OVERRIDE_LIMIT` of them inside
`TASKS_OVERRIDE_WINDOW_DAYS` days and the review suggests raising the default cap, on the grounds
that a rule routed around this often is a rule that does not fit. It never suggests trying harder.

The number it suggests is one more than the largest `active_count` on record, which is the most you
actually carried. Suggesting one more than the current cap would contradict the system's own record
of what you chose.

Only raises recorded against the cap now in force are counted, so raising `TASKS_WIP_CAP` retires
every entry written under the old value and the count starts again from zero. That is what silences
the suggestion, and it is why nothing has to store the fact that the suggestion was made. Setting the
cap back down brings the old entries back into the count for the rest of the window.

A line the reader cannot parse fails the run rather than being skipped: an undercount would show up
only as a suggestion that never arrives, which is not something anyone would notice.

Override records must stay out of `apps/*/audit/`. The `notify` app globs that path and would mail
them to you as failures.
