# Due-date alerts and decay

Design settled 2026-08-13. Not built.

## What this adds

Two things the twice-weekly review cannot do.

**Alerts.** The review never mentions a missed chore. `countsTowardCap` (`state/wip.ts:23`) requires
`!isRecurring`, and `isStalled` returns false on that check, so a recurring task can never appear in
the digest. The done list does report recurring tasks that were completed. Today the review
congratulates chores done and never chases chores missed. "Give Dolly her meds" and "water the
schefflera" are the cases this exists for.

**Decay.** An `#active` task can sit untouched forever and keep holding a cap slot. Nothing frees it.

## The job

One command, `tasks alert`, run by launchd at 08:00 and 19:00. Both passes do the same thing: alert
on what is due, and demote what has decayed.

The evening pass exists because a single morning banner is easy to dismiss half-asleep, which is how
a dose gets missed. It names what is still not done.

Decay runs on both passes rather than the morning only, because the second pass is a no-op: a task
demoted at 08:00 carries `#someday` by 19:00 and is no longer decayable, and the threshold is
calendar-day arithmetic that changes only at midnight. A `--with-decay` flag was designed and then
dropped, because it bought nothing and forced a second launchd agent to carry the different
arguments.

One vault read, one `tasks-edit.lock`, one touch-clock save per pass. That is the lock the one-line
commands already take, so a pass cannot race a `promote` or an `abandon`. It is deliberately not the
review's `tasks.lock`.

## Due-date alerts

Notify only. This half writes nothing to the vault, which holds the model's rule that nothing writes
a tag onto a task you left alone (`docs/task-state-model.md:41`) and avoids colliding with
`TASKS_WIP_CAP`.

A task is alerted when it is open and its due date is today or earlier. How long it keeps being
alerted differs by kind:

- **Recurring (`🔁`)**: every day it is due or overdue, with no limit, until it is ticked. This falls
  out of the vault's own behavior: the Tasks plugin only rolls the date forward when you tick the
  box, so an unticked recurring task keeps its past date. These are the primary case, which makes
  this the first rule in the model that treats recurring tasks as in scope rather than excluded.
- **Everything else**: alerted while `calendarDaysBetween({ from: due, to: now })` is less than
  `TASKS_DUE_ALERT_DAYS`. At the default of 7 that is the due day plus the six after it, seven
  pushes, and then it stops and the twice-weekly review takes over. Without the taper, the two tasks
  dated 2026-07-18 would have nagged daily since then.

State tags are not read here, so a dated `#someday` task alerts the same as a dated `#active` one.
Confirmed deliberately: putting a date on something is the reason to want reminding of it, and
scheduling past the horizon is exactly how a task lands in `#someday` still holding a date.

## Decay

An `#active`, non-recurring, open task untouched for `TASKS_HORIZON_DAYS` (28) days has `#active`
stripped and `#someday` written. Its cap slot is freed. `tasks promote` puts it back.

It demotes rather than closing the checkbox, because the machine dropping a commitment the user never
agreed to drop is the wrong outcome, and terminal states refuse every command, so reviving one means
hand-editing the vault. Leaving the tag and simply not reporting it was also rejected: that keeps a
provably inactive task holding a slot.

Reuses `untouchedDays` from `state/stall.ts`. Skips any task `notEditable` refuses, which for this
set means a line carrying two state tags.

**Decay is not a touch, and keeping that true takes explicit work.** `reconcileTouchClock`
(`state/touch-clock.ts:85`) stamps `now` on any task whose fingerprint has changed, so rewriting the
line would make the *next* run read the demotion as a touch. The decay path therefore updates the
stored entry's fingerprint to the newly written line while carrying the stored `lastTouched`
forward. That needs one new function beside `recordTouch`, taking a key and a fingerprint and
leaving the timestamp alone.

The drift would in fact be invisible today, since nothing reads `lastTouched` for a `#someday` task
and `promote` stamps a fresh touch on the way back. The fingerprint is kept honest anyway, because
the alternative is a stored value that is quietly wrong and a future reader who trusts it.

Two doc comments state the wrong reason for this rule and must be rewritten: `recordTouch`'s
("Decay is not: the task is terminal by the time it decays") and `docs/task-state-model.md:99`. Decay
is still not a touch, but the reason is that the user did not touch it, and stamping it would hide
how long it has been ignored. `docs/task-state-model.md:104` stays correct.

## The push

Pushover, verified end to end against the live API on 2026-08-13: a banner fired, it made a sound,
and its `url` opened Obsidian on the dashboard.

```
POST https://api.pushover.net/1/messages.json
  token, user   from the monorepo-root .env
  title         Due today (2)
  message       • give Dolly her meds
                • water the schefflera
  url           obsidian://open?vault=iphone&file=Todos/Dashboard.md
  url_title     Open the dashboard
  priority      0
```

- **Priority 0, and no repeats.** Two passes a day are the redundancy. Pushover's priority 2 repeats
  until acknowledged and was tested and rejected: sending once per pass is enough, and a task ticked
  in Obsidian drops off the next pass on its own.
- **Items are separated by a literal `•`, and the message carries no HTML.** Pushover strips HTML
  tags when showing a message as a notification and only renders them once the app is opened, so
  `<b>` is useless in the banner, which is the only part that has to be readable. A bullet survives.
- **Limits**: 1024 UTF-8 characters for the message, 250 for the title. Long lists are truncated with
  a final line naming the count left out, rather than being cut mid-title.
- **The deep link targets `Todos/Dashboard.md`**, the Tasks-plugin view the user actually reads, not
  `todos.md`. Opening Obsidian is part of the point: it puts the other active tasks in front of them.
  Both `obsidian://open` and `obsidian://adv-uri` were tested and work; `open` is used because it
  needs no plugin installed in the phone's vault.
- **A demotion is announced, and is its own reason to send.** The push carries a
  `Moved to someday (N)` section and goes out even when nothing is due. The machine is dropping a
  commitment the user did not drop, so they learn it when it happens, on the channel they read. In
  practice this lands on the 08:00 pass, since the 19:00 one has nothing left to demote.
- **Silence needs both halves empty.** Nothing due and nothing demoted sends nothing.

ntfy was the original choice and was rejected after testing on the real phone. Three pushes landed
inside the ntfy iOS app and none produced an iOS banner, with notifications enabled. ntfy's own
documented fix (unsubscribe, re-subscribe) changed nothing. Its iOS improvement plan
(https://github.com/binwiederhier/ntfy/issues/1680) lists "push notifications stop arriving with no
visible error" as affecting every user and only "probably fixed", and no sound on iOS 26+ as 100%
reproducible and open. The user is on iOS 26+.

## Modules

```
src/commands/alert.ts     runAlert: one runWithLock, one withTaskClock, both halves
src/state/due.ts          which tasks alert, pure
src/state/decay.ts        which tasks demote, pure
src/alert-message.ts      renders title + message, pure
src/pushover/client.ts    createPushoverClient, the POST
src/pushover/schemas.ts   zod for the response
launchd/run-tasks-alert.sh  wrapper, notifies macOS on a non-zero exit
```

`runAlert` returns a union, the same shape the digest uses: `silent` (with a reason), `dry_run`
(carrying the rendered title and message), or `sent`.

## Config

New in the monorepo-root `.env`, because they are secrets: `PUSHOVER_TOKEN`, `PUSHOVER_USER_KEY`.
Already written, with placeholders in `.env.example`.

New in `apps/tasks/.env`: `TASKS_DUE_ALERT_DAYS=7`, and `TASKS_ALERT_URL` holding the whole deep link
rather than composing it from a vault name and a path, so there is one value to check against what
was tested.

`TASKS_ALERT_TIMES=["08:00", "19:00"]` is read only by the plist generator at setup time, never by
the app, exactly as `TASKS_SCHEDULE` already is. `config.ts` does not know it.

## launchd

`generate-launchd-plist.ts` grows to emit two plists instead of one: the existing digest agent plus
`com.personal-automation.tasks-alert`. One agent covers both passes, because they run identical
arguments. Its `StartCalendarInterval` array holds one entry per time in `TASKS_ALERT_TIMES`, each
carrying `Hour` and `Minute` and no `Weekday`, which fires it every day.

The wrapper is `launchd/run-tasks-alert.sh`, modelled on `run-tasks-digest.sh`: it runs the command
and posts a macOS notification on a non-zero exit.

Accepted limit: the job runs from launchd on the Mac, so an alert fires on wake rather than on time
if the Mac is asleep.

## Errors

A failed Pushover POST fails the run, so the wrapper's macOS notification fires. A silently dropped
meds alert is the worst outcome this design has, worse than a noisy failure. Same call as the
review's model call.

A decay write that conflicts (the line moved while the pass was reading it) skips that task and the
run continues. The next pass picks it up.

## Testing

`state/due.ts` and `state/decay.ts` are pure and take `now`, so they are unit-tested directly,
including across a daylight saving boundary with `TZ` pinned, as `days.test.ts` already does.

The Pushover POST is asserted against msw, checking the exact form fields, so no test reaches the
network. One end-to-end test covers a run that alerts and demotes together.

Coverage stays above the 80/80/80/75 gate.

## What this does not do

- No new state tag, and no marker for "this one is important". Priority is one value per push.
- Nothing is written by the alert half.
- Recurring tasks stay outside the cap, the stall rule, and decay. This changes only whether they can
  be alerted on.
