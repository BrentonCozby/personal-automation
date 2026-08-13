// The provider-neutral shape the rest of the app depends on, isolated from any one backend so a
// new source (e.g. a Google Tasks one) is a drop-in replacement. No backend's terms leak past here.
export type Task = {
  id: string
  title: string
  notes: string | null
  /**
   * The provider's own record of the task, verbatim — for Obsidian, its Markdown line and the
   * notes indented under it. Hashed by the touch clock so any edit counts as a touch; never shown
   * to the user and never sent to the model.
   */
  raw: string
  /** Creation timestamp — drives staleness (the task's age). Null if the provider can't supply one. */
  created: Date | null
  /** Last-modified timestamp; staleness falls back to it only when created is missing. */
  lastModified: Date | null
  /** Due date if set. Future = scheduled (the provider's own alert handles it); past = stalled signal. */
  due: Date | null
  list: string
}

export type TaskSource = {
  list: () => Promise<Task[]>
}
