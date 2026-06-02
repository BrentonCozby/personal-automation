# stalled-tasks plan

**v1 has shipped.** The code and the repo `README.md` (the `stalled-tasks` section) are the
source of truth for how it works — reading Reminders via the compiled `reminders-bridge`,
creation-date staleness, the Anthropic classification, ranking, the HTML/plain-text digest, and
the macOS/TCC setup. This file now tracks only the deferred **v2** design.

## v2 — approval-gated edits (deferred)

Deferred behind the v1 kill-criterion. v1 ships read-only and answers two questions first: (a)
does the digest change my behavior, and (b) are its suggested edits mostly ones I'd approve?
Only when both are yes does write-back earn its place. Autonomous write is never the shape —
Reminders has no undo, the model is guessing at next-actions/decompositions, and silent edits
would break v1's "capture is consequence-free" guarantee. Every write goes through **propose →
approve → apply**: the digest proposes, I approve per item, the app applies. Nothing mutates
Reminders until I've seen exactly what will change.

### Edit types (rough value order)

- **Rewrite to next action** — replace an `aversion` task's vague title with its
  `suggested_next_action`. Keep the original phrasing in the task notes so the project context
  isn't destroyed (`book india flights` moves to the note; the title becomes the startable step).
- **Decompose a project** — for tasks that are really projects, create child reminders for the
  steps (Reminders supports subtasks). Pattern: rename the parent to the first next action, add
  children for the rest, keep the original title as a parent note. Highest-judgment edit, so
  always approval-gated and never auto-applied — the model can't know steps it wasn't told.
- **Move blocked → waiting** — relocate `blocked` tasks to a dedicated "Waiting" list and
  rewrite the title as the unblocking action. Out of the active list without losing them (the
  GTD waiting-for pattern).
- **Tags** — only if a context-block workflow ever materializes to consume them. A tag with no
  receiving block is decoration.

### Approval surface (two candidate shapes — pick at build time)

- **Reply-to-approve.** The digest numbers each proposed edit; I reply with the ones I approve
  ("1, 3, 5"). The next run reads the reply via Gmail (`gmail.readonly` was already consented by
  `bootstrap`) and applies them. No new hosted service; rides the email channel I already check.
  Async — edits land on the following run, not instantly.
- **Interactive `--review`.** A command I run on the Mac that walks each proposed edit and
  applies on keypress. Simpler to build, synchronous, fully in my control — but a new sit-down
  behavior with its own initiation friction, so likelier the occasional deep review than the
  scheduled default.

### Build prerequisites

- **Write via the existing bridge.** `reminders.swift` already uses EventKit, so writes are
  `EKReminder` create/modify + `EKEventStore.save` in the same binary. The note→title rewrite
  must preserve the original title in the task's notes.
- **TCC already covers it.** v1's grant is `requestFullAccessToReminders` (full read+write) for
  the `reminders-bridge` identity, so write needs no new permission — re-check on first write in
  case macOS treats the first mutation as a fresh prompt.
- **Idempotency.** An approved-and-applied edit must not be re-proposed next week. Record applied
  edits (a note marker, or an applied-ids file in `runs/`) so the analyzer doesn't loop on the
  same task.
