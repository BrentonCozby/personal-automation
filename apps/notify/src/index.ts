import path from 'node:path'
import { fatal } from '@personal-automation/common/cli'
import { todayIso } from '@personal-automation/common/date'
import { resolveWorkspaceRoot } from '@personal-automation/common/env'
import { loadConfig } from './config.js'
import { runNotify } from './notify.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const today = todayIso()
  const appsDir = path.join(resolveWorkspaceRoot(import.meta.url), 'apps')

  const result = await runNotify({ config, today, appsDir })
  if (result.kind === 'no_activity') {
    console.log(`No activity in today's audit logs; skipped send. (rows=${result.rowsRead})`)
  } else {
    console.log(`Sent digest: ${result.errorCount} errors. message_id=${result.messageId}`)
  }
}

main().catch(fatal)
