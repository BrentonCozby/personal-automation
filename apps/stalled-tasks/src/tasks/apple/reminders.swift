// Reads open (incomplete) Apple Reminders via EventKit and prints them as JSON to stdout.
// source.ts compiles this into the `reminders-bridge` binary and runs it. The contract:
//   success      → {"reminders":[{id,title,notes,list,created,lastModified,due,recurring}, ...]}
//   no access    → {"error":"not_authorized","status":<rawValue>}
//   fetch failed → {"error":"fetch_failed"}
// Dates are ISO 8601 strings or null. source.ts maps an "error" payload to a thrown AppError,
// so a permission problem can never masquerade as "nothing is stalled".

import EventKit
import Foundation

struct ReminderOut: Codable {
  let id: String
  let title: String
  let notes: String?
  let list: String
  let created: String?
  let lastModified: String?
  let due: String?
  // Recurring reminders are time-triggered (their own alert handles them), so the reader
  // drops them — the digest is for the untriggered backlog, not the alert channel.
  let recurring: Bool
}

struct BridgeOutput: Codable {
  let reminders: [ReminderOut]
}

func emit(_ json: String) {
  print(json)
}

func fail(_ json: String) -> Never {
  print(json)
  exit(1)
}

// macOS attributes a Reminders-access request to the process's "responsible process", which a
// child inherits from its parent. Launched by Node (Volta), that resolves to volta-shim — an
// identity Volta's execve makes impossible to grant, so the consent prompt reappears forever.
// On first entry we re-spawn ourselves with responsibility disclaimed; the disclaimed child is
// its own responsible process, so the prompt and grant attach to this binary (reminders-bridge)
// and hold under launchd. responsibility_spawnattrs_setdisclaim is a private libSystem symbol —
// stable for years, and the standard fix for CLI tools needing TCC access under launchd/cron.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

func selfExecutablePath() -> String {
  var size: UInt32 = 0
  _ = _NSGetExecutablePath(nil, &size)
  var buffer = [CChar](repeating: 0, count: Int(size))
  guard _NSGetExecutablePath(&buffer, &size) == 0 else { return CommandLine.arguments[0] }
  return String(cString: buffer)
}

func reexecWithResponsibilityDisclaimed() -> Never {
  let path = selfExecutablePath()
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  _ = responsibility_spawnattrs_setdisclaim(&attr, 1)

  let argv: [UnsafeMutablePointer<CChar>?] = [strdup(path), nil]
  var environment = ProcessInfo.processInfo.environment
  environment["BRIDGE_DISCLAIMED"] = "1"
  let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]

  var pid = pid_t()
  let spawnResult = posix_spawn(&pid, path, nil, &attr, argv, envp)
  posix_spawnattr_destroy(&attr)
  if spawnResult != 0 { fail("{\"error\":\"spawn_failed\"}") }

  // The child inherited our stdout, so it has already written the JSON there. Mirror its exit.
  var childStatus: Int32 = 0
  waitpid(pid, &childStatus, 0)
  exit(childStatus == 0 ? 0 : 1)
}

// First invocation re-spawns itself disclaimed; only the disclaimed child runs the work below.
if ProcessInfo.processInfo.environment["BRIDGE_DISCLAIMED"] == nil {
  reexecWithResponsibilityDisclaimed()
}

let store = EKEventStore()
var status = EKEventStore.authorizationStatus(for: .reminder)

// Not-yet-asked → request once. Under launchd this shows the system prompt in the GUI session;
// granting it records access for the agent's responsible process so later runs read silently.
// The 60s timeout keeps an unattended run from hanging forever on an unanswered prompt — it
// just fails cleanly as not_authorized. An already-denied status can't re-prompt (the user
// must grant in System Settings), so we don't request in that case.
if status == .notDetermined {
  let authSemaphore = DispatchSemaphore(value: 0)
  store.requestFullAccessToReminders { _, _ in authSemaphore.signal() }
  _ = authSemaphore.wait(timeout: .now() + 60)
  status = EKEventStore.authorizationStatus(for: .reminder)
}

guard status == .fullAccess else {
  fail("{\"error\":\"not_authorized\",\"status\":\(status.rawValue)}")
}

let iso = ISO8601DateFormatter()
func isoString(_ date: Date?) -> String? { date.map { iso.string(from: $0) } }
func dueString(_ components: DateComponents?) -> String? {
  guard let components, let date = Calendar.current.date(from: components) else { return nil }
  return iso.string(from: date)
}
func cleanNotes(_ notes: String?) -> String? {
  guard let notes, !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
  return notes
}

let semaphore = DispatchSemaphore(value: 0)
// nil calendars = every reminder list; the incomplete predicate with nil date bounds returns
// all open reminders, including those with no due date.
let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
var fetched: [EKReminder]?
store.fetchReminders(matching: predicate) { reminders in
  fetched = reminders
  semaphore.signal()
}
semaphore.wait()

guard let reminders = fetched else {
  fail("{\"error\":\"fetch_failed\"}")
}

let out = reminders.map { reminder in
  ReminderOut(
    id: reminder.calendarItemIdentifier,
    title: reminder.title ?? "",
    notes: cleanNotes(reminder.notes),
    list: reminder.calendar?.title ?? "",
    created: isoString(reminder.creationDate),
    lastModified: isoString(reminder.lastModifiedDate),
    due: dueString(reminder.dueDateComponents),
    recurring: reminder.hasRecurrenceRules
  )
}

let encoder = JSONEncoder()
guard let data = try? encoder.encode(BridgeOutput(reminders: out)),
      let json = String(data: data, encoding: .utf8) else {
  fail("{\"error\":\"encode_failed\"}")
}
emit(json)
