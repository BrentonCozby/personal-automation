// The shape the rest of the app depends on, isolated from the bridge so a future
// GoogleTasksSource is a drop-in replacement for AppleRemindersSource.
export type Task = {
  id: string
  title: string
  notes: string | null
  /** Creation timestamp — drives staleness (the task's age). Null if the bridge can't supply one. */
  created: Date | null
  /** Last-modified timestamp; staleness falls back to it only when created is missing. */
  lastModified: Date | null
  /** Due date if set. Future = scheduled (handled by Reminders' own alert); past = stalled signal. */
  due: Date | null
  list: string
}
