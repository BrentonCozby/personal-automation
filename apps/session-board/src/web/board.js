const collapsed = new Set(readCollapsed())
let latest = null

// The row being dragged between groups, and the group it started in. Held at
// module level because the drop lands on a different element than the drag
// started on, and because a repaint has to be held off for as long as a drag is
// in flight: rebuilding the board mid-drag destroys the element under the
// pointer and the drag dies with it.
let dragged

/** The group that means "no group", which clears the field rather than setting it. */
const UNGROUPED_LABEL = 'Ungrouped'

/** Not a group name: the drawer is drawn from `unclaimed`, not from a group. */
const DRAWER_KEY = '__drawer__'

/**
 * The nearest kebab-case name to what was typed.
 *
 * The matcher links a session to a progress file by an exact match against the
 * file's slug, and slugs are kebab-case because filenames are, so a name in any
 * other shape can never match one. Corrected here as you type rather than
 * refused afterwards; `src/session-name.ts` enforces the same rule server-side
 * and the two have to stay in step.
 */
function toKebabCase(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function readCollapsed() {
  try {
    const stored = JSON.parse(localStorage.getItem('collapsed') || '[]')

    // Anything but an array would throw inside `new Set` and take the
    // whole board down with it, leaving a blank page and no way back.
    return Array.isArray(stored) ? stored : []
  } catch {
    return []
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function saveCollapsed() {
  try {
    localStorage.setItem('collapsed', JSON.stringify([...collapsed]))
  } catch {
    // A private window refuses to store. Collapsing still works for this visit.
  }
}

// Minutes matter most: the range a session spends between "I just left it"
// and "I have forgotten it" is measured in minutes and hours, and folding
// all of that into "now" hid every age on the first run of this board.
function formatAge(seconds) {
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`

  return `${Math.floor(seconds / 86_400)}d`
}

// Two segments, because one is ambiguous across worktrees that share a
// repository name and a whole path does not fit 520px.
function formatCwd(cwd) {
  return cwd.split('/').filter(Boolean).slice(-2).join('/')
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text

  return node
}

function isEditing() {
  return document.activeElement?.classList.contains('edit')
}

/**
 * When the mouse button went down, or undefined while it is up.
 *
 * A browser sends `click` to the nearest ancestor the press and the release
 * still share. A repaint between the two throws away the element that was
 * pressed, leaving no shared ancestor in the document, and then no click is
 * sent at all: measured in Chrome, one press on a group chevron gave one
 * mousedown, one mouseup and zero clicks, and the group did not collapse.
 */
let pointerDownAt

/**
 * How long a press may hold a repaint off.
 *
 * A press that never reports its release (the button let go outside the window,
 * a pointer the browser forgets) would otherwise freeze the board for good.
 * Longer than any click, and far shorter than the gap between snapshots.
 */
const POINTER_HOLD_MS = 2000

function isPointerDown() {
  return pointerDownAt !== undefined && Date.now() - pointerDownAt < POINTER_HOLD_MS
}

/** Whether a repaint has to wait: it would destroy what the pointer is holding. */
function isBusy() {
  return isEditing() || dragged !== undefined || isPointerDown()
}

// What each dot means, so the status is not carried by hue alone. Five states
// across a 6px circle leaves no room to tell them apart by shape.
const STATUS_LABELS = {
  running: 'running',
  waiting: 'waiting for you',
  ready: 'just went idle',
  idle: 'idle',
  gone: 'not running',
}

/**
 * Make a span behave like the button it already acts as.
 *
 * A row is a div, so nothing inside it is reachable by keyboard unless it says
 * so. Naming a session, renaming a group, opening a progress file and
 * collapsing were all clicks on plain spans, which put every one of them out of
 * reach without a mouse.
 */
function makeActivatable(node, onActivate) {
  node.tabIndex = 0
  node.setAttribute('role', 'button')
  node.addEventListener('click', event => {
    event.stopPropagation()
    onActivate()
  })
  node.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return

    // Space scrolls the page and Enter would reach a form. Neither is what a
    // button press means.
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  })
}

// Never rejects. Every caller fires and forgets, and the board has nothing
// useful to do about a request that failed: the next snapshot repaints whatever
// really happened on the server.
async function api(path, options) {
  try {
    const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
    if (res.ok) return { ok: true }

    const text = await res.text()
    console.error('request failed', path, res.status, text)

    let error
    try {
      error = JSON.parse(text).error
    } catch {
      // A body that is not the server's own JSON, so there is no sentence to
      // show. The console line above still carries it.
    }

    return { ok: false, error }
  } catch (error) {
    console.error('request never reached the server', path, error)

    return { ok: false }
  }
}

/**
 * A short-lived line under a row, for something the row itself cannot show.
 *
 * Returns the line so a caller waiting on an answer can replace what it says
 * rather than stacking a second line under the first.
 */
function showMessage(node, text) {
  const line = el('div', 'edit-line')
  line.append(el('span', 'pending', text))
  node.append(line)
  setTimeout(() => line.remove(), MESSAGE_MS)

  return line
}

// Answers with the parsed body whatever the status, because the server says
// what went wrong in the body and the picker shows that sentence. Undefined
// means the request never got an answer at all.
async function apiJson(path) {
  try {
    const res = await fetch(path)
    const data = await res.json()
    if (!res.ok) console.error('request failed', path, res.status, data)

    return data
  } catch (error) {
    console.error('request never reached the server', path, error)

    return undefined
  }
}

function patchSession(id, changes) {
  return api(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  })
}

function editIn({ host, current, placeholder, onCommit }) {
  const previous = [...host.childNodes]
  // A span that says it is a button must not say so while it holds a text
  // field. It goes back to being a button when the edit ends.
  const role = host.getAttribute('role')
  host.removeAttribute('role')

  // Text inside a draggable element cannot be selected with the mouse: the
  // drag wins the gesture. The row gives dragging up for as long as one of its
  // fields is open, or you could not click into the middle of a name to fix it.
  const draggableRow = host.closest('.row')
  if (draggableRow) draggableRow.draggable = false

  const input = el('input', 'edit')
  input.value = current || ''
  input.placeholder = placeholder
  host.replaceChildren(input)
  input.focus()
  input.select()

  let settled = false
  const finish = commit => {
    if (settled) return
    settled = true
    if (role) host.setAttribute('role', role)
    if (draggableRow) draggableRow.draggable = true
    if (commit && input.value.trim() !== (current || '')) {
      onCommit(input.value.trim())

      return
    }

    host.replaceChildren(...previous)
    // A host that held nothing was made to carry this input and nothing
    // else, so leaving it behind stacks an empty line on the row for
    // every edit that gets cancelled.
    if (previous.length === 0) host.remove()
  }

  input.addEventListener('keydown', event => {
    event.stopPropagation()
    // Blur rather than commit straight from here. Blur commits too, and
    // dropping focus is what lets the next snapshot repaint the row:
    // repainting is held off while a field has focus, so committing
    // without blurring leaves the field sitting there looking unsaved.
    if (event.key === 'Enter') input.blur()
    if (event.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', event => event.stopPropagation())
}

// Long enough to read a short sentence. The toast this replaced gave 1600ms,
// which is about how long it takes to notice something has appeared.
const MESSAGE_MS = 4000

/**
 * The mark in a row's gutter saying what the row points at.
 *
 * `≡` for a linked progress file, which a click opens; `⌂` for a row that only
 * knows its directory. Both carry the detail in a popover the CSS opens on
 * hover and on focus, so the row itself stays one line.
 *
 * The gutter is the one part of a row the action bar cannot reach: the bar is
 * absolutely placed against the right edge and covers whatever sits under it
 * while the row is hovered, which is exactly when the pin has to be pointable.
 *
 * `undefined` when there is nothing to point at, so a row can carry no pin
 * rather than an empty one.
 */
function buildPin(row) {
  const isProgress = Boolean(row.progressLabel)
  if (!isProgress && !row.cwd) return undefined

  const pin = el('span', row.isProgressFileMissing ? 'pin missing' : 'pin')
  // `≡` rather than a document character: U+2398 and the ones like it are
  // missing from most fonts and come out as an empty box.
  pin.append(el('span', 'icon', isProgress ? '≡' : '⌂'))

  // The project the session is working in, which the row no longer says
  // anywhere. The slug is not repeated here: it is the name on the row for most
  // sessions, and the full path below spells it out for the rest.
  const popover = el('div', 'popover')
  if (row.cwd) popover.append(el('div', 'popover-title', formatCwd(row.cwd)))

  const detail = isProgress ? row.progressPath : row.cwd
  popover.append(
    el('div', 'popover-path', row.isProgressFileMissing ? `${detail} (no longer on disk)` : detail),
  )
  pin.append(popover)

  if (!isProgress) {
    // Nothing to activate, so it takes no tab stop: 16 drawer rows of a focus
    // ring that opens a directory nobody can open is worse than the tooltip.
    pin.title = row.cwd

    return pin
  }

  pin.title = row.isProgressFileMissing
    ? `${row.progressPath} (no longer on disk)`
    : row.progressPath
  makeActivatable(pin, () => {
    void api(`/api/sessions/${encodeURIComponent(row.sessionId)}/open-progress`, {
      method: 'POST',
    })
  })

  return pin
}

function buildRow(row) {
  const node = el('div', `row status-${row.status}`)
  const isAlive = row.status !== 'gone'

  node.draggable = true
  node.addEventListener('dragstart', event => {
    dragged = { sessionId: row.sessionId, fromGroup: row.groupName }
    node.classList.add('dragging')
    event.dataTransfer.effectAllowed = 'move'
    // Firefox will not start a drag whose transfer carries nothing.
    event.dataTransfer.setData('text/plain', row.sessionId)
  })
  node.addEventListener('dragend', () => {
    dragged = undefined
    node.classList.remove('dragging')
    for (const group of document.querySelectorAll('.group.drop-target')) {
      group.classList.remove('drop-target')
    }
    // Snapshots that arrived during the drag were set aside rather than drawn.
    render(latest)
  })

  const top = el('div', 'row-top')

  const statusLabel = STATUS_LABELS[row.status] ?? row.status
  const dot = el('span', 'dot')
  dot.setAttribute('role', 'img')
  dot.setAttribute('aria-label', statusLabel)
  dot.title = statusLabel
  top.append(dot)

  const label = row.name || 'unnamed'
  // Struck through for the same reason a progress file that has gone missing
  // is: what the row points at is no longer there. The row itself stays, since
  // what you wrote about the work still reads.
  const nameClasses = ['name']
  if (!row.name) nameClasses.push('unnamed')
  if (row.isTranscriptMissing) nameClasses.push('missing')
  const name = el('span', nameClasses.join(' '), label)
  name.title = nameTitle(row, label)
  top.append(name)

  // Worked out from the timestamp on every repaint rather than counted up
  // by the ticker. A ticker is throttled in a background tab and stops
  // dead while the machine sleeps, so a counted age silently falls behind
  // real time and only a fresh snapshot puts it right.
  const ageSeconds = Math.max(0, nowSeconds() - row.lastActive)
  const isStale = ageSeconds > (latest?.staleSeconds ?? Number.POSITIVE_INFINITY)
  top.append(el('span', isStale ? 'age stale' : 'age', formatAge(ageSeconds)))
  node.append(top)

  // A named row says what it points at with a pin in the gutter rather than a
  // line of its own: 8 of 15 second lines repeated the name directly above
  // them, and the slug is worth a hover rather than a line each. The pin keeps
  // both jobs that line was doing, since it says a file is linked and opening
  // one is still a click.
  //
  // An unnamed row keeps the directory as text. It is the only thing telling
  // one from another there: the drawer is 16 rows all called "unnamed".
  const pin = row.name ? buildPin(row) : undefined
  if (pin) node.append(pin)

  const cwdLabel = row.cwd ? formatCwd(row.cwd) : ''
  if (cwdLabel && !row.name) {
    const cwd = el('div', 'sub cwd')
    cwd.append(el('span', 'icon', '⌂'), el('span', 'label', cwdLabel))
    cwd.title = row.cwd
    node.append(cwd)
  }

  if (row.parkedReason) {
    const parked = el('div', 'sub parked')
    parked.append(el('span', 'icon', '◷'), el('span', 'label', row.parkedReason))
    makeActivatable(parked, () =>
      editIn({
        host: parked,
        current: row.parkedReason,
        placeholder: 'waiting on what?',
        onCommit: value => patchSession(row.sessionId, { parkedReason: value || null }),
      }),
    )
    node.append(parked)
  }

  // Naming an unclaimed session is what claims it, so this is the whole
  // claim action too.
  makeActivatable(name, () =>
    editIn({
      host: name,
      current: row.name,
      placeholder: row.isClaimed ? 'session name' : 'name it to claim it',
      onCommit: value => {
        // Corrected rather than refused: `Review Perf` becomes `review-perf`,
        // and the repainted row is the confirmation. The server enforces the
        // same rule, so this only ever reports a rule the two disagree on.
        const kebab = toKebabCase(value)
        void patchSession(row.sessionId, { name: kebab || null }).then(result => {
          if (!result.ok) showMessage(node, result.error ?? 'could not save that name')
        })
      },
    }),
  )

  const actions = el('div', 'actions')

  const openButton = el('button', null, 'resume ↗')
  const blocked = whyResumeIsBlocked(row, isAlive)
  openButton.disabled = Boolean(blocked)
  openButton.title = blocked || resumeTitle(row)
  openButton.addEventListener('click', event => {
    event.stopPropagation()

    // Opening a tab takes about a second, during which the row looks exactly as
    // it did before the press. A second press in that time starts a second
    // session on the same work, in its own tab. The next repaint builds a fresh
    // button, and one arrives within 30 seconds even if nothing else happens.
    openButton.disabled = true
    const message = showMessage(node, 'opening a tab…')

    void api(`/api/sessions/${encodeURIComponent(row.sessionId)}/open`, {
      method: 'POST',
      body: JSON.stringify({ cwd: row.cwd }),
    }).then(result => {
      if (result.ok) return

      message.replaceChildren(el('span', 'pending', result.error ?? 'could not open a tab'))
    })
  })
  actions.append(openButton)

  if (row.isClaimed) {
    const parkButton = el('button', null, row.parkedReason ? 'unpark' : 'park')
    parkButton.addEventListener('click', event => {
      event.stopPropagation()
      if (row.parkedReason) {
        void patchSession(row.sessionId, { parkedReason: null })

        return
      }
      const line = el('div', 'edit-line')
      node.append(line)
      editIn({
        host: line,
        current: '',
        placeholder: 'waiting on what?',
        onCommit: value => value && patchSession(row.sessionId, { parkedReason: value }),
      })
    })

    // A row named after its progress file hides the progress line, since the
    // two would read the same. The label is then the only thing that says
    // whether a file is linked at all.
    const linkButton = el('button', null, row.progressPath ? 'relink' : 'link')
    linkButton.title = row.progressPath
      ? 'Point this session at a different progress file'
      : 'Link a progress file to this session'
    linkButton.addEventListener('click', event => {
      event.stopPropagation()
      void openProgressPicker(node, row)
    })

    const deleteButton = el('button', 'remove', '×')
    deleteButton.title = 'Take off the board. History is kept; it reappears under Off the board.'
    deleteButton.addEventListener('click', event => {
      event.stopPropagation()
      void api(`/api/sessions/${encodeURIComponent(row.sessionId)}`, { method: 'DELETE' })
    })

    actions.append(linkButton, parkButton, deleteButton)
  }

  node.append(actions)

  return node
}

/**
 * Whether resuming starts a clean session on the progress file rather than
 * reopening the old conversation.
 *
 * The progress file is the durable state, so a fresh session that reads it
 * picks the work up without dragging a long stale context along. A file that
 * has gone missing is no use to a new session, so those fall back.
 */
function startsFromProgress(row) {
  return Boolean(row.progressPath) && Boolean(row.name) && !row.isProgressFileMissing
}

/**
 * Why this session cannot be resumed, or undefined when it can.
 *
 * The button carries the answer as its disabled state and its tooltip, rather
 * than looking the same either way and answering a click with a complaint.
 */
function whyResumeIsBlocked(row, isAlive) {
  // Two Claude Code processes on one session is the mess this avoids. The board
  // cannot focus the tab that already holds it, so it cannot offer to do that
  // instead.
  if (isAlive) return 'Still running in a terminal tab, so there is nothing to resume'
  if (!row.cwd) return 'No working directory was ever recorded, so there is nowhere to resume it'

  // A missing transcript only blocks the path that needs one. A row with a
  // progress file starts a new session, which never reads the old transcript.
  if (row.isTranscriptMissing && !startsFromProgress(row)) {
    return 'No progress file and no transcript on disk, so there is nothing to pick up'
  }

  return undefined
}

/** What the resume button promises, which is two different things. */
function resumeTitle(row) {
  return startsFromProgress(row)
    ? `Start a new session named ${row.name} and point it at ${row.progressLabel}`
    : 'Reopen this session in a new Ghostty tab'
}

/**
 * What the name's tooltip says, which depends on what the row is missing.
 *
 * `label` rather than `row.name`, since a session can be both unnamed and gone
 * from disk and the tooltip still has to call it something.
 */
function nameTitle(row, label) {
  if (row.isTranscriptMissing) {
    return `${label} · ${row.sessionId} · no transcript on disk, so this session cannot be resumed`
  }
  if (row.name) return `${label} · ${row.sessionId}`

  return 'Name this session'
}

/**
 * Choose the progress file for a session, for when automatic matching gave up.
 *
 * Matching is exact-name-only on purpose, so most rows never get a file without
 * this. It is a `select` rather than a list of divs so it carries the `edit`
 * class every other field uses: repainting is held off while an `edit` has
 * focus, which is what stops an unrelated session's event wiping the picker out
 * from under the pointer.
 */
async function openProgressPicker(node, row) {
  // The answer needs a `git` call to find the repository root, so say something
  // straight away rather than leaving the button looking dead.
  const line = el('div', 'edit-line')
  line.append(el('span', 'pending', 'looking for progress files…'))
  node.append(line)

  const answer = await apiJson(
    `/api/sessions/${encodeURIComponent(row.sessionId)}/progress-candidates`,
  )

  // A snapshot can land while the answer is in flight and rebuild the board,
  // which leaves this row detached with nothing to attach the picker to.
  if (!line.isConnected) return

  // Answers land where the picker would have opened, which is where you are
  // already looking after pressing the button. The corner of the row was the
  // one place on it nobody was watching.
  const answerWith = message => {
    line.replaceChildren(el('span', 'pending', message))
    setTimeout(() => line.remove(), MESSAGE_MS)
  }

  if (!answer) {
    answerWith('could not reach the server')

    return
  }
  if (answer.error) {
    answerWith(answer.error)

    return
  }

  const files = answer.files ?? []
  if (files.length === 0) {
    answerWith('no progress files in this repo')

    return
  }

  const select = el('select', 'edit')
  const current = row.progressPath || ''

  if (!current) {
    const placeholder = el('option', null, 'link a progress file…')
    placeholder.value = ''
    select.append(placeholder)
  }

  // A file that has been renamed or deleted is still what the row points at.
  // Without an option of its own the select would open showing some other
  // file, which reads as though the row had already been changed.
  if (current && !files.some(file => file.path === current)) {
    const missing = el('option', null, `${row.progressLabel} (no longer on disk)`)
    missing.value = current
    select.append(missing)
  }

  for (const file of files) {
    const label = file.linkedTo ? `${file.slug} (used by ${file.linkedTo})` : file.slug
    const option = el('option', null, label)
    option.value = file.path
    option.title = file.path
    select.append(option)
  }

  select.value = current
  select.setAttribute('aria-label', 'Progress file for this session')
  line.replaceChildren(select)
  node.append(line)
  select.focus()

  let settled = false
  const finish = value => {
    if (settled) return
    settled = true
    line.remove()

    if (value !== undefined && value !== current) {
      void patchSession(row.sessionId, { progressPath: value || null })

      return
    }

    // Snapshots that arrived while the select held focus were set aside rather
    // than drawn. Repaint now so the board is not left showing an older one.
    render(latest)
  }

  select.addEventListener('change', () => finish(select.value))
  select.addEventListener('blur', () => finish(undefined))
  select.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Escape') finish(undefined)
  })
  select.addEventListener('click', event => event.stopPropagation())
}

/**
 * A group is only the name written on its rows, so renaming one is renaming
 * every row in it. There is no group to carry anything else across.
 *
 * Which is why the collapsed mark has to be moved by hand: it is filed under
 * the name, so a rename would otherwise leave it behind on a name nothing has
 * any more, and the group would spring open. Clearing the name drops the mark
 * rather than moving it to Ungrouped, which is a group that already exists and
 * has a state of its own.
 */
function renameGroup({ rows, from, to }) {
  if (collapsed.delete(from)) {
    if (to) collapsed.add(to)
    saveCollapsed()
  }

  return Promise.all(rows.map(row => patchSession(row.sessionId, { group: to || null })))
}

/**
 * Forget the groups that are gone.
 *
 * The mark is filed under a name, so without this a new group that happens to
 * reuse an old name opens collapsed, hiding rows nobody hid. Skipped while the
 * board has no groups at all, so a frame that arrives empty cannot wipe the
 * lot. The drawer keeps its mark either way: it is drawn only when it has
 * something in it, and emptying it is not a reason to forget.
 */
function pruneCollapsed(board) {
  if (board.groups.length === 0) return

  const live = new Set(board.groups.map(group => group.name))
  let didDrop = false
  for (const key of collapsed) {
    if (live.has(key) || key === DRAWER_KEY) continue
    collapsed.delete(key)
    didDrop = true
  }

  if (didDrop) saveCollapsed()
}

function buildGroup({ key, label, count, rows, isRenameable = false, isDropTarget = false }) {
  const wrapper = el('div', collapsed.has(key) ? 'group collapsed' : 'group')

  if (isDropTarget) {
    wrapper.addEventListener('dragover', event => {
      // Without preventDefault the browser refuses the drop, and the pointer
      // shows the "no" cursor the whole way.
      if (!dragged || dragged.fromGroup === label) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      wrapper.classList.add('drop-target')
    })
    wrapper.addEventListener('dragleave', event => {
      // `dragleave` also fires crossing between children, so the highlight only
      // clears once the pointer has really left the group.
      if (!wrapper.contains(event.relatedTarget)) wrapper.classList.remove('drop-target')
    })
    wrapper.addEventListener('drop', event => {
      event.preventDefault()
      wrapper.classList.remove('drop-target')
      if (!dragged || dragged.fromGroup === label) return

      // Ungrouped is the absence of a group rather than one of them, so landing
      // there clears the field instead of writing that word into it.
      void patchSession(dragged.sessionId, {
        group: label === UNGROUPED_LABEL ? null : label,
      })
      dragged = undefined
    })
  }

  const header = el('div', 'group-header')
  const title = el('span', isRenameable ? 'group-label group-name' : 'group-label', label)

  // The triangle is a few pixels across, so the thing you click is a padded box
  // around it rather than the triangle itself.
  const toggle = el('span', 'chevron-hit')
  toggle.append(el('span', 'chevron'))
  toggle.title = collapsed.has(key) ? 'Expand' : 'Collapse'
  toggle.setAttribute('aria-expanded', String(!collapsed.has(key)))
  makeActivatable(toggle, () => {
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    saveCollapsed()
    render(latest)
  })

  header.append(toggle, title, el('span', 'count', `(${count})`))

  if (isRenameable) {
    title.title = 'Rename this group. Clearing the name moves its sessions to Ungrouped.'
    makeActivatable(title, () =>
      editIn({
        host: title,
        current: label,
        placeholder: 'group name',
        onCommit: value => renameGroup({ rows, from: label, to: value }),
      }),
    )
  }

  wrapper.append(header)

  if (!collapsed.has(key)) for (const row of rows) wrapper.append(buildRow(row))

  return wrapper
}

// Looked up on each repaint rather than held in module state, so the module
// can be imported and driven against a document a test builds.
export function render(board) {
  if (!board) return
  latest = board
  pruneCollapsed(board)

  const boardEl = document.getElementById('board')
  const drawerEl = document.getElementById('drawer')
  document.getElementById('count').textContent = `${board.claimedCount} claimed`
  boardEl.replaceChildren()

  if (board.claimedCount === 0) {
    const empty = el('div')
    empty.id = 'empty'
    empty.append(
      'Nothing claimed yet. Start a session with ',
      el('code', null, 'claude -n <name>'),
      // Only points at the drawer when there is one. With nothing in it the
      // section is not drawn at all, so the sentence sent you looking for
      // something that was not on the page.
      board.unclaimed.length > 0
        ? ' and it lands here on its own, or claim one from Off the board.'
        : ' and it lands here on its own.',
    )
    boardEl.append(empty)
  }

  for (const group of board.groups) {
    boardEl.append(
      buildGroup({
        key: group.name,
        label: group.name,
        count: group.rows.length,
        // `groupName` is what a drag reads to know it has landed somewhere new.
        rows: group.rows.map(row => ({ ...row, isClaimed: true, groupName: group.name })),
        // Ungrouped is the absence of a group rather than one of them, so
        // there is no name to change.
        isRenameable: group.name !== UNGROUPED_LABEL,
        isDropTarget: true,
      }),
    )
  }

  if (board.unclaimed.length === 0) {
    drawerEl.replaceChildren()

    return
  }

  drawerEl.replaceChildren(
    buildGroup({
      key: DRAWER_KEY,
      label: 'Off the board',
      count: board.unclaimed.length,
      // Dragging one of these onto a group claims it into that group. The
      // drawer itself takes no drops: taking a row off the board is what `×`
      // is for, and a drop target that removes things is too easy to hit by
      // accident on the way past.
      rows: board.unclaimed.map(row => ({ ...row, isClaimed: false, groupName: DRAWER_KEY })),
    }),
  )
}

// The page calls this; importing the module does nothing on its own, which is
// what lets a test load it without an event stream or a running server.
export function start() {
  const stream = new EventSource('/stream')
  stream.addEventListener('message', event => {
    const board = JSON.parse(event.data)
    // Another session's event must not yank the field out from under a name
    // being typed, or the row out from under a drag. The next snapshot is
    // moments away.
    if (isBusy()) {
      latest = board

      return
    }
    render(board)
  })

  // A press holds the repaint off until the button comes back up, then the
  // board catches up with whatever arrived in between. On `document`, because
  // the release often lands somewhere other than the element that was pressed.
  document.addEventListener('pointerdown', () => {
    pointerDownAt = Date.now()
  })

  const releasePointer = () => {
    if (pointerDownAt === undefined) return
    pointerDownAt = undefined
    if (latest && !isBusy()) render(latest)
  }
  document.addEventListener('pointerup', releasePointer)
  document.addEventListener('pointercancel', releasePointer)

  // Repaint so the ages move between snapshots. Each row works its own age
  // out from its timestamp, so a tick that runs late or not at all costs
  // nothing but a delayed repaint.
  setInterval(() => {
    if (latest && !isBusy()) render(latest)
  }, 30_000)
}
