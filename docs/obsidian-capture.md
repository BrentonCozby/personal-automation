# Obsidian capture: one-tap iPhone Shortcut + Obsidian Sync

How todos are captured from the iPhone in one tap, synced across devices, and
backed up, replacing Apple Reminders as the capture surface. The vault is the
system of record that the `tasks` automation reads.

**The one thing that catches people out:** with Obsidian Sync each device names its
local vault independently (Mac: `obsidian-shared`, iPhone: `iphone`), and an
`obsidian://` URL resolves against the **local** name on the device that runs it. The
Shortcut runs on the phone, so it must use the *phone's* name.

---

## Part 1: Live sync (Obsidian Sync)

Obsidian Sync handles desktop ↔ phone; there's nothing to build. Two rules:

- **Don't also run the Obsidian Git plugin as live sync**: two sync engines writing
  the same vault overwrite each other and leave conflict copies. Keep the Git plugin
  dormant (all auto-intervals `0`) or disabled; git is backup-only (Part 3).
- **Note your phone's vault name** for the Shortcut. Easiest way: in Obsidian
  mobile, open `Todos/todos.md` → ⋯ menu → **Copy Advanced URI**, and read the `vault=`
  value (here it's `iphone`).

---

## Part 2: The iPhone capture Shortcut (Advanced URI)

**Prerequisite:** install **and enable** the **Advanced URI** community plugin on
the **phone** (Settings → Community plugins → Browse → "Advanced URI"; make sure
**Restricted Mode is off**). Installing it on the Mac does *not* put it on mobile
unless "Sync installed community plugins" is on in Obsidian Sync settings.

In the **Shortcuts** app, create a shortcut named **"Add ToDo"** with these actions
in order:

1. **Ask for Input**: Type: **Text**, Prompt: `New todo` → *Provided Input*
   (first action, so one tap lands straight on the keyboard)
2. **Current Date**
3. **Format Date**: Format: **Custom**, format string `yyyy-MM-dd` → *Formatted Date*
4. **Text**: `- [ ] [Provided Input] ➕ [Formatted Date]`
   - The `➕` must be the **emoji** (U+2795), not a keyboard `+`, since only the emoji is
     recognized as the created-date marker. Keep a space on each side.
5. **URL Encode**: input = the **Text** from step 4 → *URL Encoded Text*
   (encodes the spaces, `[ ]`, and `➕` that would otherwise break the URL)
6. **Open URLs**:
   ```
   obsidian://adv-uri?vault=iphone&filepath=Todos/todos.md&mode=append&data=[URL Encoded Text]
   ```
   where `[URL Encoded Text]` is the variable from step 5 (a chip, not literal text).

**Put it one tap away:** Shortcut details → **Add to Home Screen**, and place the
icon where the Reminders app was.

Result: **1 tap → type → return**, and the line appends to `Todos/todos.md`. Obsidian
flashes open briefly to do the write; keeping it warm shortens that.

**About the URL:**
- `vault=iphone`: the **phone's** local vault name (see Part 1). Spaces → `%20`.
- `adv-uri`: this plugin version's scheme (alias of `advanced-uri`). Match whatever
  "Copy Advanced URI" emits.
- `filepath=Todos/todos.md`: vault-relative path; the `Todos/` folder is part of it.
  The literal `/` is fine in the URL. If `filepath` points at a missing path, Advanced
  URI silently creates it, so a stale `filepath=todos.md` would write a phantom file at
  the vault root instead of erroring.
- `mode=append`: adds to the end of the file rather than overwriting it.

---

## Part 3: Backup (daily git push via launchd)

The vault is backed up daily to a **private** GitHub repo
(`github.com/BrentonCozby/obsidian-vault`) by the `com.personal-automation.vault-backup`
launchd agent (`launchd/run-vault-backup.sh`, daily 09:00). It's a one-way
`git push` of the Mac's synced copy, so it never touches the live Obsidian Sync
path. The repo README's **Production** section covers activating it.

> The repo stores your notes as plaintext (private). If any note is sensitive,
> keep it out of this vault or add `git-crypt`.

---

## Part 4: Consumption (`tasks`)

`tasks` reads the Mac's synced copy on disk, via `OBSIDIAN_VAULT_PATH` and
`TASK_LISTS=["Todos/todos.md"]`, with no git needed for reading. Reviewing is read-only;
`promote`, `schedule` and `abandon` rewrite one line each. What it makes of those lines is
in `docs/task-state-model.md`, and the reader and writer are in
`apps/tasks/src/tasks/obsidian/`.

---

## Troubleshooting

- **Shortcut opens Obsidian but nothing appends.** Almost always (a) `vault=` doesn't
  match the phone's local vault name, or (b) the Advanced URI plugin isn't enabled on
  the phone (check Restricted Mode is off and the plugin is installed on *mobile*).
- **New line runs onto the previous line.** Prepend a newline to the data, or use the
  plugin's append-newline setting.
- **`+` ignored as a created date.** It must be the `➕` emoji (U+2795), not a keyboard `+`.
- **Editing / deleting todos.** Do it directly in Obsidian (mobile or desktop); Sync
  propagates. The automation re-reads the file each run.
- **Voice.** The keyboard's mic key dictates into the Ask-for-Input box, with no Siri setup.
