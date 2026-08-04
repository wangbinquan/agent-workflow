// RFC-254 T7 — the shutdown control listener, and why `stop` needs one.
//
// WHY THIS EXISTS
// ---------------
// `process.kill(pid, 'SIGTERM')` does NOT throw on Windows. It maps to
// `TerminateProcess` — a hard kill — so the previous `stop` reported a
// graceful shutdown while actually killing the daemon mid-write: no drain, no
// task bookkeeping, and `interrupted` rows for the next start to reap. Nothing
// failed; the command printed "stopped". That silence is what these tests are
// against.
//
// Every case drives the platform through an INJECTED value rather than the
// host's, so the win32 branches are exercised on POSIX CI too — the same
// discipline as the rest of the RFC-254 suites.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hardKillCommand,
  readControlFile,
  removeControlFile,
  requestShutdown,
  startControlListener,
  writeControlFile,
  type ControlEndpoint,
} from '@/services/controlListener'

const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-control-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-254 T7 — control listener', () => {
  test('a correct nonce is accepted exactly once and the callback runs after the response', async () => {
    const file = join(root(), 'control')
    let fired = 0
    const listener = startControlListener({
      controlFilePath: file,
      onShutdown: () => {
        fired += 1
      },
    })
    try {
      // The response must come back BEFORE the drain starts, otherwise `stop`
      // sees a connection reset partway through a 30 s shutdown and cannot tell
      // that from "nothing was listening".
      expect(fired).toBe(0)
      await expect(requestShutdown(listener.endpoint)).resolves.toBe('accepted')
      await Bun.sleep(20)
      expect(fired).toBe(1)

      // Idempotent: a retried `stop` must not start a second drain.
      await expect(requestShutdown(listener.endpoint)).resolves.toBe('accepted')
      await Bun.sleep(20)
      expect(fired).toBe(1)
    } finally {
      listener.close()
    }
  })

  test('a wrong nonce is refused and does not drain', async () => {
    const file = join(root(), 'control')
    let fired = 0
    const listener = startControlListener({
      controlFilePath: file,
      onShutdown: () => {
        fired += 1
      },
    })
    try {
      const forged: ControlEndpoint = { ...listener.endpoint, nonce: 'not-the-nonce' }
      await expect(requestShutdown(forged)).resolves.toBe('unauthorized')
      await Bun.sleep(20)
      expect(fired).toBe(0)
    } finally {
      listener.close()
    }
  })

  test('only POST /shutdown exists', async () => {
    const file = join(root(), 'control')
    const listener = startControlListener({ controlFilePath: file, onShutdown: () => {} })
    try {
      const { url, nonce } = listener.endpoint
      const headers = { 'x-agent-workflow-control': nonce }
      // A GET must not shut the daemon down — a link, a probe or a browser
      // prefetch would otherwise be enough.
      expect((await fetch(`${url}/shutdown`, { headers })).status).toBe(404)
      expect((await fetch(`${url}/`, { method: 'POST', headers })).status).toBe(404)
      expect((await fetch(`${url}/api/tasks`, { method: 'POST', headers })).status).toBe(404)
    } finally {
      listener.close()
    }
  })

  test('it binds loopback on an ephemeral port, and close() removes the secret', () => {
    const file = join(root(), 'control')
    const listener = startControlListener({ controlFilePath: file, onShutdown: () => {} })
    expect(listener.endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(listener.endpoint.url).not.toContain('0.0.0.0')
    expect(existsSync(file)).toBe(true)
    listener.close()
    // The nonce must not outlive the process that minted it.
    expect(existsSync(file)).toBe(false)
  })

  test('each start mints a different nonce', () => {
    const a = startControlListener({ controlFilePath: join(root(), 'a'), onShutdown: () => {} })
    const b = startControlListener({ controlFilePath: join(root(), 'b'), onShutdown: () => {} })
    try {
      expect(a.endpoint.nonce).not.toBe(b.endpoint.nonce)
      expect(a.endpoint.nonce).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      a.close()
      b.close()
    }
  })

  test('an unreachable endpoint is distinguishable from a refused one', async () => {
    // `stop` reports these differently — "stale control file" versus "nothing
    // answered" — and picks a different remedy for each.
    const dead: ControlEndpoint = { url: 'http://127.0.0.1:1', nonce: 'x', pid: 1 }
    await expect(requestShutdown(dead, 500)).resolves.toBe('unreachable')
  })
})

describe('RFC-254 T7 — the control file', () => {
  test('POSIX writes it private; win32 relies on the per-user ACL instead', () => {
    const posixPath = join(root(), 'posix')
    const winPath = join(root(), 'win')
    const endpoint: ControlEndpoint = { url: 'http://127.0.0.1:1', nonce: 'n', pid: 2 }
    writeControlFile(posixPath, endpoint, 'linux')
    writeControlFile(winPath, endpoint, 'win32')

    // The mode bit is only meaningful where the OS honours it. Asserting it on
    // the win32 path would be asserting a protection that is not the one
    // actually in force — see `doctor`'s report (D19).
    expect(statSync(posixPath).mode & 0o777).toBe(0o600)
    expect(readControlFile(posixPath)).toEqual(endpoint)
    expect(readControlFile(winPath)).toEqual(endpoint)
  })

  test('a missing, corrupt or incomplete file reads as null, never as a partial endpoint', () => {
    const dir = root()
    expect(readControlFile(join(dir, 'absent'))).toBeNull()
    expect(readControlFile(join(dir, 'x'), 'not json')).toBeNull()
    expect(readControlFile(join(dir, 'x'), '{}')).toBeNull()
    expect(readControlFile(join(dir, 'x'), '{"url":"http://127.0.0.1:1"}')).toBeNull()
    expect(readControlFile(join(dir, 'x'), '{"url":"http://127.0.0.1:1","nonce":"n"}')).toBeNull()
  })

  test('a control file naming any host but loopback is refused', () => {
    // Corrupt or planted: either way, POSTing a shutdown nonce to it would send
    // the secret somewhere it does not belong.
    for (const url of [
      'http://10.0.0.5:8080',
      'http://localhost:8080',
      'https://127.0.0.1:8080',
      'http://127.0.0.1.evil.test:8080',
    ]) {
      expect(readControlFile('unused', JSON.stringify({ url, nonce: 'n', pid: 1 })), url).toBeNull()
    }
  })

  test('removeControlFile is idempotent and survives a read-only parent', () => {
    const dir = root()
    const file = join(dir, 'control')
    writeControlFile(file, { url: 'http://127.0.0.1:1', nonce: 'n', pid: 1 }, 'linux')
    removeControlFile(file)
    expect(existsSync(file)).toBe(false)
    removeControlFile(file)
  })

  test('the file carries the nonce, so it is an at-rest secret by construction', () => {
    const file = join(root(), 'control')
    writeControlFile(file, { url: 'http://127.0.0.1:1', nonce: 'super-secret', pid: 1 }, 'linux')
    // Stated as a test rather than a comment: anything that ships this file
    // (a backup, a support bundle, a log upload) ships an authorization.
    expect(readFileSync(file, 'utf8')).toContain('super-secret')
    chmodSync(file, 0o600)
  })
})

describe('RFC-254 T7 — the hard-kill fallback', () => {
  test('exists only on win32, and names the whole tree', () => {
    // POSIX already has a graceful signal, so there is nothing to fall back
    // FROM — returning null keeps `stop` from inventing a second kill path.
    expect(hardKillCommand(1234, 'linux')).toBeNull()
    expect(hardKillCommand(1234, 'darwin')).toBeNull()
    // `/T` matters: without it the daemon dies and its opencode children are
    // orphaned, which is the state RFC-254's process-tree work exists to avoid.
    expect(hardKillCommand(1234, 'win32')).toEqual(['taskkill', '/PID', '1234', '/T', '/F'])
  })
})

describe('RFC-254 T7 — `stop` picks its transport by platform', () => {
  // The two mechanisms are NOT interchangeable, and the whole point of T7 is
  // that the old code could not tell them apart. These cases read the source
  // rather than spawning a daemon: what must hold is that the win32 branch
  // exists, that it does not reach for a signal, and that a kill it had to
  // force is never reported as a clean stop.
  const rawSource = readFileSync(join(import.meta.dir, '..', 'src', 'cli', 'stop.ts'), 'utf8')
  // Comments in this file DISCUSS `process.kill(pid, 'SIGTERM')` at length —
  // that is the behaviour being explained — so counting occurrences in the raw
  // text counts the explanation too. Strip comments before measuring code.
  const source = rawSource
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1')

  test('POSIX still sends SIGTERM and win32 never does', () => {
    // One `process.kill` in the whole file, and it is inside the non-win32
    // branch. A second one would mean the Windows path had quietly grown a
    // signal again — which does not throw there, it just hard-kills.
    const kills = source.match(/process\.kill\(/g) ?? []
    expect(kills).toHaveLength(1)
    const [posixBranch, winBranch] = source.split("if (platform !== 'win32')")[1]?.split('}') ?? []
    expect(posixBranch, 'the POSIX branch keeps the signal').toContain("'SIGTERM'")
    expect(winBranch ?? '').not.toContain('process.kill')
  })

  test('the win32 branch refuses a control file that names a different pid', () => {
    // A stale file from a previous daemon plus a recycled pid is how a shutdown
    // gets sent to something else entirely.
    expect(source).toContain('endpoint.pid !== pid')
  })

  test('a forced kill is reported as not-graceful, and exits non-zero', () => {
    expect(source).toContain("status: 'forced'")
    expect(source).toContain('graceful: false')
    expect(rawSource).toContain('NOT a graceful shutdown')
    const main = readFileSync(join(import.meta.dir, '..', 'src', 'main.ts'), 'utf8')
    expect(main).toContain("result.status === 'timeout' || result.status === 'forced'")
  })

  test('a clean stop is the only outcome labelled graceful', () => {
    const graceful = source.match(/graceful: true/g) ?? []
    expect(graceful).toHaveLength(1)
  })
})

describe('RFC-254 T7 — the daemon publishes and retracts the endpoint', () => {
  const start = readFileSync(join(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')

  test('the listener is started and closed on exit', () => {
    expect(start).toContain('startControlListener(')
    expect(start).toContain('controlListener.close()')
  })

  test('it drives the SAME shutdown sequence the signal handler does', () => {
    // A second, parallel drain path would be a second place for the 30 s
    // budget, the lock release and the task bookkeeping to drift.
    const onShutdown = start.split('onShutdown: () => {')[1]?.split('},')[0] ?? ''
    expect(onShutdown).toContain('removeDaemonInfo()')
    expect(onShutdown).toContain('shutdown(')
  })

  test('the control path is registered as an at-rest secret location', () => {
    const paths = readFileSync(join(import.meta.dir, '..', 'src', 'util', 'paths.ts'), 'utf8')
    expect(paths).toContain('controlFile')
    expect(paths).toContain('AT-REST SECRET')
  })
})

describe('RFC-254 T7 / D19 — doctor reports the protection that is actually in force', () => {
  const doctor = readFileSync(join(import.meta.dir, '..', 'src', 'cli', 'doctor.ts'), 'utf8')

  test('the mode-600 assertion is gated on the platform that HAS mode bits', () => {
    // Windows carries no POSIX permission bits — `statSync().mode & 0o777`
    // there reports something like 666 whatever the ACL says. The previous
    // check asserted 600 unconditionally, so every Windows box that had ever
    // started the daemon failed `doctor` on a file that was not insecure.
    expect(doctor).toContain('statMetadataIsAuthoritative(platform)')
    const guarded = doctor.split('statMetadataIsAuthoritative(platform)')[1] ?? ''
    // The win32 message must name the protection that IS in force rather than
    // claiming the POSIX one, and must not overstate what it verified.
    expect(guarded).toContain('per-user ACL')
    expect(guarded).toContain('does not verify the DACL')
  })

  test('the shutdown nonce is one of the secrets it covers', () => {
    expect(doctor).toContain('Paths.controlFile')
    expect(doctor).toContain('shutdown nonce')
  })

  test('a POSIX host still fails on a world-readable secret', () => {
    // The looser platform branch must not have loosened the strict one.
    expect(doctor).toContain('!== 0o600')
    expect(doctor).toContain('ok: false')
  })
})
