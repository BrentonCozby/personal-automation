# Obsidian capture: vault-in-git + one-tap iPhone Shortcut

How the Obsidian vault is version-controlled and how new todos are captured from
the iPhone home screen in one tap. This replaces Apple Reminders as the capture
surface; the vault (plain Markdown in git) becomes the system of record that the
`stalled-tasks` automation will eventually read.

- **Vault repo:** `github.com/brentoncozby/obsidian-vault` (private)
- **Capture file:** `todos.md` at the vault root — every capture appends one line
- **Line format:** `- [ ] <text> ➕ <YYYY-MM-DD>` (Obsidian Tasks syntax; the `➕`
  created-date is what lets staleness work later)

---

## Part 1 — Put the vault in a private GitHub repo

### 1a. Create the empty repo (manual — the automation can't create repos)
On GitHub:
1. Go to <https://github.com/new>
2. **Repository name:** `obsidian-vault`
3. Visibility: **Private**
4. **Do not** add a README, `.gitignore`, or license — leave it empty (so the
   first push from your Mac is a clean fast-forward).
5. **Create repository**.

### 1b. Push the vault from your Mac
In a terminal, from your vault folder (the one containing your notes):

```bash
cd "/path/to/your/vault"

# Recommended .gitignore for an Obsidian vault: keep plugin settings, drop noise.
cat > .gitignore <<'EOF'
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
EOF

# Make sure the capture file exists (the Shortcut appends to it; it must be present).
[ -f todos.md ] || printf '# Todos\n' > todos.md

git init
git add .
git commit -m "Initial vault import"
git branch -M main
git remote add origin https://github.com/brentoncozby/obsidian-vault.git
git push -u origin main
```

> Heads-up: your notes will sit as **plaintext in a private GitHub repo**. That's
> fine for todos; if any notes are sensitive, either keep them out of this repo or
> add `git-crypt` before the first push.

### 1c. Keep it synced automatically
Install the **Obsidian Git** community plugin (Settings → Community plugins →
Browse → "Obsidian Git"), then in its settings:
- **Vault backup interval (minutes):** e.g. `10`
- **Auto pull on startup / interval:** on
- It uses your system git credentials (cache the HTTPS token on first push above,
  or use SSH).

Now desktop edits commit/push on their own. (Obsidian mobile + Obsidian Git works
too but is finicky — not required for capture, since the Shortcut writes straight
to GitHub.)

---

## Part 2 — Create a GitHub token for the Shortcut

A **fine-grained** token limited to just this repo (minimal blast radius):

1. <https://github.com/settings/personal-access-tokens/new>
2. **Token name:** `obsidian-capture-shortcut`
3. **Expiration:** long (e.g. 1 year or custom) — when it expires, capture stops
   until you regenerate it.
4. **Repository access:** *Only select repositories* → `obsidian-vault`
5. **Permissions → Repository permissions → Contents:** **Read and write**
   (Metadata: Read is added automatically — leave it.)
6. **Generate token** and copy it. You'll paste it into the Shortcut once.

---

## Part 3 — The iPhone Shortcut (one tap → type → filed)

Open the **Shortcuts** app → **+** to create a new shortcut, name it e.g.
**"Add Todo"**, and add these actions in order. Placeholders:
`OWNER/REPO = brentoncozby/obsidian-vault`, `FILE = todos.md`,
`TOKEN = <your fine-grained token>`.

1. **Ask for Input**
   - Input Type: **Text**
   - Prompt: `New todo`
   - (This is the first action, so one tap launches straight into the keyboard.)
     → produces **Provided Input**

2. **Format Date** (add a **Current Date** action first if needed)
   - Format: **Custom**, format string: `yyyy-MM-dd`
     → produces the date text

3. **Get Contents of URL** — read the current file
   - URL: `https://api.github.com/repos/OWNER/REPO/contents/FILE`
   - Method: **GET**
   - Headers:
     - `Authorization` = `Bearer TOKEN`
     - `Accept` = `application/vnd.github+json`

4. **Get Dictionary Value**
   - Get **Value** for key `sha` in **Contents of URL**
   - Tap the result variable and rename it **sha** (Set Variable, optional but
     clearer)

5. **Get Dictionary Value**
   - Get **Value** for key `content` in **Contents of URL**
     → this is base64 with embedded line breaks

6. **Replace Text** — strip the line breaks so base64 decodes cleanly
   - Find (turn **Regular Expression** ON): `\s`
   - Replace with: *(empty)*
   - Input: the `content` from step 5

7. **Base64 Encode** action, switched to **Decode**
   - Input: the cleaned text from step 6
     → produces the **existing file text**

8. **Text** — build the new file body
   ```
   [Decoded file text from step 7]
   - [ ] [Provided Input] ➕ [Formatted Date]
   ```
   (Insert the step-7 variable, press return, type `- [ ] `, insert **Provided
   Input**, type ` ➕ `, insert the **Formatted Date**.)

9. **Base64 Encode** (Encode mode)
   - Input: the **Text** from step 8
     → produces **new content (base64)**

10. **Get Contents of URL** — write the file back
    - URL: `https://api.github.com/repos/OWNER/REPO/contents/FILE`
    - Method: **PUT**
    - Headers:
      - `Authorization` = `Bearer TOKEN`
      - `Accept` = `application/vnd.github+json`
    - Request Body: **JSON**, with three fields:
      - `message` (Text): `capture: ` + **Provided Input**
      - `content` (Text): **new content (base64)** from step 9
      - `sha` (Text): **sha** from step 4

11. *(optional)* **Show Notification**: `Saved ✓` — so you get a confirmation.

---

## Part 4 — Put it one tap away
In the Shortcut's details (ⓘ / share icon):
- **Add to Home Screen** — gives you the Reminders-style icon. One tap → keyboard.
- Also available, even faster:
  - **Add to Control Center** (a custom control, iOS 18+)
  - **Add to Lock Screen** as a button
  - Assign to the **Action Button** (iPhone 15 Pro and later)

Result: **1 tap → type → return → filed** — one fewer tap than Reminders (no
"+"), and no separate "save" step.

---

## Notes & troubleshooting
- **`todos.md` must exist** in the repo or the GET in step 3 returns 404. Part 1b
  creates it; don't delete it.
- **Conflict (HTTP 409 / "does not match")** can happen only if two captures land
  in the same instant or while Obsidian Git is mid-push — rare for one person. If
  it ever bites, re-run the Shortcut, or switch to a one-file-per-capture variant
  (a single PUT to `inbox/<timestamp>.md`, no GET/sha) and let a Tasks query unify
  them.
- **Token expired** → capture silently fails; regenerate in Part 2 and update the
  Shortcut's `Authorization` header.
- **Viewing todos on the phone:** open `todos.md` on github.com, or set up Obsidian
  mobile on the vault. Capture itself doesn't need the vault on the phone.
- **Voice, if you ever want it:** the keyboard's mic key dictates into the same
  Ask-for-Input box — no Siri or extra setup.

---

## Next step (not done yet)
Add `createObsidianTaskSource` under `apps/stalled-tasks/src/tasks/` that reads
this vault on disk and parses `- [ ]` lines (mapping `➕` → created, `📅` → due,
and dropping `🔁` recurring lines so the app keeps ignoring them), wired into the
existing `TaskSource` seam. That replaces the Apple Reminders source with zero
OAuth. See `docs/handoff-obsidian-migration.md` §5 for the parsing edge cases.
