# Obsidian capture: one-tap iPhone Shortcut + Obsidian Sync

How todos are captured from the iPhone in one tap, synced across devices, and
backed up — replacing Apple Reminders as the capture surface. The vault is the
system of record that the `tasks` automation reads.

**Architecture:**

- **Live sync — Obsidian Sync.** Desktop ↔ iPhone, first-party, conflict-light.
  This is the source of truth; the automation reads the Mac's synced copy on disk.
- **Capture — iOS Shortcut via the Advanced URI plugin.** One tap appends a line
  to `Todos/todos.md`; Obsidian Sync propagates it everywhere.
- **Backup — daily `git push` via launchd.** A one-way snapshot to a private
  GitHub repo for offsite backup. *Not* the live sync path, so it never conflicts.
- **Consumption — `tasks`.** Reads `Todos/todos.md` with
  `TASK_LISTS=["Todos/todos.md"]`.

**Key facts:**

- **Capture file:** `Todos/todos.md` (in the `Todos/` folder) — every capture appends one line.
- **Line format:** `- [ ] <text> ➕ <YYYY-MM-DD>` (Obsidian Tasks syntax; the `➕`
  created-date records when it was captured).
- **Vault name differs per device.** With Obsidian Sync each device names its local
  vault independently (Mac: `obsidian-shared`, iPhone: `iphone`). An `obsidian://`
  URL resolves against the **local** name on the device that runs it — so the
  Shortcut (running on the phone) must use the *phone's* name.

---

## Part 1 — Live sync (Obsidian Sync)

Obsidian Sync handles desktop ↔ phone; there's nothing to build. Two rules:

- **Don't also run the Obsidian Git plugin as live sync** — two sync engines on one
  vault fight. Keep the Git plugin dormant (all auto-intervals `0`) or disabled;
  git is backup-only (Part 3).
- **Note your phone's vault name** for the Shortcut. Easiest way: in Obsidian
  mobile, open `Todos/todos.md` → ⋯ menu → **Copy Advanced URI**, and read the `vault=`
  value (here it's `iphone`).

---

## Part 2 — The iPhone capture Shortcut (Advanced URI)

**Prerequisite:** install **and enable** the **Advanced URI** community plugin on
the **phone** (Settings → Community plugins → Browse → "Advanced URI"; make sure
**Restricted Mode is off**). Installing it on the Mac does *not* put it on mobile
unless "Sync installed community plugins" is on in Obsidian Sync settings.

In the **Shortcuts** app, create a shortcut named **"Add ToDo"** with these actions
in order:

1. **Ask for Input** — Type: **Text**, Prompt: `New todo` → *Provided Input*
   (first action, so one tap lands straight on the keyboard)
2. **Current Date**
3. **Format Date** — Format: **Custom**, format string `yyyy-MM-dd` → *Formatted Date*
4. **Text**: `- [ ] [Provided Input] ➕ [Formatted Date]`
   - The `➕` must be the **emoji** (U+2795), not a keyboard `+` — only the emoji is
     recognized as the created-date marker. Keep a space on each side.
5. **URL Encode** — input = the **Text** from step 4 → *URL Encoded Text*
   (encodes the spaces, `[ ]`, and `➕` that would otherwise break the URL)
6. **Open URLs**:
   ```
   obsidian://adv-uri?vault=iphone&filepath=Todos/todos.md&mode=append&data=[URL Encoded Text]
   ```
   where `[URL Encoded Text]` is the variable from step 5 (a chip, not literal text).

**Put it one tap away:** Shortcut details → **Add to Home Screen**, and place the
icon where the Reminders app was. (Control Center / Lock Screen also work; the
Action Button may already be taken.)

Result: **1 tap → type → return** → the line appends to `Todos/todos.md` and syncs. Obsidian
flashes open briefly to do the write (keep it warm to minimize that).

**About the URL:**
- `vault=iphone` — the **phone's** local vault name (see Part 1). Spaces → `%20`.
- `adv-uri` — this plugin version's scheme (alias of `advanced-uri`). Match whatever
  "Copy Advanced URI" emits.
- `filepath=Todos/todos.md` — vault-relative path; the `Todos/` folder is part of it.
  The literal `/` is fine in the URL. If `filepath` points at a missing path, Advanced
  URI silently creates it — so a stale `filepath=todos.md` would write a phantom file at
  the vault root instead of erroring.
- `mode=append` — adds to the end of the file; additive, doesn't overwrite.

---

## Part 3 — Backup (daily git push via launchd)

The vault is backed up daily to a **private** GitHub repo
(`github.com/BrentonCozby/obsidian-vault`) by the `com.personal-automation.vault-backup`
launchd agent (`launchd/run-vault-backup.sh`, daily 09:00). It's a one-way
`git push` of the Mac's synced copy, so it never touches the live Obsidian Sync
path. Activation (generate the plist, bootstrap the agent, run once by hand to
confirm the push credential) is in the repo README's **Production** section.

> The repo stores your notes as plaintext (private). If any note is sensitive,
> keep it out of this vault or add `git-crypt`.

---

## Part 4 — Consumption (`tasks`)

`tasks` reads the vault on disk via `OBSIDIAN_VAULT_PATH` (the Mac's synced copy — no
git needed for reading). It parses open `- [ ]` lines: `📅` → due, `#someday`/`#active`
→ the task's state, and recurring (`🔁`) tasks sit outside the state model. Reviewing is
read-only; the `promote`, `schedule` and `abandon` commands rewrite one line each. See
the README's **tasks** section, `docs/task-state-model.md`, and
`apps/tasks/src/tasks/obsidian/`.

---

## Troubleshooting

- **Shortcut opens Obsidian but nothing appends.** Almost always (a) `vault=` doesn't
  match the phone's local vault name, or (b) the Advanced URI plugin isn't enabled on
  the phone (check Restricted Mode is off and the plugin is installed on *mobile*).
  Confirm both via "Copy Advanced URI" in the mobile file menu — it shows the correct
  `vault=` and scheme.
- **New line runs onto the previous line.** Prepend a newline to the data, or use the
  plugin's append-newline setting.
- **`+` ignored as a created date.** It must be the `➕` emoji (U+2795), not a keyboard `+`.
- **Editing / deleting todos.** Do it directly in Obsidian (mobile or desktop); Sync
  propagates. The automation re-reads the file each run.
- **Voice.** The keyboard's mic key dictates into the Ask-for-Input box — no Siri setup.
