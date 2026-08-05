// RFC-135 — GET /api/runtimes/status (homepage multi-runtime status line).
//
// Locks the contract that replaced the legacy single-runtime probe
// (GET /api/runtime/opencode) the homepage hero used to hardcode:
//   1. every ENABLED registry runtime is probed live against the binary a real
//      dispatch would use (row binaryPath > protocol default from config);
//   2. RFC-227 makes OpenCode reported versions telemetry-only: an exit-0
//      lightweight probe is available-unverified regardless of semver text.
//      Protocol compatibility belongs to Runtime Test / actual execution. The
//      response deliberately has NO compatible/minVersion keys;
//   3. the endpoint sits behind `runtime:read` like the legacy /api/runtime/*
//      gate (it spawns registered binaries — a narrowed PAT must not reach it);
//   4. a hung binary is SIGKILLed after the per-row timeout and reads as a
//      failed probe without stalling the whole response (RFC-135 D5).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fakeBinaryPath, writeFakeBinary } from './fixtures/fakeBinary'
import { NO_POSIX_CONTAINMENT } from './fixtures/platformScope'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { RuntimesStatusResponseSchema } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { applyConfigPatch, loadConfig } from '../src/config'
import {
  createRuntime,
  seedBuiltinRuntimes,
  setRuntimeEnabled,
} from '../src/services/runtimeRegistry'
import { createSession } from '../src/auth/sessionStore'
import { createPat } from '../src/auth/patStore'
import { createUser } from '../src/services/users'
import { FIXTURE_RUNTIME_DIAGNOSTICS } from './helpers/runtimeOpencodeFixture'
import {
  ContainmentCoordinator,
  ContainmentProviderQualificationError,
} from '../src/services/sandbox'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TIMEOUT_ENV = 'AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS'

interface Harness {
  app: Hono
  db: DbClient
  tmp: string
  configPath: string
  opencodeBin: string
  claudeBin: string
}

// RFC-254 T32/T39/T40a: a version stub via the shared cross-platform fake
// binary rather than `#!/bin/sh` (unrunnable on Windows). Returns the ACTUAL
// path written (`.cmd` on win32) — the row assertions compare `runtime.binary`
// against it, and T39 preserves that extension across the byte-frozen snapshot
// while T40a lets the snapshot's identity re-check pass on win32.
function writeVersionBinary(dir: string, base: string, stdout: string): string {
  const path = fakeBinaryPath(dir, base)
  writeFakeBinary(path, {
    stdout: `${stdout}
`,
  })
  return path
}

/**
 * Stub that hangs on --version — for the timeout/SIGKILL case. The sh script
 * FORKS the sleep (no exec), so the hang lives in a grandchild: killing only
 * the direct child would leave it running and holding the stdout pipe. The
 * odd duration doubles as a unique pgrep marker for the reap assertion.
 */
function writeHangingBinary(path: string, marker: string): void {
  writeFileSync(path, `#!/bin/sh\n${marker}\n`)
  chmodSync(path, 0o755)
}

async function makeHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc135-'))
  const configPath = join(tmp, 'config.json')
  loadConfig(configPath) // write defaults
  const opencodeBin = writeVersionBinary(tmp, 'opencode-stub', 'stub-opencode 1.18.3')
  const claudeBin = writeVersionBinary(tmp, 'claude-stub', '2.1.193 (Claude Code)')
  // Pin BOTH protocol defaults to controlled stubs — the machine running the
  // tests may or may not have real opencode/claude on PATH.
  applyConfigPatch(configPath, { opencodePath: opencodeBin, claudeCodePath: claudeBin })
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  const app = createApp({
    token: TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
    runtimeDiagnosticTestDependencies: FIXTURE_RUNTIME_DIAGNOSTICS,
  })
  return { app, db, tmp, configPath, opencodeBin, claudeBin }
}

async function req(app: Hono, token: string = TOKEN): Promise<Response> {
  return app.request('/api/runtimes/status', {
    headers: { Authorization: `Bearer ${token}` },
  })
}

interface StatusEntry {
  name: string
  protocol: string
  binary: string
  ok: boolean
  version: string | null
  state?: string
  reportedVersion?: string | null
  isDefault: boolean
  failureCode?: string
  containment?: {
    providerId: string | null
    mode: 'enforce' | 'warn' | 'off'
    capabilities: Record<string, string>
    degradedReasons: string[]
  }
}

async function bodyOf(res: Response): Promise<{
  runtimes: StatusEntry[]
  sandbox?: {
    configuredMode?: string
    effectiveMode?: string
    restartRequired?: boolean
    profileId?: string
    probeState?: string
    reasonCodes?: string[]
  }
}> {
  return (await res.json()) as {
    runtimes: StatusEntry[]
    sandbox?: {
      configuredMode?: string
      effectiveMode?: string
      restartRequired?: boolean
      profileId?: string
      probeState?: string
      reasonCodes?: string[]
    }
  }
}

describe('RFC-135 GET /api/runtimes/status', () => {
  let h: Harness

  beforeEach(async () => {
    delete process.env[TIMEOUT_ENV]
    h = await makeHarness()
  })

  afterEach(() => {
    delete process.env[TIMEOUT_ENV]
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('default registry → both builtins probed, opencode isDefault, schema-clean', async () => {
    const res = await req(h.app)
    expect(res.status).toBe(200)
    const json = await bodyOf(res)
    expect(RuntimesStatusResponseSchema.safeParse(json).success).toBe(true)
    expect(json.runtimes.length).toBe(2)

    const oc = json.runtimes.find((r) => r.name === 'opencode')
    const cc = json.runtimes.find((r) => r.name === 'claude-code')
    expect(oc).toBeDefined()
    expect(cc).toBeDefined()
    expect(oc!.ok).toBe(true)
    expect(oc!.version).toBe('1.18.3')
    expect(oc!.reportedVersion).toBe('1.18.3')
    expect(oc!.state).toBe('available-unverified')
    expect(oc!.binary).toBe(h.opencodeBin)
    expect(oc!.isDefault).toBe(true)
    expect(cc!.ok).toBe(true)
    expect(cc!.version).toBe('2.1.193')
    expect(cc!.binary).toBe(h.claudeBin)
    expect(cc!.isDefault).toBe(false)

    // Compatibility affects `ok` without leaking driver internals into the wire.
    for (const row of json.runtimes) {
      expect('compatible' in row).toBe(false)
      expect('minVersion' in row).toBe(false)
    }
  })

  test('snapshot admission failure preserves the stable code and redacts arbitrary wire text', async () => {
    const raw = 'RAW_BACKEND_SECRET /private/sealed/opencode'
    const guardedApp = createApp({
      token: TOKEN,
      configPath: h.configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db: h.db,
      runtimeDiagnosticTestDependencies: {
        ...FIXTURE_RUNTIME_DIAGNOSTICS,
        withRuntimeOpencodeSnapshot: async <T>(
          _command: readonly string[],
          _callback: (snapshotPath: string) => Promise<T>,
        ): Promise<T> => {
          throw Object.assign(new Error(raw), {
            code: 'execution-identity-source-changed' as const,
          })
        },
      },
    })

    const res = await req(guardedApp)
    expect(res.status).toBe(200)
    const json = await bodyOf(res)
    expect(RuntimesStatusResponseSchema.safeParse(json).success).toBe(true)
    expect(json.runtimes.find((runtime) => runtime.name === 'opencode')).toMatchObject({
      ok: false,
      failureCode: 'execution-identity-source-changed',
    })
    expect(JSON.stringify(json)).not.toContain(raw)
  })

  test('disabled runtime is excluded (enabled filter)', async () => {
    await setRuntimeEnabled(h.db, 'claude-code', false, 'opencode')
    const json = await bodyOf(await req(h.app))
    expect(json.runtimes.map((r) => r.name)).toEqual(['opencode'])
  })

  test('fixture-admitted row probes ITS binaryPath, not the protocol default', async () => {
    const forkBin = writeVersionBinary(h.tmp, 'my-fork', 'myfork 9.9.9')
    await createRuntime(h.db, { name: 'my-fork', protocol: 'opencode', binaryPath: forkBin })
    const json = await bodyOf(await req(h.app))
    const fork = json.runtimes.find((r) => r.name === 'my-fork')
    expect(fork).toBeDefined()
    expect(fork!.binary).toBe(forkBin)
    expect(fork!.ok).toBe(true)
    expect(fork!.version).toBe('9.9.9')
    expect(fork!.isDefault).toBe(false)
  })

  test('older reported version remains available-unverified', async () => {
    const oldBin = writeVersionBinary(h.tmp, 'old-opencode', 'stub-opencode 1.17.9')
    await createRuntime(h.db, { name: 'old-opencode', protocol: 'opencode', binaryPath: oldBin })
    const json = await bodyOf(await req(h.app))
    const old = json.runtimes.find((r) => r.name === 'old-opencode')
    expect(old!.ok).toBe(true)
    expect(old!.version).toBe('1.17.9')
    expect(old!.state).toBe('available-unverified')
  })

  test('non-semver reported version remains available-unverified', async () => {
    const weirdBin = writeVersionBinary(h.tmp, 'weird-fork', 'fork build fortytwo')
    await createRuntime(h.db, { name: 'weird-fork', protocol: 'opencode', binaryPath: weirdBin })
    const json = await bodyOf(await req(h.app))
    const weird = json.runtimes.find((r) => r.name === 'weird-fork')
    expect(weird!.ok).toBe(true)
    expect(weird!.version).toBeNull()
    expect(weird!.state).toBe('available-unverified')
  })

  test('warn reports degraded but executable; enforce reports containment-blocked', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: {
        mode: 'warn',
        status: {
          mechanism: 'bwrap',
          available: false,
          detail: 'fixture unavailable',
        },
        appHome: h.tmp,
      },
      qualifyBwrap: async () => {
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
    })
    const statusApp = createApp({
      token: TOKEN,
      configPath: h.configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db: h.db,
      runtimeDiagnosticTestDependencies: FIXTURE_RUNTIME_DIAGNOSTICS,
      containmentCoordinator: coordinator,
    })
    const warnedBody = await bodyOf(await req(statusApp))
    const warned = warnedBody.runtimes.find((runtime) => runtime.name === 'opencode')!
    expect(warned).toMatchObject({
      ok: true,
      state: 'degraded',
      containment: {
        providerId: 'linux-bwrap',
        mode: 'warn',
      },
    })
    expect(warned.containment?.degradedReasons).toContain('provider-trial-rejected')
    expect(warnedBody.sandbox).toMatchObject({
      configuredMode: 'warn',
      effectiveMode: 'warn',
      restartRequired: false,
      profileId: 'model-child-netless-v1',
      probeState: 'unavailable',
      reasonCodes: ['provider-trial-rejected', 'required-capability-missing'],
    })

    coordinator.setMode('enforce')
    const mismatched = await bodyOf(await req(statusApp))
    expect(mismatched.runtimes.find((runtime) => runtime.name === 'opencode')).toMatchObject({
      ok: false,
      state: 'containment-blocked',
    })
    expect(mismatched.sandbox).toMatchObject({
      configuredMode: 'warn',
      effectiveMode: 'enforce',
      restartRequired: true,
    })
  })

  test('macOS Seatbelt is admitted and reports lifetime strength honestly', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'seatbelt', available: true, detail: null },
        appHome: h.tmp,
      },
      qualifySeatbelt: async () => {},
    })
    const statusApp = createApp({
      token: TOKEN,
      configPath: h.configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db: h.db,
      runtimeDiagnosticTestDependencies: FIXTURE_RUNTIME_DIAGNOSTICS,
      containmentCoordinator: coordinator,
    })
    const opencode = (await bodyOf(await req(statusApp))).runtimes.find(
      (runtime) => runtime.name === 'opencode',
    )!
    expect(opencode).toMatchObject({
      ok: true,
      state: 'available-unverified',
      containment: {
        providerId: 'macos-seatbelt',
        mode: 'enforce',
        capabilities: {
          platformHomeIsolation: 'strong',
          immutableArtifactView: 'strong',
          modelChildNetworkDeny: 'strong',
          descendantLifetimeBound: 'best-effort',
        },
      },
    })
  })

  test('missing binary → ok:false, version:null, endpoint still 200', async () => {
    await createRuntime(h.db, {
      name: 'gone',
      protocol: 'claude-code',
      binaryPath: join(h.tmp, 'does-not-exist'),
    })
    const res = await req(h.app)
    expect(res.status).toBe(200)
    const gone = (await bodyOf(res)).runtimes.find((r) => r.name === 'gone')
    expect(gone!.ok).toBe(false)
    expect(gone!.version).toBeNull()
    expect(gone!.state).toBe('not-found')
  })

  test('config.defaultRuntime drives isDefault', async () => {
    applyConfigPatch(h.configPath, { defaultRuntime: 'claude-code' })
    const json = await bodyOf(await req(h.app))
    expect(json.runtimes.find((r) => r.name === 'claude-code')!.isDefault).toBe(true)
    expect(json.runtimes.find((r) => r.name === 'opencode')!.isDefault).toBe(false)
  })

  test('stale/unknown configured default falls back to opencode for isDefault (impl gate F12)', async () => {
    // Real dispatch fail-safes an unknown default to the opencode builtin
    // (resolveRuntimeByName); the status line must mark the SAME row as
    // default, else a broken effective default renders soft instead of red.
    applyConfigPatch(h.configPath, { defaultRuntime: 'deleted-long-ago' })
    const json = await bodyOf(await req(h.app))
    expect(json.runtimes.find((r) => r.name === 'opencode')!.isDefault).toBe(true)
    expect(json.runtimes.filter((r) => r.isDefault).length).toBe(1)
  })

  test('auth: no token 401; regular user 200; narrowed PAT without runtime:read 403', async () => {
    const bare = await h.app.request('/api/runtimes/status')
    expect(bare.status).toBe(401)

    const bob = await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token: sessionToken } = await createSession({ db: h.db, userId: bob.id })
    expect((await req(h.app, sessionToken)).status).toBe(200)

    const { token: patToken } = await createPat({
      db: h.db,
      userId: bob.id,
      name: 'narrow',
      scopes: ['agents:read'],
      purpose: 'general',
    })
    const denied = await req(h.app, patToken)
    expect(denied.status).toBe(403)
    const deniedBody = (await denied.json()) as { details?: Record<string, unknown> }
    expect(deniedBody.details?.requiredPermission).toBe('runtime:read')
  })

  // RFC-254 T32: gated on the POSIX process-group reap SUBJECT (fork-without-exec
  // grandchild via `#!/bin/sh`, PGID signal, `pgrep -f`); win32's descendant-
  // lifetime boundary is the Job Object (rfc254-process-tree-ownership win32).
  test.skipIf(NO_POSIX_CONTAINMENT)(
    'hung binary is timed out per-row without stalling the batch',
    async () => {
      // 2s: far below the 60s hang (the thing being tested) but generous enough
      // that the parallel healthy stubs never trip it on a loaded CI machine
      // (300ms proved flaky — spawn jitter SIGKILLed the healthy row too).
      process.env[TIMEOUT_ENV] = '2000'
      const hangBin = join(h.tmp, 'hangs')
      // Include the test-process pid in the sleep operand so independently
      // isolated copies of this file never mistake one another's intentional
      // hang for a leaked descendant during pressure runs.
      const hangMarker = `sleep 63047.${process.pid}`
      writeHangingBinary(hangBin, hangMarker)
      await createRuntime(h.db, { name: 'hangs', protocol: 'opencode', binaryPath: hangBin })

      // Keep the row under test on the real snapshot + process-group path. The
      // healthy control uses Bun's already-admitted native executable: macOS
      // sandbox pressure can delay a freshly-copied temporary shell script past
      // this case's deliberately shortened 2s timeout, which tests host script
      // scheduling rather than per-row isolation. Production still snapshots
      // every row, and the other cases above lock that boundary.
      const timeoutApp = createApp({
        token: TOKEN,
        configPath: h.configPath,
        opencodeVersion: null,
        dbVersion: 1,
        db: h.db,
        runtimeDiagnosticTestDependencies: {
          ...FIXTURE_RUNTIME_DIAGNOSTICS,
          withRuntimeOpencodeSnapshot: (command, callback) =>
            command[0] === hangBin
              ? FIXTURE_RUNTIME_DIAGNOSTICS.withRuntimeOpencodeSnapshot(command, callback)
              : callback(process.execPath),
        },
      })

      const started = performance.now()
      const res = await req(timeoutApp)
      const elapsed = performance.now() - started
      expect(res.status).toBe(200)
      // sleep 60 would hold the response for a minute; the 2s row timeout +
      // SIGKILL must return well under that (generous CI margin).
      expect(elapsed).toBeLessThan(10_000)

      const json = await bodyOf(res)
      expect(json.runtimes.find((r) => r.name === 'hangs')!.ok).toBe(false)
      // The other rows in the same batch are unaffected.
      expect(json.runtimes.find((r) => r.name === 'opencode')!.ok).toBe(true)

      // Codex impl gate: the WHOLE process tree must be reaped, not just the
      // sh wrapper — the forked grandchild is the thing actually hanging. The
      // probe kills the detached process group, so no marker process survives.
      const survivors = Bun.spawnSync({ cmd: ['pgrep', '-f', hangMarker] })
      expect(survivors.stdout.toString().trim()).toBe('')
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'wrapper that forks then exits BEFORE the timeout still gets its descendants reaped',
    async () => {
      // Codex impl gate round 2: exiting non-zero clears the timer, so the
      // timeout path never fires — the finally-side unconditional group reap is
      // what prevents this from leaking one forked child per homepage poll.
      const marker = 'sleep 63053'
      const bin = join(h.tmp, 'forks-and-dies')
      writeFileSync(bin, `#!/bin/sh\n${marker} &\nexit 7\n`)
      chmodSync(bin, 0o755)
      await createRuntime(h.db, { name: 'forks-and-dies', protocol: 'opencode', binaryPath: bin })

      const res = await req(h.app)
      expect(res.status).toBe(200)
      expect((await bodyOf(res)).runtimes.find((r) => r.name === 'forks-and-dies')!.ok).toBe(false)

      const survivors = Bun.spawnSync({ cmd: ['pgrep', '-f', marker] })
      expect(survivors.stdout.toString().trim()).toBe('')
    },
  )
})
