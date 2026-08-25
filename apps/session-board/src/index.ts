import { loadConfig } from './config.js'
import { createBoardServer } from './server.js'

const config = loadConfig()
const board = createBoardServer({ config })

board.server.listen(config.port, '127.0.0.1', () => {
  process.stdout.write(`session board on http://localhost:${config.port}\n`)
})

// launchd sends SIGTERM, Ctrl+C sends SIGINT, and without this the open event
// streams keep the port held while the process is on its way out, so the next
// start fails with EADDRINUSE against a listener serving stale code.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // `finally`, so a shutdown that throws still exits rather than leaving the
    // process holding the port with nothing left to close it.
    void board.close().finally(() => process.exit(0))
  })
}
