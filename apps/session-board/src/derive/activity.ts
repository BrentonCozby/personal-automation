import type { HookEvent } from '../events/types.js'

/**
 * What a session is doing, read from its events alone.
 *
 * `ended` means Claude Code told us the session is over. It is separate from a
 * dead process, which `liveness.ts` covers, because a session can end cleanly
 * while its terminal stays open and can die without ever reporting anything.
 */
export type Activity = 'running' | 'waiting' | 'idle' | 'ended'

const ACTIVITY_BY_EVENT: Record<string, Activity | undefined> = {
  UserPromptSubmit: 'running',
  ElicitationResult: 'running',
  Stop: 'idle',
  StopFailure: 'idle',
  SessionStart: 'idle',
  SessionEnd: 'ended',
}

const ACTIVITY_BY_NOTIFICATION: Record<string, Activity | undefined> = {
  permission_prompt: 'waiting',
  elicitation_dialog: 'waiting',
  idle_prompt: 'idle',
}

function activityFor(event: HookEvent): Activity | undefined {
  if (event.hook_event_name === 'Notification') {
    if (!event.notification_type) return undefined

    return ACTIVITY_BY_NOTIFICATION[event.notification_type]
  }

  return ACTIVITY_BY_EVENT[event.hook_event_name]
}

/**
 * Read a session's current activity off its own events, newest first.
 *
 * Approving a permission prompt leaves the session reading `waiting` until the
 * turn ends. Clearing it the moment the tool runs would mean logging every
 * PreToolUse, and a single turn fires dozens of those into an append-only file.
 */
export function deriveActivity(events: HookEvent[]): Activity {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue

    const activity = activityFor(event)
    if (activity) return activity
  }

  return 'idle'
}
