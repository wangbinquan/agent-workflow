import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mainPath = resolve(import.meta.dir, '..', 'src', 'main.ts')

// Tests 1-3 share one daemon and complete the RFC-221 bootstrap handoff in
// beforeAll, avoiding the ~400ms spawn-to-ready cost three times. The config-PUT
// test runs LAST because it mutates config; lifecycle tests keep independent
// per-test daemons below.
describe('daemon start — HTTP contract on a shared bootstrapped daemon (M1 P-1-01..P-1-04)', () => {
  let tmp: string
  let child: ReturnType<typeof spawnDaemon>
  let url: string
  let token: string
  let sessionToken: string

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-daemon-'))
    const env = { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp }
    child = spawnDaemon(env)
    ;({ url, token } = await waitForReady(child.stdout, 10_000))

    // RFC-221: the daemon token is bootstrap-only. Complete the one-way
    // handoff once, then exercise the normal API contract with an admin
    // session rather than relying on a credential that must now be retired.
    const bootstrap = await fetch(`${url}api/auth/bootstrap/admin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: 'daemon-test-admin',
        displayName: 'Daemon test admin',
        password: 'correctPassword123',
      }),
    })
    if (bootstrap.status !== 201) {
      throw new Error(`bootstrap admin failed: ${bootstrap.status} ${await bootstrap.text()}`)
    }
    const login = await fetch(`${url}api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'daemon-test-admin',
        password: 'correctPassword123',
      }),
    })
    if (login.status !== 200) {
      throw new Error(`admin login failed: ${login.status} ${await login.text()}`)
    }
    ;({ sessionToken } = (await login.json()) as { sessionToken: string })
  })

  afterAll(async () => {
    child.kill('SIGTERM')
    await child.exited
    rmSync(tmp, { recursive: true, force: true })
  })

  test('serves /health with full schema after successful startup', async () => {
    // /health is public and returns the full schema per design.md §4.2.2.
    const res = await fetch(`${url}health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(typeof body.opencodeVersion).toBe('string')
    expect(body.opencodeVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof body.dbVersion).toBe('number')
    expect(typeof body.uptime).toBe('number')
    expect(body.runningTasks).toBe(0)
    // Token sanity-check just to use the variable (auth covered below).
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('/api/* unauthorized returns 401; route-not-found also uses standard schema', async () => {
    const unauthRes = await fetch(`${url}api/whoami`)
    expect(unauthRes.status).toBe(401)
    const unauth = (await unauthRes.json()) as Record<string, unknown>
    expect(unauth.code).toBe('unauthorized')

    const retired = await fetch(`${url}api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(retired.status).toBe(401)

    const okRes = await fetch(`${url}api/whoami`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
    expect(okRes.status).toBe(200)

    const nfRes = await fetch(`${url}api/no-such-route`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
    expect(nfRes.status).toBe(404)
    const nf = (await nfRes.json()) as Record<string, unknown>
    expect(nf.code).toBe('route-not-found')
  })

  // LAST: mutates config (PUT). Keep after the read-only tests above.
  test('GET /api/config returns full DEFAULT_CONFIG; PUT merges patch', async () => {
    const auth = { Authorization: `Bearer ${sessionToken}` }

    // Initial GET.
    const getRes = await fetch(`${url}api/config`, { headers: auth })
    expect(getRes.status).toBe(200)
    const cfg = (await getRes.json()) as Record<string, unknown>
    expect(cfg.$schema_version).toBe(1)
    expect(cfg.maxConcurrentNodes).toBe(4)
    expect(cfg.bindHost).toBe('127.0.0.1')
    expect(cfg.theme).toBe('system')
    expect(cfg.language).toBe('zh-CN')

    // PUT a patch — change theme + maxConcurrentNodes. RFC-224 validates the
    // complete merged system-agent execution policy on every config write, so
    // make the three inherited OpenCode system profiles explicit in this fresh
    // daemon fixture instead of relying on OpenCode's implicit model.
    const putRes = await fetch(`${url}api/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        theme: 'dark',
        maxConcurrentNodes: 8,
        memoryDistillModel: 'test/model',
        commitPushModel: 'test/model',
        mergeAgentModel: 'test/model',
      }),
    })
    expect(putRes.status).toBe(200)
    const updated = (await putRes.json()) as Record<string, unknown>
    expect(updated.theme).toBe('dark')
    expect(updated.maxConcurrentNodes).toBe(8)
    expect(updated.bindHost).toBe('127.0.0.1') // preserved

    // GET again confirms persistence.
    const reread = (await (await fetch(`${url}api/config`, { headers: auth })).json()) as Record<
      string,
      unknown
    >
    expect(reread.theme).toBe('dark')
    expect(reread.maxConcurrentNodes).toBe(8)

    // Invalid patch — wrong type.
    const badRes = await fetch(`${url}api/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrentNodes: -1 }),
    })
    expect(badRes.status).toBe(422)
    const badBody = (await badRes.json()) as Record<string, unknown>
    expect(badBody.ok).toBe(false)
    expect(badBody.code).toBe('config-invalid')
  })
})

// Lifecycle tests need independent daemon processes (restart / second-instance
// lock), so they keep a fresh home + their own spawns per test.
describe('daemon start — lifecycle (per-test daemon)', () => {
  let tmp: string
  let env: Record<string, string>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-daemon-'))
    env = { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp }
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('token + config persist across daemon restarts', async () => {
    let token1: string
    {
      const child = spawnDaemon(env)
      try {
        ;({ token: token1 } = await waitForReady(child.stdout, 10_000))
      } finally {
        child.kill('SIGTERM')
        await child.exited
      }
    }
    {
      const child = spawnDaemon(env)
      try {
        const { token: token2 } = await waitForReady(child.stdout, 10_000)
        expect(token2).toBe(token1)
      } finally {
        child.kill('SIGTERM')
        await child.exited
      }
    }

    // Token file mode preserved across restarts.
    const tokenFile = join(tmp, 'token')
    expect(existsSync(tokenFile)).toBe(true)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)

    // Daemon log accumulated info.
    const logFile = join(tmp, 'logs', 'daemon.log')
    expect(existsSync(logFile)).toBe(true)
    const logged = readFileSync(logFile, 'utf-8')
    expect(logged).toContain('lock acquired')
    expect(logged).toContain('opencode probe ok')
    expect(logged).toContain('db ready')
  })

  test('a second daemon start is rejected while the first holds the lock', async () => {
    const first = spawnDaemon(env)
    try {
      await waitForReady(first.stdout, 10_000)

      const second = spawnDaemon(env)
      const exitCode = await second.exited
      expect(exitCode).toBe(1)
      const stderr = await new Response(second.stderr).text()
      expect(stderr).toContain('another daemon is already running')
      expect(stderr).toContain(`PID ${first.pid ?? -1}`)
    } finally {
      first.kill('SIGTERM')
      await first.exited
    }
  })
})

// --- helpers ---

function spawnDaemon(env: Record<string, string>) {
  return Bun.spawn({
    cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })
}

async function waitForReady(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<{ url: string; token: string }> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) throw new Error('daemon exited before ready:\n' + buffer)
      buffer += decoder.decode(value, { stream: true })
      const m = buffer.match(/(http:\/\/[0-9.]+:\d+\/)\?token=([0-9a-f]+)/)
      if (m && m[1] !== undefined && m[2] !== undefined) {
        return { url: m[1], token: m[2] }
      }
    }
    throw new Error(`timed out within ${timeoutMs}ms; stdout so far:\n${buffer}`)
  } finally {
    reader.releaseLock()
  }
}
