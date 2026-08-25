import { z } from 'zod'

export const hookEventSchema = z.object({
  // A plain string rather than a union of the events we know about. An event
  // name from a newer Claude Code has to survive the parse: if it did not,
  // upgrading the CLI would quietly empty the board instead of failing loudly.
  hook_event_name: z.string().min(1),
  session_id: z.string().min(1),
  t: z.number().int(),
  cwd: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  // Only ever the name passed to `claude -n`. The title Claude generates from
  // your first prompt reaches the terminal tab but never the hook payload, so
  // a value here always means you named the session yourself.
  session_title: z.string().optional(),
  notification_type: z.string().optional(),
  transcript_path: z.string().optional(),
  // The Claude Code process id. Claude Code execs hook commands without an
  // intervening shell, so the hook's parent is `claude` itself.
  hook_ppid: z.number().int().optional(),
})
