import { rimrafDir } from './helpers/cleanup'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isWindows } from './helpers/stub-runtime'
import { stopCommand } from '../src/cli/stop'
import { readPidFromLock } from '../src/util/lock'

const mainPath = resolve(import.meta.dir, '..', 'src', 'main.ts')

/** Stop the daemon whose home is `homeTmp` via the in-process `stop` command.
 *  On Windows `child.kill('SIGTERM')` only terminates the shell wrapper that
 *  Bun.spawn creates for an array cmd - the daemon process keeps running and
 *  holds the lock, blocking the next spawn. `stopCommand` POSTs /api/shutdown
 *  for a graceful exit (lock removed). POSIX uses the same path. RFC-W001. */
async function stopDaemon(homeTmp: string): Promise<void> {
  const prev = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = homeTmp
  try {
    await stopCommand({ timeoutMs: 10_000 })
  } finally {
    if (prev === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = prev
  }
}

// Tests 1-3 are read-only / idempotent contract checks against an IDENTICAL
// fresh daemon, so they share ONE spawn (beforeAll) instead of paying the
// ~400ms spawn-to-ready cost three times. The config-PUT test runs LAST because
// it is the only one that MUTATES config — the two read-only tests above must
// observe pristine DEFAULT_CONFIG first. Lifecycle tests (restart / lock) keep
// their own per-test daemons below.
describe('daemon start — read-only contract on a shared daemon (M1 P-1-01..P-1-04)', () => {
  let tmp: string
  let child: ReturnType<typeof spawnDaemon>
  let url: string
  let token: string

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-daemon-'))
    const env = { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp }
    child = spawnDaemon(env)
    ;({ url, token } = await waitForReady(child.stdout, 10_000))
  })

  afterAll(async () => {
    await stopDaemon(tmp)
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    try {
      await child.exited
    } catch {
      /* ignore */
    }
    rimrafDir(tmp)
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

    const okRes = await fetch(`${url}api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(okRes.status).toBe(200)

    const nfRes = await fetch(`${url}api/no-such-route?token=${token}`)
    expect(nfRes.status).toBe(404)
    const nf = (await nfRes.json()) as Record<string, unknown>
    expect(nf.code).toBe('route-not-found')
  })

  // LAST: mutates config (PUT). Keep after the read-only tests above.
  test('GET /api/config returns full DEFAULT_CONFIG; PUT merges patch', async () => {
    const auth = { Authorization: `Bearer ${token}` }

    // Initial GET.
    const getRes = await fetch(`${url}api/config`, { headers: auth })
    expect(getRes.status).toBe(200)
    const cfg = (await getRes.json()) as Record<string, unknown>
    expect(cfg.$schema_version).toBe(1)
    expect(cfg.maxConcurrentNodes).toBe(4)
    expect(cfg.bindHost).toBe('127.0.0.1')
    expect(cfg.theme).toBe('system')
    expect(cfg.language).toBe('zh-CN')

    // PUT a patch — change theme + maxConcurrentNodes.
    const putRes = await fetch(`${url}api/config`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', maxConcurrentNodes: 8 }),
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
    rimrafDir(tmp)
  })

  test('token + config persist across daemon restarts', async () => {
    let token1: string
    {
      const child = spawnDaemon(env)
      try {
        ;({ token: token1 } = await waitForReady(child.stdout, 10_000))
      } finally {
        await stopDaemon(tmp)
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        try {
          await child.exited
        } catch {
          /* ignore */
        }
      }
    }
    {
      const child = spawnDaemon(env)
      try {
        const { token: token2 } = await waitForReady(child.stdout, 10_000)
        expect(token2).toBe(token1)
      } finally {
        await stopDaemon(tmp)
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        try {
          await child.exited
        } catch {
          /* ignore */
        }
      }
    }

    // Token file mode preserved across restarts.
    // On Windows, chmod is no-op; ACL verified separately in platform-fs.test.ts.
    const tokenFile = join(tmp, 'token')
    expect(existsSync(tokenFile)).toBe(true)
    if (!isWindows) {
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    }

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

      // The lock file holds the daemon's real pid. On Windows Bun.spawn wraps
      // the array cmd in a shell, so first.pid is the shell's pid, not the
      // daemon's - the second start reports the daemon pid from the lock.
      const lockPid = readPidFromLock(join(tmp, '.daemon.lock'))
      const second = spawnDaemon(env)
      const exitCode = await second.exited
      expect(exitCode).toBe(1)
      const stderr = await new Response(second.stderr).text()
      expect(stderr).toContain('another daemon is already running')
      expect(stderr).toContain(`PID ${lockPid ?? first.pid ?? -1}`)
    } finally {
      await stopDaemon(tmp)
      try {
        first.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      try {
        await first.exited
      } catch {
        /* ignore */
      }
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
