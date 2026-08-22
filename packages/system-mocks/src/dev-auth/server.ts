// The dev auth process: a mock OAuth/OIDC identity provider plus the external
// one-click page that drives it.
//
// Started by `bun dev` (packages/system-mocks/package.json → dev), alongside the
// daemon and vite. Nothing in packages/backend or packages/frontend knows this
// exists: the four buttons walk the daemon's ORDINARY OIDC login flow, and the
// session lands in the app the same way any identity-provider login does —
// `#aw_session=…` picked up by the SPA's fragment consumer (frontend
// src/stores/auth.ts). Kill this process and the platform is exactly as before.

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { readRequestBody, writeJson, writeText } from '../core/http'
import { OidcMock } from '../oidc/server'
import { readDaemonInfo, waitForDaemon } from './daemon'
import { renderDevAuthPage, type DevAuthPageState, type DevAuthSeedState } from './page'
import { devRoleMockUsers, findDevRole } from './roles'
import { seedDevAuth, startRoleAuthorization, type CliRunner } from './seed'

export const DEV_AUTH_DEFAULT_PORT = 7460
export const DEV_AUTH_DEFAULT_APP_ORIGIN = 'http://localhost:5174'

export interface DevAuthServerOptions {
  /** Daemon home whose database gets the seeded accounts. */
  readonly home: string
  readonly runCli: CliRunner
  readonly port?: number
  readonly host?: string
  /** Where a successful login should land the browser (vite by default). */
  readonly appOrigin?: string
  readonly log?: (message: string) => void
  /** Off in tests that drive seeding themselves. */
  readonly autoSeed?: boolean
  readonly daemonWaitMs?: number
}

export interface StartedDevAuthServer {
  readonly url: string
  readonly issuerUrl: string
  state(): DevAuthPageState
  seed(): Promise<void>
  close(): Promise<void>
}

export async function startDevAuthServer(
  options: DevAuthServerOptions,
): Promise<StartedDevAuthServer> {
  const host = options.host ?? '127.0.0.1'
  const appOrigin = (options.appOrigin ?? DEV_AUTH_DEFAULT_APP_ORIGIN).replace(/\/$/, '')
  const log = options.log ?? (() => undefined)
  let baseUrl = ''
  // Per-process issuer path. The mock mints a fresh RSA key on every start but
  // always labels it `kid=system-mock-key-1`, while the daemon keeps ONE jose
  // RemoteJWKSet per jwks_uri for its whole lifetime (backend
  // auth/oidc/endpoints.ts getJwksInstance). Same URL + same kid + new key =
  // jose finds the cached key, never refetches, and every id_token fails to
  // verify until the daemon itself restarts — which is exactly what a restart
  // of THIS process used to cause. A per-process path makes the jwks_uri (and
  // the discovery cache key) new, so the daemon picks up the new key material
  // on the next login; the provider row is re-pointed at it during seeding and
  // the seeded identities, which hang off the provider ROW, are untouched.
  const routePrefix = `/oidc/${randomBytes(4).toString('hex')}`
  const issuer = (): string => `${baseUrl}${routePrefix}`
  const oidc = await OidcMock.create(issuer)
  oidc.configure({ users: devRoleMockUsers() })

  let seedState: DevAuthSeedState = { status: 'pending' }
  let seedInFlight: Promise<void> | null = null

  const daemonBaseUrl = (): string | null => readDaemonInfo(options.home)?.baseUrl ?? null

  const state = (): DevAuthPageState => ({
    home: options.home,
    appOrigin,
    daemonBaseUrl: daemonBaseUrl(),
    issuerUrl: issuer(),
    seed: seedState,
  })

  const runSeed = async (): Promise<void> => {
    try {
      const info = await waitForDaemon(options.home, {
        timeoutMs: options.daemonWaitMs ?? 120_000,
        onWait: (attempt) => {
          if (attempt === 1) log('waiting for the daemon to publish .daemon.info …')
        },
      })
      const result = await seedDevAuth({
        home: options.home,
        baseUrl: info.baseUrl,
        issuerUrl: issuer(),
        runCli: options.runCli,
        log,
      })
      seedState = { status: 'ok', result }
      log(`ready — open ${baseUrl} and pick a role`)
    } catch (error) {
      seedState = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
      log(`seeding failed: ${seedState.status === 'error' ? seedState.message : ''}`)
    }
  }

  const seed = async (): Promise<void> => {
    if (seedInFlight === null) {
      seedInFlight = runSeed().finally(() => {
        seedInFlight = null
      })
    }
    await seedInFlight
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        writeText(
          response,
          500,
          `dev-auth: ${error instanceof Error ? error.message : String(error)}`,
        )
      } else if (!response.writableEnded) {
        response.end()
      }
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', baseUrl === '' ? `http://${host}` : baseUrl)
    const body = await readRequestBody(request)
    if (url.pathname === routePrefix || url.pathname.startsWith(`${routePrefix}/`)) {
      const handled = await oidc.handle({ request, response, url, body, routePrefix })
      if (!handled) writeText(response, 404, 'not found')
      return
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      writeText(response, 200, renderDevAuthPage(state()), 'text/html; charset=utf-8')
      return
    }
    if (request.method === 'GET' && url.pathname === '/status.json') {
      writeJson(response, 200, state())
      return
    }
    if (request.method === 'POST' && url.pathname === '/reseed') {
      seedState = { status: 'pending' }
      void seed()
      response.writeHead(303, { location: '/' })
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/login/')) {
      await handleLogin(url, response)
      return
    }
    writeText(response, 404, 'not found')
  }

  async function handleLogin(url: URL, response: ServerResponse): Promise<void> {
    const role = findDevRole(decodeURIComponent(url.pathname.slice('/login/'.length)))
    if (role === undefined) {
      writeText(response, 404, 'unknown role')
      return
    }
    if (seedState.status !== 'ok') {
      writeText(
        response,
        503,
        seedState.status === 'pending'
          ? 'dev-auth: still seeding the dev accounts — reload the page in a moment'
          : `dev-auth: seeding failed, cannot log in\n\n${seedState.message}`,
      )
      return
    }
    const info = readDaemonInfo(options.home)
    if (info === null) {
      writeText(response, 503, 'dev-auth: the daemon is not running')
      return
    }
    // `origin=daemon` lands in the binary-served UI instead of vite; anything
    // else is ignored rather than followed — a dev tool is still no place to
    // build an open redirector.
    const target = url.searchParams.get('origin') === 'daemon' ? info.baseUrl : appOrigin
    const handoff = await startRoleAuthorization({
      baseUrl: info.baseUrl,
      issuerUrl: issuer(),
      role,
      postLoginRedirect: safeRedirect(url.searchParams.get('to')),
    })
    const callback = new URL(handoff.callbackUrl)
    const browserUrl = new URL(`${callback.pathname}${callback.search}`, target)
    response.writeHead(302, { location: browserUrl.toString() })
    response.end()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEV_AUTH_DEFAULT_PORT, host, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('dev-auth: unexpected server address')
  }
  baseUrl = `http://${host}:${address.port}`

  if (options.autoSeed !== false) void seed()

  return {
    url: baseUrl,
    issuerUrl: issuer(),
    state,
    seed,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Only same-origin absolute paths reach the daemon's postLoginRedirect. */
export function safeRedirect(value: string | null): string {
  if (value === null) return '/agents'
  return /^\/(?![/\\])/.test(value) ? value : '/agents'
}
