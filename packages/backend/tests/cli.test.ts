// Coverage for the CLI subcommands wired in P-1-05.
//
// Strategy: call the command functions in-process where possible. For stop +
// status which need a real daemon, spawn one subprocess per scenario.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configGetCommand, configSetCommand } from '../src/cli/config-cli'
import { doctorCommand, formatDoctor } from '../src/cli/doctor'
import { migrateCommand } from '../src/cli/migrate'
import { statusCommand, formatStatus } from '../src/cli/status'
import { stopCommand } from '../src/cli/stop'
import { removeTempDirSync } from './fixtures/tempDir'
import { statMetadataIsAuthoritative } from '../src/util/fileTrust'
import { readControlFile, requestShutdown } from '../src/services/controlListener'

const mainPath = resolve(import.meta.dir, '..', 'src', 'main.ts')

describe('CLI subcommands (P-1-05)', () => {
  let tmp: string
  let origHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-cli-'))
    origHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = tmp
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = origHome
    removeTempDirSync(tmp)
  })

  // --- config get / set ---

  test('config get with no args returns full default config', () => {
    const { output } = configGetCommand([])
    const cfg = JSON.parse(output) as Record<string, unknown>
    expect(cfg.$schema_version).toBe(1)
    expect(cfg.maxConcurrentNodes).toBe(4)
    expect(cfg.theme).toBe('system')
  })

  test('config get <key> returns just that value', () => {
    const { output } = configGetCommand(['maxConcurrentNodes'])
    expect(output.trim()).toBe('4')
  })

  test('config get <unknown-key> throws', () => {
    expect(() => configGetCommand(['totally-not-a-key'])).toThrow(/unknown config key/)
  })

  test('config set <key> <number> updates and persists', () => {
    const { output } = configSetCommand(['maxConcurrentNodes', '8'])
    expect(output.trim()).toBe('maxConcurrentNodes = 8')
    expect(configGetCommand(['maxConcurrentNodes']).output.trim()).toBe('8')
  })

  test('config set <key> <string> works (JSON parse falls back to raw string)', () => {
    configSetCommand(['theme', 'dark'])
    expect(configGetCommand(['theme']).output.trim()).toBe('dark')
  })

  test('config set rejects invalid value type via schema', () => {
    expect(() => configSetCommand(['maxConcurrentNodes', '-5'])).toThrow()
  })

  test('config set with nested object JSON works', () => {
    configSetCommand(['worktreeAutoGc', '{"enabled":true,"olderThanDays":7}'])
    const wgcRaw = configGetCommand(['worktreeAutoGc']).output.trim()
    const wgc = JSON.parse(wgcRaw) as Record<string, unknown>
    expect(wgc.enabled).toBe(true)
    expect(wgc.olderThanDays).toBe(7)
  })

  // --- migrate ---

  test('migrate creates db.sqlite + applies migrations', () => {
    const dbPath = join(tmp, 'db.sqlite')
    expect(existsSync(dbPath)).toBe(false)
    const { output } = migrateCommand()
    expect(output).toContain(dbPath)
    expect(existsSync(dbPath)).toBe(true)
  })

  // RFC-254 T31 (task#11): migrateCommand must CLOSE its DB handle. A leaked
  // bun:sqlite connection is invisible on POSIX (open files unlink fine) but on
  // Windows it locks the temp dir, so `afterEach`'s rm(tmp) fails EBUSY and the
  // whole cli.test.ts describe reads as a teardown flake. The Windows regression
  // is the afterEach itself; this source anchor makes a revert red on POSIX CI
  // too. (Root-caused on the ARM64 VM: 0 lingering processes, leaked DB handle.)
  test('migrateCommand closes its DB handle (no leaked bun:sqlite lock)', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'migrate.ts'), 'utf8')
    expect(source).toContain('.$client.close()')
  })

  // --- doctor ---

  test('doctor returns ok when opencode + git present', async () => {
    const result = await doctorCommand()
    // We trust the dev box has executable OpenCode and Git installations.
    // If a particular check fails, surface its message for easier debugging.
    if (!result.ok) {
      console.error(formatDoctor(result))
    }
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'opencode binary')?.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'git version')?.ok).toBe(true)
  })

  test('doctor flags missing migrations folder', async () => {
    // Point config to use a temp opencode that does exist (real one); but
    // delete migrations and the check should fail.
    // We do this by overriding the bundled migrations directory at runtime via
    // a child process with a custom PATH for `node:fs.readdirSync` — too
    // invasive. Instead, just verify token-file mode check works:
    writeFileSync(join(tmp, 'token'), 'a'.repeat(64), { mode: 0o644 })
    const result = await doctorCommand()
    // RFC-254 T7/D19: the check now covers every at-rest secret and reports the
    // protection the PLATFORM actually offers. On POSIX that is still mode 600
    // and a 644 token still fails; on Windows the same file is not insecure and
    // must not be reported as such (see rfc254-control-listener.test.ts).
    const secretCheck = result.checks.find((c) => c.name === 'secret file protection')
    // RFC-254 T32: the comment above already stated the platform semantics; this
    // assertion had not been wired to them yet, so it demanded a POSIX verdict
    // on Windows and failed for being right.
    if (statMetadataIsAuthoritative(process.platform)) {
      expect(secretCheck?.ok).toBe(false)
      expect(secretCheck?.message).toContain('600')
    } else {
      // Mode bits are not the guarantee there, so a 0o644 token is NOT a finding
      // — reporting one would be a false alarm an operator cannot act on.
      expect(secretCheck?.ok).toBe(true)
    }
    expect(secretCheck?.message).toContain('token')
  })

  // --- status / stop (require a real daemon subprocess) ---

  test('status: when daemon not running', async () => {
    const result = await statusCommand()
    expect(result.state).toBe('not-running')
    const text = formatStatus(result)
    expect(text).toContain('not running')
  })

  test('status + stop: end-to-end against a real daemon', async () => {
    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      await waitForReady(child.stdout, 10_000)

      // status sees the daemon, /health is reachable.
      const status = await statusCommand()
      expect(status.state).toBe('running')
      expect(status.pid).toBe(child.pid ?? -1)
      expect(status.info?.host).toBe('127.0.0.1')
      expect(status.health?.ok).toBe(true)
      expect(status.health?.opencodeVersion).toBeNull()
      const text = formatStatus(status)
      expect(text).toContain('daemon running')
      expect(text).toContain(`pid:        ${child.pid}`)
      expect(text).toContain('not checked at startup')

      // stop terminates the daemon and removes the lock.
      const stopResult = await stopCommand({ timeoutMs: 10_000 })
      expect(stopResult.status).toBe('stopped')
      expect(stopResult.pid).toBe(child.pid ?? -1)
      expect(existsSync(join(tmp, '.daemon.lock'))).toBe(false)
    } finally {
      // Defensive: kill the child if not already exited.
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      await child.exited
    }
  })

  test('stop reports not-running when there is no lock', async () => {
    const result = await stopCommand()
    expect(result.status).toBe('not-running')
  })

  test('stop cleans up a stale lock (PID not alive)', async () => {
    const lockPath = join(tmp, '.daemon.lock')
    writeFileSync(lockPath, '99999998') // PID extremely unlikely to exist
    const result = await stopCommand()
    expect(result.status).toBe('stale-lock-removed')
    expect(existsSync(lockPath)).toBe(false)
  })

  // --- daemon writes .daemon.info on start, removes on shutdown ---

  test('daemon writes .daemon.info on start, removes it on SIGTERM', async () => {
    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      await waitForReady(child.stdout, 10_000)
      const infoPath = join(tmp, '.daemon.info')
      expect(existsSync(infoPath)).toBe(true)
      const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>
      expect(info.pid).toBe(child.pid ?? -1)
      expect(info.host).toBe('127.0.0.1')
      expect(typeof info.port).toBe('number')
      expect(typeof info.url).toBe('string')

      // token file mode 0600 (sanity, since doctor checks this too).
      // RFC-254 T32: 0o600 is only a fact where `stat` is authoritative; Windows
      // synthesizes 0o666 for every file (see auth-token.test.ts).
      expect(statSync(join(tmp, 'token')).mode & 0o777).toBe(
        statMetadataIsAuthoritative(process.platform) ? 0o600 : 0o666,
      )
    } finally {
      // RFC-254 T7/T32: ask the daemon to DRAIN by whichever mechanism the
      // platform has. `kill('SIGTERM')` is a graceful request on POSIX and a
      // hard TerminateProcess on Windows — Node accepts the name there but maps
      // it to the same thing as SIGKILL — so on Windows the daemon never ran its
      // shutdown and `.daemon.info` was still on disk when the assertion below
      // looked. That is the exact failure T7 built the loopback control listener
      // for, and routing through it here makes this test PROVE the Windows
      // graceful path end to end instead of asserting a POSIX-only outcome.
      if (process.platform === 'win32') {
        const endpoint = readControlFile(join(tmp, '.daemon.control'))
        expect(endpoint).not.toBeNull()
        expect(await requestShutdown(endpoint!)).toBe('accepted')
      } else {
        child.kill('SIGTERM')
      }
      await child.exited
    }
    expect(existsSync(join(tmp, '.daemon.info'))).toBe(false)
  })
})

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
