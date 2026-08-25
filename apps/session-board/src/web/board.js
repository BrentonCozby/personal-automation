const collapsed = new Set(readCollapsed())
let latest = null

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
    if (!res.ok) console.error('request failed', path, res.status, await res.text())
  } catch (error) {
    console.error('request never reached the server', path, error)
  }
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

function buildRow(row) {
  const node = el('div', `row status-${row.status}`)
  const isAlive = row.status !== 'gone'

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

  // For a session with no name of its own, the working directory is the
  // only human-readable thing the board has. A named row gets it too when
  // it has no progress file, since then nothing else says where it is.
  const cwdLabel = row.cwd ? formatCwd(row.cwd) : ''
  if (cwdLabel && (!row.name || !row.progressPath)) {
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

  // The slug repeats the name whenever a session is named after its task,
  // which is the naming the matcher rewards. Showing both wastes a line.
  if (row.progressLabel && row.progressLabel !== row.name) {
    const progress = el('div', row.isProgressFileMissing ? 'sub progress missing' : 'sub progress')
    // `≡` rather than a document character: U+2398 and the ones like it are
    // missing from most fonts and come out as an empty box.
    progress.append(el('span', 'icon', '≡'), el('span', 'label', row.progressLabel))
    progress.title = row.isProgressFileMissing
      ? `${row.progressPath} (no longer on disk)`
      : row.progressPath
    makeActivatable(progress, () => {
      void api(`/api/sessions/${encodeURIComponent(row.sessionId)}/open-progress`, {
        method: 'POST',
      })
    })
    node.append(progress)
  }

  // Naming an unclaimed session is what claims it, so this is the whole
  // claim action too.
  makeActivatable(name, () =>
    editIn({
      host: name,
      current: row.name,
      placeholder: row.isClaimed ? 'session name' : 'name it to claim it',
      onCommit: value => patchSession(row.sessionId, { name: value || null }),
    }),
  )

  const actions = el('div', 'actions')

  const openButton = el('button', null, 'resume ↗')
  const blocked = whyResumeIsBlocked(row, isAlive)
  openButton.disabled = Boolean(blocked)
  openButton.title = blocked || 'Open this session in a new Ghostty tab'
  openButton.addEventListener('click', event => {
    event.stopPropagation()
    void api(`/api/sessions/${encodeURIComponent(row.sessionId)}/open`, {
      method: 'POST',
      body: JSON.stringify({ cwd: row.cwd }),
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
  if (row.isTranscriptMissing) {
    return 'Claude Code has no transcript for this session, so it cannot be resumed'
  }
  if (!row.cwd) return 'No working directory was ever recorded, so there is nowhere to resume it'

  return undefined
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

function renameGroup(rows, value) {
  return Promise.all(rows.map(row => patchSession(row.sessionId, { group: value || null })))
}

function buildGroup({ key, label, count, rows, isRenameable = false }) {
  const wrapper = el('div', collapsed.has(key) ? 'group collapsed' : 'group')

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
        onCommit: value => renameGroup(rows, value),
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
        rows: group.rows.map(row => ({ ...row, isClaimed: true })),
        // Ungrouped is the absence of a group rather than one of them, so
        // there is no name to change.
        isRenameable: group.name !== 'Ungrouped',
      }),
    )
  }

  if (board.unclaimed.length === 0) {
    drawerEl.replaceChildren()

    return
  }

  drawerEl.replaceChildren(
    buildGroup({
      key: '__drawer__',
      label: 'Off the board',
      count: board.unclaimed.length,
      rows: board.unclaimed.map(row => ({ ...row, isClaimed: false })),
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
    // being typed. The next snapshot is moments away.
    if (isEditing()) {
      latest = board

      return
    }
    render(board)
  })

  // Repaint so the ages move between snapshots. Each row works its own age
  // out from its timestamp, so a tick that runs late or not at all costs
  // nothing but a delayed repaint.
  setInterval(() => {
    if (latest && !isEditing()) render(latest)
  }, 30_000)
}
