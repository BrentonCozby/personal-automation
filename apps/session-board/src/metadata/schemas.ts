import { z } from 'zod'

export const sessionMetadataSchema = z.object({
  name: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  parkedReason: z.string().min(1).optional(),
  progressPath: z.string().min(1).optional(),
  // The last two carry a session the hook log has never seen, imported from
  // somewhere that watched it earlier. Nothing the board itself writes sets
  // them: for a session with events, both come from the events instead.
  /** Unix seconds of the session's last known activity. */
  lastActive: z.number().positive().optional(),
  cwd: z.string().min(1).optional(),
  // Taken off the board by hand. The row has to stay behind to say so: a
  // session that carries a title claims itself the moment it has no row at all,
  // so plain removal is undone before the next snapshot reaches the screen.
  isDismissed: z.boolean().optional(),
  /**
   * Unix seconds of the resume click that opened a fresh session for this row.
   *
   * Resuming a row with a progress file starts a new session in a new terminal
   * rather than reopening the old conversation, so the two ids share no process
   * and the handover pairing cannot see the link. This is the only record that
   * they are the same work, until the two are paired and `supersededBy` takes
   * over.
   */
  relaunchedAt: z.number().positive().optional(),
  /**
   * The session this one was relaunched into. All that is left of a row once its
   * work moved on, and the whole entry: no name, no group, nothing to draw.
   *
   * A `/clear` handover is read from the event log, which keeps it forever. A
   * relaunch is only ever recorded here, so deleting the row would lose it, and
   * an id the board itself launched carries a `session_title` that claims a
   * fresh row the moment it has none.
   */
  supersededBy: z.string().min(1).optional(),
})

// Keyed by session id. A row existing is what makes a session claimed, which is
// why there is no `claimed` field and no `state`: parked is exactly
// `parkedReason` being set, and finishing with a session deletes its row.
export const metadataFileSchema = z.record(z.string().min(1), sessionMetadataSchema)
