import { rimrafDir } from './helpers/cleanup'
// RFC-135 — GET /api/runtimes/status (homepage multi-runtime status line).
//
// Locks the contract that replaced the legacy single-runtime probe
// (GET /api/runtime/opencode) the homepage hero used to hardcode:
//   1. every ENABLED registry runtime is probed live against the binary a real
//      dispatch would use (row binaryPath > protocol default from config);
//   2. availability is VERSION-GATE FREE (user decision 2026-07-02: a custom
//      binary's version scheme is not comparable to the official minimum —
//      `--version` exiting 0 is the whole test, and an unparseable version
//      string still reads ok). The response deliberately has NO
//      compatible/minVersion keys;
//   3. the endpoint sits behind `runtime:read` like the legacy /api/runtime/*
//      gate (it spawns registered binaries — a narrowed PAT must not reach it);
//   4. a hung binary is SIGKILLed after the per-row timeout and reads as a
//      failed probe without stalling the whole response (RFC-135 D5).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { isWindows, isProcessRunningByCmd } from './helpers/stub-runtime'

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

/** Minimal `--version`-only stub; non-version args exit 99. Returns the executable path. */
function writeVersionBinary(path: string, stdout: string, exit = 0): string {
  if (isWindows) {
    // Write a .js stub and a .cmd wrapper; return the .cmd path.
    const jsPath = path + '.js'
    const js = `// Auto-generated version stub for Windows test compatibility
const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(${JSON.stringify(stdout + '\\n')})
  process.exit(${exit})
}
process.stderr.write('unknown: ' + args.join(' ') + '\\n')
process.exit(99)
`
    writeFileSync(jsPath, js)
    const cmdPath = path + '.cmd'
    writeFileSync(cmdPath, `@echo off\nbun run "${jsPath}" %*\n`)
    return cmdPath
  }

  const escaped = stdout.replace(/'/g, `'\\''`)
  writeFileSync(
    path,
    `#!/bin/sh
case "$1" in
  --version|-v) printf '%s\\n' '${escaped}'; exit ${exit} ;;
  *) echo "unknown: $*" >&2; exit 99 ;;
esac
`,
  )
  chmodSync(path, 0o755)
  return path
}

/**
 * Stub that hangs on --version — for the timeout/SIGKILL case. The sh script
 * FORKS the sleep (no exec), so the hang lives in a grandchild: killing only
 * the direct child would leave it running and holding the stdout pipe. The
 * odd duration doubles as a unique pgrep marker for the reap assertion.
 *
 * On Windows, the .js stub uses setInterval to hang; the marker is a unique
 * string in the script for process detection via wmic.
 * Returns the executable path.
 */
const HANG_MARKER = isWindows ? 'aw-hang-marker-63047' : 'sleep 63047'
function writeHangingBinary(path: string): string {
  if (isWindows) {
    const jsPath = path + '.js'
    writeFileSync(jsPath, `// ${HANG_MARKER}\nsetInterval(() => {}, 60000)\n`)
    const cmdPath = path + '.cmd'
    writeFileSync(cmdPath, `@echo off\nbun run "${jsPath}" %*\n`)
    return cmdPath
  }
  writeFileSync(path, `#!/bin/sh\n${HANG_MARKER}\n`)
  chmodSync(path, 0o755)
  return path
}

async function makeHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc135-'))
  const configPath = join(tmp, 'config.json')
  loadConfig(configPath) // write defaults
  const opencodeBinBase = join(tmp, 'opencode-stub')
  const claudeBinBase = join(tmp, 'claude-stub')
  const opencodeBin = writeVersionBinary(opencodeBinBase, 'stub-opencode 1.14.25')
  const claudeBin = writeVersionBinary(claudeBinBase, '2.1.193 (Claude Code)')
  // Pin BOTH protocol defaults to controlled stubs — the machine running the
  // tests may or may not have real opencode/claude on PATH.
  applyConfigPatch(configPath, { opencodePath: opencodeBin, claudeCodePath: claudeBin })
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  const app = createApp({ token: TOKEN, configPath, opencodeVersion: null, dbVersion: 1, db })
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
  isDefault: boolean
}

async function bodyOf(res: Response): Promise<{ runtimes: StatusEntry[] }> {
  return (await res.json()) as { runtimes: StatusEntry[] }
}

describe('RFC-135 GET /api/runtimes/status', () => {
  let h: Harness

  beforeEach(async () => {
    delete process.env[TIMEOUT_ENV]
    h = await makeHarness()
  })

  afterEach(() => {
    delete process.env[TIMEOUT_ENV]
    rimrafDir(h.tmp)
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
    expect(oc!.version).toBe('1.14.25')
    expect(oc!.binary).toBe(h.opencodeBin)
    expect(oc!.isDefault).toBe(true)
    expect(cc!.ok).toBe(true)
    expect(cc!.version).toBe('2.1.193')
    expect(cc!.binary).toBe(h.claudeBin)
    expect(cc!.isDefault).toBe(false)

    // D3 decision lock: the version gate must not leak back into the contract.
    for (const row of json.runtimes) {
      expect('compatible' in row).toBe(false)
      expect('minVersion' in row).toBe(false)
    }
  })

  test('disabled runtime is excluded (enabled filter)', async () => {
    await setRuntimeEnabled(h.db, 'claude-code', false, 'opencode')
    const json = await bodyOf(await req(h.app))
    expect(json.runtimes.map((r) => r.name)).toEqual(['opencode'])
  })

  test('custom fork row probes ITS binaryPath, not the protocol default', async () => {
    const forkBinBase = join(h.tmp, 'my-fork')
    const forkBin = writeVersionBinary(forkBinBase, 'myfork 9.9.9')
    await createRuntime(h.db, { name: 'my-fork', protocol: 'opencode', binaryPath: forkBin })
    const json = await bodyOf(await req(h.app))
    const fork = json.runtimes.find((r) => r.name === 'my-fork')
    expect(fork).toBeDefined()
    expect(fork!.binary).toBe(forkBin)
    expect(fork!.ok).toBe(true)
    expect(fork!.version).toBe('9.9.9')
    expect(fork!.isDefault).toBe(false)
  })

  test('unparseable version string still reads ok (version-gate-free core)', async () => {
    // The user-reported case: a custom binary whose --version output has no
    // X.Y.Z shape. It RUNS, so it must read available — version is display-only.
    const weirdBinBase = join(h.tmp, 'weird-fork')
    const weirdBin = writeVersionBinary(weirdBinBase, 'fork build fortytwo')
    await createRuntime(h.db, { name: 'weird-fork', protocol: 'opencode', binaryPath: weirdBin })
    const json = await bodyOf(await req(h.app))
    const weird = json.runtimes.find((r) => r.name === 'weird-fork')
    expect(weird!.ok).toBe(true)
    expect(weird!.version).toBeNull()
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
    })
    const denied = await req(h.app, patToken)
    expect(denied.status).toBe(403)
    const deniedBody = (await denied.json()) as { details?: Record<string, unknown> }
    expect(deniedBody.details?.requiredPermission).toBe('runtime:read')
  })

  test('hung binary is timed out per-row without stalling the batch', async () => {
    // 2s: far below the 60s hang (the thing being tested) but generous enough
    // that the parallel healthy stubs never trip it on a loaded CI machine
    // (300ms proved flaky — spawn jitter SIGKILLed the healthy row too).
    process.env[TIMEOUT_ENV] = '2000'
    const hangBinBase = join(h.tmp, 'hangs')
    const hangBin = writeHangingBinary(hangBinBase)
    await createRuntime(h.db, { name: 'hangs', protocol: 'opencode', binaryPath: hangBin })

    const started = performance.now()
    const res = await req(h.app)
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
    expect(isProcessRunningByCmd(HANG_MARKER)).toBe(false)
  })

  test('wrapper that forks then exits BEFORE the timeout still gets its descendants reaped', async () => {
    // Codex impl gate round 2: exiting non-zero clears the timer, so the
    // timeout path never fires — the finally-side unconditional group reap is
    // what prevents this from leaking one forked child per homepage poll.
    const marker = isWindows ? 'aw-fork-marker-63053' : 'sleep 63053'
    const binBase = join(h.tmp, 'forks-and-dies')
    let bin: string
    if (isWindows) {
      // On Windows, spawn a long-lived child process then exit the parent.
      // The child is a separate bun process running an infinite loop.
      const childScript = join(h.tmp, 'fork-child.js')
      writeFileSync(childScript, `// ${marker}\nsetInterval(() => {}, 60000)\n`)
      const jsPath = binBase + '.js'
      writeFileSync(
        jsPath,
        `// fork-and-die stub\nimport { spawn } from 'node:child_process'\nconst child = spawn('bun', ['run', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' })\nchild.unref()\nprocess.exit(7)\n`,
      )
      const cmdPath = binBase + '.cmd'
      writeFileSync(cmdPath, `@echo off\nbun run "${jsPath}" %*\n`)
      bin = cmdPath
    } else {
      bin = binBase
      writeFileSync(bin, `#!/bin/sh\n${marker} &\nexit 7\n`)
      chmodSync(bin, 0o755)
    }
    await createRuntime(h.db, { name: 'forks-and-dies', protocol: 'opencode', binaryPath: bin })

    const res = await req(h.app)
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).runtimes.find((r) => r.name === 'forks-and-dies')!.ok).toBe(false)

    expect(isProcessRunningByCmd(marker)).toBe(false)
  })
})
