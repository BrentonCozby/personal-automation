// The provider-neutral shape the rest of the app depends on, isolated from any one backend so a
// new source (e.g. a Google Tasks one) is a drop-in replacement. No backend's terms leak past here.
export type Task = {
  id: string
  title: string
  notes: string | null
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
