import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadRootEnv } from '@personal-automation/common/env'
import { formatError } from '@personal-automation/common/errors'
import {
  GMAIL_SCOPE_READONLY,
  GMAIL_SCOPE_SEND,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_TOKEN_URL,
} from './constants.js'
import { tokenResponseSchema } from './schemas.js'

// Loopback port for the OAuth callback. Google's Desktop OAuth treats any
// localhost port as valid as long as `http://localhost` is registered as a
// redirect URI in the GCP console.
const REDIRECT_PORT = 53_682
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

async function main(): Promise<void> {
  loadRootEnv(import.meta.url)

  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const clientId = process.env['GMAIL_OAUTH_CLIENT_ID']
  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const clientSecret = process.env['GMAIL_OAUTH_CLIENT_SECRET']
  if (!clientId || !clientSecret) {
    throw new Error(
      'GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set in .env before running bootstrap.',
    )
  }

  const state = randomBytes(16).toString('hex')
  const authUrl = buildAuthUrl({ clientId, state })

  console.log('\nStarting one-time Gmail OAuth bootstrap.')
  console.log(`Listening on ${REDIRECT_URI}`)
  console.log('Opening your browser for Google consent...')
  console.log('If the browser does not open, paste this URL manually:\n')
  console.log(`  ${authUrl}\n`)

  const code = await captureCodeFromBrowser({ expectedState: state, authUrl })
  const refreshToken = await exchangeCodeForRefreshToken({
    clientId,
    clientSecret,
    code,
  })

  console.log('\n=== SUCCESS ===\n')
  console.log('Paste this into your .env file as GMAIL_OAUTH_REFRESH_TOKEN:\n')
  console.log(refreshToken)
  console.log('\nKeep it secret — it is the only one of the three Gmail env vars that')
  console.log('is truly sensitive.\n')
}

function buildAuthUrl({ clientId, state }: { clientId: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: [GMAIL_SCOPE_SEND, GMAIL_SCOPE_READONLY].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`
}

function captureCodeFromBrowser({
  expectedState,
  authUrl,
}: {
  expectedState: string
  authUrl: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        respondHtml({
          res,
          status: 400,
          message: `Google returned an error: ${error}. Check the console.`,
        })
        server.close()
        reject(new Error(`Google OAuth error: ${error}`))

        return
      }
      if (state !== expectedState) {
        respondHtml({
          res,
          status: 400,
          message: 'State mismatch (CSRF guard). Check the console.',
        })
        server.close()
        reject(new Error('OAuth state mismatch — possible CSRF; aborting.'))

        return
      }
      if (!code) {
        respondHtml({ res, status: 400, message: 'No code in callback. Check the console.' })
        server.close()
        reject(new Error('No authorization code in Google callback.'))

        return
      }

      respondHtml({
        res,
        status: 200,
        message:
          'Gmail OAuth bootstrap complete. You can close this tab and return to your terminal.',
      })
      server.close()
      resolve(code)
    })

    server.on('error', reject)
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      openBrowser(authUrl)
    })
  })
}

function respondHtml({
  res,
  status,
  message,
}: {
  res: ServerResponse
  status: number
  message: string
}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>${message}</h2></body></html>`,
  )
}

function openBrowser(url: string): void {
  // macOS `open` is the primary target. Fall back to `xdg-open` for Linux so this is
  // portable enough for any dev environment, even though the daily host is macOS.
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
}

async function exchangeCodeForRefreshToken({
  clientId,
  clientSecret,
  code,
}: {
  clientId: string
  clientSecret: string
  code: string
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  })
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token exchange → ${res.status}: ${text}`)
  }
  const parsed = tokenResponseSchema.parse(await res.json())
  if (!parsed.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. This usually means you have already consented this app — revoke access at https://myaccount.google.com/permissions and try again, or check that `prompt=consent` is being sent.',
    )
  }

  return parsed.refresh_token
}

main().catch(err => {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
})
