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
  // The name passed to `claude -n`, or the title Claude Code wrote for the
  // session itself. Both arrive here, so a value is what the session calls
  // itself rather than proof that you named it: 54 of the 55 titles in the real
  // log are kebab-case `-n` names, and the one that is not ("edit customer
  // hidden error") is Claude Code's own.
  session_title: z.string().optional(),
  notification_type: z.string().optional(),
  transcript_path: z.string().optional(),
  // The Claude Code process id. Claude Code execs hook commands without an
  // intervening shell, so the hook's parent is `claude` itself.
  hook_ppid: z.number().int().optional(),
})
