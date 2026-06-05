import path from 'node:path'
import { todayLocalIso } from '@personal-automation/common/date'
import { resolveWorkspaceRoot } from '@personal-automation/common/env'
import { formatError } from '@personal-automation/common/errors'
import { loadConfig } from './config.js'
import { runNotify } from './notify.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const today = todayLocalIso()
  const appsDir = path.join(resolveWorkspaceRoot(import.meta.url), 'apps')

  const result = await runNotify({ config, today, appsDir })
  if (result.kind === 'no_activity') {
    console.log(`No activity in today's audit logs; skipped send. (rows=${result.rowsRead})`)
  } else {
    console.log(`Sent digest: ${result.errorCount} errors. message_id=${result.messageId}`)
  }
}

main().catch(err => {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
})
