// Locks the dev one-click role login (packages/system-mocks/src/dev-auth).
//
// Why these particular assertions exist:
//   * the per-process issuer path is a REGRESSION LOCK — a fixed `/oidc` path
//     made every login fail after this process restarted, because the mock mints
//     a new RSA key per start while keeping `kid=system-mock-key-1`, and the
//     daemon caches one jose RemoteJWKSet per jwks_uri for its whole lifetime
//     (backend auth/oidc/endpoints.ts). Same URL + same kid + new key = "id_token
//     signature could not be verified" until the daemon itself was restarted.
//   * the production-isolation test asserts the user's hard constraint for this
//     feature: it exists entirely in dev tooling, and no product source knows it
//     is there.

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MOCK_OIDC_CLIENT_ID, MOCK_OIDC_CLIENT_SECRET } from '../src/oidc/server'
import { renderDevAuthPage, escapeHtml, type DevAuthPageState } from '../src/dev-auth/page'
import { DEV_ROLES, devRoleMockUsers, findDevRole } from '../src/dev-auth/roles'
import {
  DEV_PROVIDER_SLUG,
  ensureSeedAdminSession,
  generatePassword,
  sessionTokenFromCallbackLocation,
  startRoleAuthorization,
  type CliResult,
} from '../src/dev-auth/seed'
import { DevAuthPortInUseError, safeRedirect, startDevAuthServer } from '../src/dev-auth/server'
import { pidIsAlive, startOrphanWatchdog } from '../src/dev-auth/lifecycle'

function repoRoot(): string {
  return resolve(import.meta.dir, '..', '..', '..')
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'aw-dev-auth-'))
  cleanups.push(async () => await rm(home, { recursive: true, force: true }))
  return home
}

const noopCli = async (): Promise<CliResult> => ({ status: 0, stdout: '', stderr: '' })

async function startService(options: { home: string; appOrigin?: string; autoSeed?: boolean }) {
  const service = await startDevAuthServer({
    runCli: noopCli,
    port: 0,
    autoSeed: false,
    ...options,
  })
  cleanups.push(async () => await service.close())
  return service
}

function listen(server: Server): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('unexpected address'))
        return
      }
      cleanups.push(async () => await new Promise<void>((done) => server.close(() => done())))
      resolvePromise(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe('dev role fixtures', () => {
  test('cover exactly the four platform roles with distinct identities', () => {
    expect(DEV_ROLES.map((role) => role.key)).toEqual(['admin', 'manager', 'user', 'guest'])
    expect(new Set(DEV_ROLES.map((role) => role.sub)).size).toBe(4)
    expect(new Set(DEV_ROLES.map((role) => role.username)).size).toBe(4)
    expect(findDevRole('manager')?.username).toBe('dev-manager')
    expect(findDevRole('root')).toBeUndefined()
  })

  test('the mock identity carries preferred_username — the claim the daemon derives the username from', () => {
    const users = devRoleMockUsers()
    expect(users).toHaveLength(4)
    for (const role of DEV_ROLES) {
      const user = users.find((candidate) => candidate.sub === role.sub)
      expect(user?.preferredUsername).toBe(role.username)
      expect(user?.emailVerified).toBe(true)
    }
  })
})

describe('one-click page', () => {
  const baseState = (seed: DevAuthPageState['seed']): DevAuthPageState => ({
    startedAt: 1_760_000_000_000,
    home: '/tmp/home',
    appOrigin: 'http://localhost:5174',
    daemonBaseUrl: 'http://127.0.0.1:7456',
    issuerUrl: 'http://127.0.0.1:7460/oidc/abcd',
    seed,
  })

  test('offers one live link per role once seeding succeeded', () => {
    const html = renderDevAuthPage(
      baseState({
        status: 'ok',
        result: {
          providerSlug: DEV_PROVIDER_SLUG,
          providerId: 'p1',
          adminUsername: 'dev_seed_admin',
          seededAt: 1,
          roles: DEV_ROLES.map((role) => ({
            key: role.key,
            username: role.username,
            userId: `id-${role.key}`,
            displayName: role.displayName,
          })),
        },
      }),
    )
    for (const role of DEV_ROLES) {
      expect(html).toContain(`href="/login/${role.key}"`)
      expect(html).toContain(`data-testid="login-${role.key}"`)
    }
    // The stylesheet itself names the disabled modifier, so assert on the
    // rendered anchor's class attribute rather than the substring.
    expect(html).not.toContain('class="card__cta card__cta--disabled"')
  })

  test('keeps every button dead until the accounts exist', () => {
    const html = renderDevAuthPage(baseState({ status: 'pending' }))
    expect(html).not.toContain('href="/login/admin"')
    expect(html.match(/class="card__cta card__cta--disabled"/g)).toHaveLength(4)
    expect(html).toContain('http-equiv="refresh"')
  })

  test('gives every role its own accent and names the role on its button', () => {
    // The anti-misclick property: four identical buttons a few pixels apart is
    // how you audit the wrong role. Colour + label are what tell them apart.
    const html = renderDevAuthPage(
      baseState({
        status: 'ok',
        result: {
          providerSlug: DEV_PROVIDER_SLUG,
          providerId: 'p1',
          adminUsername: 'dev_seed_admin',
          seededAt: 1,
          roles: DEV_ROLES.map((role) => ({
            key: role.key,
            username: role.username,
            userId: `id-${role.key}`,
            displayName: role.displayName,
          })),
        },
      }),
    )
    const accents = [...html.matchAll(/--role:(#[0-9a-f]{6})/g)].map((match) => match[1])
    expect(accents).toHaveLength(DEV_ROLES.length)
    expect(new Set(accents).size).toBe(DEV_ROLES.length)
    for (const role of DEV_ROLES) expect(html).toContain(`>\u4ee5 ${role.key} \u767b\u5f55</a>`)
  })

  test('escapes the seed failure instead of pasting daemon output into the DOM', () => {
    const html = renderDevAuthPage(
      baseState({ status: 'error', message: '<img src=x onerror="alert(1)">' }),
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('redirect handling', () => {
  test('only same-origin absolute paths survive', () => {
    expect(safeRedirect('/tasks?filter=mine')).toBe('/tasks?filter=mine')
    expect(safeRedirect(null)).toBe('/agents')
    expect(safeRedirect('//evil.example')).toBe('/agents')
    expect(safeRedirect('/\\evil.example')).toBe('/agents')
    expect(safeRedirect('https://evil.example')).toBe('/agents')
  })

  test('reads the session token out of the daemon callback fragment', () => {
    expect(sessionTokenFromCallbackLocation('/agents#aw_session=aws_s_abc')).toBe('aws_s_abc')
    expect(
      sessionTokenFromCallbackLocation(`/agents#aw_session=${encodeURIComponent('a b')}`),
    ).toBe('a b')
    expect(sessionTokenFromCallbackLocation('/agents')).toBeNull()
    expect(sessionTokenFromCallbackLocation('/agents#aw_session=')).toBeNull()
  })
})

describe('dev auth service', () => {
  test('serves the page, the status document and refuses logins before seeding', async () => {
    const home = await temporaryHome()
    const service = await startService({ home })

    const page = await fetch(service.url)
    expect(page.status).toBe(200)
    const html = await page.text()
    for (const role of DEV_ROLES) expect(html).toContain(`data-testid="login-${role.key}"`)

    const status = (await (await fetch(`${service.url}/status.json`)).json()) as {
      seed: { status: string }
      issuerUrl: string
      home: string
    }
    expect(status.seed.status).toBe('pending')
    expect(status.home).toBe(home)
    expect(status.issuerUrl).toBe(service.issuerUrl)

    expect((await fetch(`${service.url}/login/admin`, { redirect: 'manual' })).status).toBe(503)
    expect((await fetch(`${service.url}/login/root`, { redirect: 'manual' })).status).toBe(404)
  })

  test('never lets a browser keep the page or the status document', async () => {
    // Reported from a live session: the service was already serving the new
    // layout while the developer's tab still showed the old one. Every byte here
    // is per-process state, so a cached copy is a render from a process that no
    // longer exists.
    const home = await temporaryHome()
    const service = await startService({ home })
    for (const path of ['/', '/status.json']) {
      const response = await fetch(`${service.url}${path}`)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  test('every process gets its own issuer path, so a restart re-keys the daemon JWKS cache', async () => {
    const home = await temporaryHome()
    const first = await startService({ home })
    const second = await startService({ home })

    expect(first.issuerUrl).not.toBe(second.issuerUrl)
    expect(new URL(first.issuerUrl).pathname).toMatch(/^\/oidc\/[0-9a-f]{8}$/)

    const discovery = (await (
      await fetch(`${first.issuerUrl}/.well-known/openid-configuration`)
    ).json()) as { issuer: string; jwks_uri: string; authorization_endpoint: string }
    expect(discovery.issuer).toBe(first.issuerUrl)
    expect(discovery.jwks_uri).toBe(`${first.issuerUrl}/jwks.json`)

    const keys = (await (await fetch(discovery.jwks_uri)).json()) as { keys: Array<{ n: string }> }
    const otherDiscovery = (await (
      await fetch(`${second.issuerUrl}/.well-known/openid-configuration`)
    ).json()) as { jwks_uri: string }
    const otherKeys = (await (await fetch(otherDiscovery.jwks_uri)).json()) as {
      keys: Array<{ n: string }>
    }
    // Different key material behind different URLs is precisely what stops the
    // daemon from verifying a new token against a cached old key.
    expect(keys.keys[0]?.n).not.toBe(otherKeys.keys[0]?.n)
  })

  test('answers the IdP account chooser server-side and yields a redeemable code', async () => {
    const home = await temporaryHome()
    const service = await startService({ home })
    const role = DEV_ROLES[0]!
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const redirectUri = 'http://localhost:5174/api/auth/oidc/dev-roles/callback'

    // Stands in for the daemon's `login/start`: mints the same authorize URL the
    // real one does (PKCE + state stay the caller's).
    const daemonBase = await listen(
      createServer((request, response) => {
        if (request.url === `/api/auth/oidc/${DEV_PROVIDER_SLUG}/login/start`) {
          const authorizeUrl = new URL(`${service.issuerUrl}/authorize`)
          authorizeUrl.searchParams.set('response_type', 'code')
          authorizeUrl.searchParams.set('client_id', MOCK_OIDC_CLIENT_ID)
          authorizeUrl.searchParams.set('redirect_uri', redirectUri)
          authorizeUrl.searchParams.set('scope', 'openid profile email')
          authorizeUrl.searchParams.set('state', 'state-1')
          authorizeUrl.searchParams.set('code_challenge', challenge)
          authorizeUrl.searchParams.set('code_challenge_method', 'S256')
          authorizeUrl.searchParams.set('nonce', 'nonce-1')
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ authorizeUrl: authorizeUrl.toString() }))
          return
        }
        response.writeHead(404)
        response.end()
      }),
    )

    const handoff = await startRoleAuthorization({
      baseUrl: daemonBase,
      issuerUrl: service.issuerUrl,
      role,
    })
    const callback = new URL(handoff.callbackUrl)
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri)
    expect(callback.searchParams.get('state')).toBe('state-1')
    const code = callback.searchParams.get('code')
    expect(code).not.toBeNull()

    const token = (await (
      await fetch(`${service.issuerUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code ?? '',
          redirect_uri: redirectUri,
          code_verifier: verifier,
          client_id: MOCK_OIDC_CLIENT_ID,
          client_secret: MOCK_OIDC_CLIENT_SECRET,
        }),
      })
    ).json()) as { id_token?: string; access_token?: string }
    expect(typeof token.id_token).toBe('string')

    const userinfo = (await (
      await fetch(`${service.issuerUrl}/userinfo`, {
        headers: { authorization: `Bearer ${token.access_token ?? ''}` },
      })
    ).json()) as { sub: string; preferred_username: string }
    // The chooser answer decides WHICH account the daemon will provision.
    expect(userinfo.sub).toBe(role.sub)
    expect(userinfo.preferred_username).toBe(role.username)
  })
})

describe('identity chooser (login started from the product login page)', () => {
  // Reported from a live session: the developer clicked the `[dev]` identity
  // provider on the product login page, landed on the shared mock's bare
  // chooser, and reasonably read it as "the buttons are still the old ones".
  // That page is part of this flow, so it gets the same treatment.
  async function authorizeUrl(service: { issuerUrl: string }): Promise<URL> {
    const url = new URL(`${service.issuerUrl}/authorize`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', MOCK_OIDC_CLIENT_ID)
    url.searchParams.set('redirect_uri', 'http://localhost:5174/api/auth/oidc/dev-roles/callback')
    url.searchParams.set('scope', 'openid profile email')
    url.searchParams.set('state', 'state-9')
    url.searchParams.set('code_challenge', 'challenge-9')
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('nonce', 'nonce-9')
    return url
  }

  test('renders one styled card per dev role and replays the request verbatim', async () => {
    const home = await temporaryHome()
    const service = await startService({ home })
    const response = await fetch((await authorizeUrl(service)).toString())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()

    for (const role of DEV_ROLES) {
      expect(html).toContain(`data-testid="oidc-user-${role.sub}"`)
      expect(html).toContain(`value="${role.sub}"`)
    }
    const accents = [...html.matchAll(/--role:(#[0-9a-f]{6})/g)].map((match) => match[1])
    expect(new Set(accents).size).toBe(DEV_ROLES.length)
    // Every parameter of the authorization request must survive into the POST,
    // or the daemon's PKCE/state check rejects the callback it started.
    for (const key of ['state', 'code_challenge', 'nonce', 'redirect_uri', 'client_id']) {
      expect(html).toContain(`name="${key}"`)
    }
    expect(html).toContain('name="state" value="state-9"')
    expect(html).toContain(`action="${service.issuerUrl}/authorize"`)
  })

  test('submitting a card yields a redeemable code, exactly like the bare mock did', async () => {
    const home = await temporaryHome()
    const service = await startService({ home })
    const url = await authorizeUrl(service)
    const form = new URLSearchParams(url.searchParams)
    form.set('mock_sub', DEV_ROLES[0]!.sub)
    const posted = await fetch(`${service.issuerUrl}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      redirect: 'manual',
    })
    expect(posted.status).toBe(302)
    const location = new URL(posted.headers.get('location') ?? '')
    expect(location.searchParams.get('state')).toBe('state-9')
    expect(location.searchParams.get('code')).toBeTruthy()
  })

  test("a malformed authorization request still gets the mock's own answer", async () => {
    const home = await temporaryHome()
    const service = await startService({ home })
    const url = await authorizeUrl(service)
    url.searchParams.delete('state')
    const response = await fetch(url.toString())
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('missing state')

    const wrongClient = await authorizeUrl(service)
    wrongClient.searchParams.set('client_id', 'not-our-client')
    const rejected = await fetch(wrongClient.toString())
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe('unknown client_id')
  })
})

describe('process lifecycle', () => {
  // Measured on bun 1.3.13 before this existed: a terminal Ctrl-C (group SIGINT)
  // did take the service down with `bun dev`, but `kill -9` on the filter runner
  // left this process reparented to pid 1 and still holding the login port, so
  // the next `bun dev` met EADDRINUSE from a process nobody remembered starting.
  function watchdogHarness(overrides: {
    parentPid?: number
    currentParentPid?: () => number
    isAlive?: (pid: number) => boolean
  }) {
    const fired: string[] = []
    let tick: (() => void) | null = null
    const stop = startOrphanWatchdog({
      parentPid: overrides.parentPid ?? 4242,
      currentParentPid: overrides.currentParentPid ?? (() => 4242),
      isAlive: overrides.isAlive ?? (() => true),
      onOrphaned: (reason) => fired.push(reason),
      setTimer: (callback) => {
        tick = callback
        return 'timer'
      },
      clearTimer: () => {
        tick = null
      },
    })
    return { fired, run: () => tick?.(), stop }
  }

  test('stays quiet while the parent is alive and unchanged', () => {
    const harness = watchdogHarness({})
    harness.run()
    harness.run()
    expect(harness.fired).toEqual([])
  })

  test('fires once when the process is reparented', () => {
    const harness = watchdogHarness({ currentParentPid: () => 1 })
    harness.run()
    harness.run()
    expect(harness.fired).toHaveLength(1)
    expect(harness.fired[0]).toContain('reparented to 1')
  })

  test('fires when the original parent is simply gone', () => {
    const harness = watchdogHarness({ isAlive: () => false })
    harness.run()
    expect(harness.fired[0]).toContain('no longer exists')
  })

  test('never watches a process that was already detached', () => {
    const harness = watchdogHarness({ parentPid: 1, currentParentPid: () => 1 })
    harness.run()
    // nohup / launchd runs have no parent to outlive; firing here would kill
    // every deliberately detached instance.
    expect(harness.fired).toEqual([])
  })

  test('signal-0 probe answers for a live pid and a certainly-dead one', () => {
    expect(pidIsAlive(process.pid)).toBe(true)
    expect(pidIsAlive(2_147_483_600)).toBe(false)
  })

  test('shutdown does not wait for an idle keep-alive socket', async () => {
    const home = await temporaryHome()
    const service = await startService({ home })
    const port = Number(new URL(service.url).port)
    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolvePromise, reject) => {
      socket.once('connect', () => resolvePromise())
      socket.once('error', reject)
    })
    const startedAt = Date.now()
    await service.close()
    socket.destroy()
    // `server.close()` on its own parks until the peer times out — that delay is
    // the port staying held after the developer already quit.
    expect(Date.now() - startedAt).toBeLessThan(1500)
  })

  test('a held port produces the remedy, not a bare EADDRINUSE', async () => {
    const home = await temporaryHome()
    const first = await startService({ home })
    const port = Number(new URL(first.url).port)
    const conflict = await startDevAuthServer({
      home,
      runCli: noopCli,
      port,
      autoSeed: false,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(conflict).toBeInstanceOf(DevAuthPortInUseError)
    expect((conflict as Error).message).toContain(`port ${port} is already in use`)
    expect((conflict as Error).message).toContain('pkill -f dev-auth/cli.ts')
  })

  test('an orphaned service exits instead of holding the port forever', async () => {
    const home = await temporaryHome()
    // `sh` stands in for the `bun run --filter` parent: it starts the service in
    // the background and waits, so killing IT leaves a real reparented orphan —
    // the case a group signal never reaches.
    const cli = join(repoRoot(), 'packages', 'system-mocks', 'src', 'dev-auth', 'cli.ts')
    const parent = spawn('sh', ['-c', `bun run ${cli} & echo "CHILD:$!"; wait`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_WORKFLOW_HOME: home, AW_DEV_AUTH_PORT: '0' },
    })
    let output = ''
    const servicePid = await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`dev-auth never started: ${output}`)), 40_000)
      parent.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        const pid = /CHILD:(\d+)/.exec(output)?.[1]
        if (pid !== undefined && output.includes('role login page')) {
          clearTimeout(timer)
          resolvePromise(Number(pid))
        }
      })
      parent.once('error', reject)
    })
    cleanups.push(async () => {
      for (const pid of [servicePid, parent.pid ?? 0]) {
        try {
          if (pid > 0) process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone — the point of the test */
        }
      }
    })

    expect(pidIsAlive(servicePid)).toBe(true)
    process.kill(parent.pid ?? 0, 'SIGKILL')

    const deadline = Date.now() + 20_000
    let alive = true
    while (Date.now() < deadline) {
      await new Promise<void>((done) => setTimeout(done, 500))
      alive = pidIsAlive(servicePid)
      if (!alive) break
    }
    expect(alive).toBe(false)
  }, 90_000)
})

describe('seed administrator recovery', () => {
  test('rotates the password through the CLI when the account already exists, then clears the forced change', async () => {
    const home = await temporaryHome()
    const calls: string[][] = []
    let resetPassword: string | null = null
    const daemonBase = await listen(
      createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            username?: string
            password?: string
            newPassword?: string
          }
          if (request.url === '/api/auth/login') {
            if (body.password === resetPassword) {
              response.writeHead(200, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ sessionToken: 'session-1', mustChangePassword: true }))
              return
            }
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ code: 'unauthorized', message: 'nope' }))
            return
          }
          if (request.url === '/api/auth/change-password') {
            resetPassword = body.newPassword ?? null
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: true, sessionToken: 'session-2' }))
            return
          }
          response.writeHead(404)
          response.end()
        })
      }),
    )

    const session = await ensureSeedAdminSession({
      home,
      baseUrl: daemonBase,
      runCli: async (args: string[]): Promise<CliResult> => {
        calls.push(args)
        if (args[1] === 'create') {
          return {
            status: 1,
            stdout: "error: username 'dev_seed_admin' already exists\n",
            stderr: '',
          }
        }
        resetPassword = args[args.indexOf('--new-password') + 1] ?? null
        return { status: 0, stdout: 'reset\n', stderr: '' }
      },
    })

    expect(calls[0]?.slice(0, 2)).toEqual(['user', 'create'])
    expect(calls[1]?.slice(0, 2)).toEqual(['user', 'reset-password'])
    // The forced change is consumed by the seeder — a session that still owes a
    // password change is not one the developer can quietly keep using.
    expect(session.token).toBe('session-2')
    const stored = JSON.parse(readFileSync(join(home, '.dev-auth.json'), 'utf8')) as {
      username: string
      password: string
    }
    expect(stored.username).toBe('dev_seed_admin')
    expect(resetPassword).toBeTypeOf('string')
    expect(stored.password).toBe(String(resetPassword))
    expect(stored.password).not.toBe(calls[1]?.[calls[1].indexOf('--new-password') + 1])
  })

  test('generated passwords satisfy the platform minimum and never repeat', () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()))
    expect(passwords.size).toBe(20)
    for (const password of passwords) expect(password.length).toBeGreaterThanOrEqual(8)
  })
})

describe('production isolation', () => {
  test('no product source mentions the dev login provider or its accounts', () => {
    const markers = [DEV_PROVIDER_SLUG, 'dev_seed_admin', 'dev-auth']
    for (const packageName of ['backend', 'frontend', 'shared']) {
      for (const path of sourceFiles(join(repoRoot(), 'packages', packageName, 'src'))) {
        const source = readFileSync(path, 'utf8')
        for (const marker of markers) {
          expect(`${path}:${source.includes(marker) ? marker : ''}`).toBe(`${path}:`)
        }
      }
    }
  })

  test('`bun dev` starts the service through the mock package, not a product script', () => {
    const mocks = JSON.parse(
      readFileSync(join(repoRoot(), 'packages', 'system-mocks', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    expect(mocks.scripts?.dev).toBe('bun run src/dev-auth/cli.ts')
    const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(root.scripts?.dev).toBe("bun run --filter '*' dev")
  })
})

function sourceFiles(root: string): string[] {
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined || !existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  return files
}
