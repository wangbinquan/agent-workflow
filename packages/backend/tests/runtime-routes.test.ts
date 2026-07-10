import { rimrafDir } from './helpers/cleanup'
// RFC-001 HTTP integration tests for /api/runtime/models (all namespaces).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { applyConfigPatch, loadConfig } from '../src/config'
import { clearOpencodeModelsCache } from '../src/util/opencode-models'
import { createRuntime, seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import { isWindows } from './helpers/stub-runtime'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  app: Hono
  db: DbClient
  tmp: string
  configPath: string
  binaryPath: string
}

function makeHarness(opts: { binary: string }): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-runtime-'))
  const configPath = join(tmp, 'config.json')
  loadConfig(configPath) // write defaults
  applyConfigPatch(configPath, { opencodePath: opts.binary })
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
  })
  return { app, db, tmp, configPath, binaryPath: opts.binary }
}

async function req(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

function writeBinary(
  path: string,
  body: {
    versionStdout?: string
    versionExit?: number
    modelsStdout?: string
    modelsExit?: number
    modelsStderr?: string
    recordArgs?: string
  },
): string {
  const {
    // 1.14.25 is a verified-working version at/above MIN_OPENCODE_VERSION —
    // there is no upper bound, see `packages/backend/src/util/opencode.ts`.
    versionStdout = 'stub-opencode 1.14.25',
    versionExit = 0,
    modelsStdout = '',
    modelsExit = 0,
    modelsStderr = '',
    recordArgs,
  } = body

  if (isWindows) {
    // Write a .js stub; resolveSpawnCmd / buildCommand will prefix with ['bun', 'run']
    // when the path ends in .js on Windows. Return the .js path.
    const jsPath = path + '.js'
    const lines: string[] = ['// Auto-generated binary stub for Windows test compatibility']
    if (recordArgs) {
      lines.push(
        `import { writeFileSync } from 'node:fs'`,
        `if (process.argv.length > 2) writeFileSync(${JSON.stringify(recordArgs)}, process.argv.slice(2).join(' ') + '\\n', { flag: 'a' })`,
      )
    }
    lines.push(
      `const args = process.argv.slice(2)`,
      `const sub = args[0] || ''`,
      `if (sub === '--version' || sub === '-v') {`,
      `  process.stdout.write(${JSON.stringify(versionStdout + '\\n')})`,
      `  process.exit(${versionExit})`,
      `}`,
      `if (sub === 'models') {`,
      `  process.stdout.write(${JSON.stringify(modelsStdout)})`,
    )
    if (modelsStderr) {
      lines.push(`  process.stderr.write(${JSON.stringify(modelsStderr)})`)
    }
    lines.push(
      `  process.exit(${modelsExit})`,
      `}`,
      `process.stderr.write('unknown subcommand: ' + args.join(' ') + '\\n')`,
      `process.exit(99)`,
    )
    writeFileSync(jsPath, lines.join('\n'))
    return jsPath
  }

  const versionStdoutEscaped = versionStdout.replace(/'/g, `'\\''`)
  const modelsStdoutEscaped = modelsStdout.replace(/'/g, `'\\''`)
  const modelsStderrEscaped = modelsStderr.replace(/'/g, `'\\''`)
  const record = recordArgs ? `echo "$@" >> '${recordArgs}'\n` : ''
  const script = `#!/bin/sh
${record}case "$1" in
  --version|-v)
    printf '%s\\n' '${versionStdoutEscaped}'
    exit ${versionExit}
    ;;
  models)
    printf '%s' '${modelsStdoutEscaped}'
    if [ -n '${modelsStderrEscaped}' ]; then printf '%s' '${modelsStderrEscaped}' >&2; fi
    exit ${modelsExit}
    ;;
  *)
    echo "unknown subcommand: $*" >&2
    exit 99
    ;;
esac
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

// NOTE (RFC-135): the legacy GET /api/runtime/opencode probe endpoint was
// removed with its last consumer (the homepage hero now reads
// /api/runtimes/status — see rfc135-runtimes-status.test.ts). Its probe
// semantics (missing binary, min-version gate for the daemon, no version
// ceiling) stay locked at the util layer in opencode-version.test.ts.

describe('GET /api/runtime/models', () => {
  let h: Harness

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-runtime-bin-'))
    const binBase = join(tmp, 'opencode')
    const bin = writeBinary(binBase, {
      modelsStdout: [
        'anthropic/claude-sonnet-4-6',
        '{',
        '  "name": "Claude Sonnet 4.6"',
        '}',
        'openai/gpt-5',
      ].join('\n'),
    })
    h = makeHarness({ binary: bin })
    clearOpencodeModelsCache()
  })

  afterEach(() => {
    rimrafDir(h.tmp)
  })

  test('first call returns parsed list with cached=false', async () => {
    const res = await req(h.app, '/api/runtime/models')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.cached).toBe(false)
    expect(json.binary).toBe(h.binaryPath)
    expect(json.models).toEqual([
      {
        id: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
      },
      { id: 'openai/gpt-5', provider: 'openai', modelID: 'gpt-5' },
    ])
  })

  test('second call hits cache', async () => {
    await req(h.app, '/api/runtime/models')
    const res = await req(h.app, '/api/runtime/models')
    const json = (await res.json()) as Record<string, unknown>
    expect(json.cached).toBe(true)
  })

  test('refresh=1 bypasses cache and forwards --refresh', async () => {
    const argsLog = join(h.tmp, 'args.log')
    const actualBin = writeBinary(h.binaryPath, {
      modelsStdout: 'anthropic/foo',
      recordArgs: argsLog,
    })
    // On Windows, writeBinary may return a .cmd wrapper path; update config.
    if (actualBin !== h.binaryPath) {
      applyConfigPatch(h.configPath, { opencodePath: actualBin })
      h.binaryPath = actualBin
    }
    await req(h.app, '/api/runtime/models')
    const res = await req(h.app, '/api/runtime/models?refresh=1')
    const json = (await res.json()) as Record<string, unknown>
    expect(json.cached).toBe(false)
    const args = await Bun.file(argsLog).text()
    expect(args).toContain('--refresh')
  })

  test('changing opencodePath invalidates cache', async () => {
    await req(h.app, '/api/runtime/models')
    const otherDir = mkdtempSync(join(tmpdir(), 'aw-runtime-other-'))
    const otherBinBase = join(otherDir, 'opencode')
    const otherBin = writeBinary(otherBinBase, { modelsStdout: 'openai/bar' })
    applyConfigPatch(h.configPath, { opencodePath: otherBin })
    const res = await req(h.app, '/api/runtime/models')
    const json = (await res.json()) as Record<string, unknown>
    expect(json.cached).toBe(false)
    expect(json.binary).toBe(otherBin)
    rimrafDir(otherDir)
  })

  test('returns 502 with error code on non-zero exit', async () => {
    const actualBin = writeBinary(h.binaryPath, { modelsExit: 3, modelsStderr: 'kaboom' })
    if (actualBin !== h.binaryPath) {
      applyConfigPatch(h.configPath, { opencodePath: actualBin })
      h.binaryPath = actualBin
    }
    const res = await req(h.app, '/api/runtime/models')
    expect(res.status).toBe(502)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.code).toBe('opencode-models-failed')
    expect(String(json.message)).toContain('kaboom')
  })
})

// RFC-111 — claude static model list. (The GET /api/runtime/claude probe was
// removed in RFC-135 along with its opencode sibling — see the note above.)
describe('GET /api/runtime/models?runtime=claude (RFC-111)', () => {
  let h: Harness
  let claudeBin: string
  beforeEach(() => {
    // opencode path is a non-empty placeholder (claude routes never invoke it).
    h = makeHarness({ binary: 'opencode' })
    const claudeBinBase = join(h.tmp, 'fake-claude')
    claudeBin = writeBinary(claudeBinBase, { versionStdout: '2.1.193 (Claude Code)' })
    applyConfigPatch(h.configPath, { claudeCodePath: claudeBin })
  })
  afterEach(() => rimrafDir(h.tmp))

  test('models?runtime=claude returns the curated static list (cached)', async () => {
    const res = await req(h.app, '/api/runtime/models?runtime=claude')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      models: Array<{ id: string; provider: string }>
      cached: boolean
    }
    expect(json.cached).toBe(true)
    expect(json.models.length).toBeGreaterThan(0)
    expect(json.models.some((m) => m.id === 'opus')).toBe(true)
    expect(json.models.every((m) => m.provider === 'anthropic')).toBe(true)
  })
})

// RFC-114 — /api/runtime/models?runtime=<name> resolves THAT runtime's binary.
describe('GET /api/runtime/models?runtime=<name> — runtime-aware binary (RFC-114)', () => {
  let h: Harness
  let customBin: string
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rt114-default-'))
    const defaultBinBase = join(dir, 'opencode')
    const defaultBin = writeBinary(defaultBinBase, { modelsStdout: 'default/d-model' })
    h = makeHarness({ binary: defaultBin })
    clearOpencodeModelsCache()
    await seedBuiltinRuntimes(h.db)
    const customBinBase = join(h.tmp, 'oc-fork')
    customBin = writeBinary(customBinBase, { modelsStdout: 'fork/special' })
    await createRuntime(h.db, { name: 'oc-fork', protocol: 'opencode', binaryPath: customBin })
  })
  afterEach(() => rimrafDir(h.tmp))

  test('?runtime=<custom opencode> lists the custom binary models, not the default (D1)', async () => {
    const res = await req(h.app, '/api/runtime/models?runtime=oc-fork')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.binary).toBe(customBin)
    expect(json.models).toEqual([{ id: 'fork/special', provider: 'fork', modelID: 'special' }])
  })

  test('no ?runtime= still uses the default opencodePath (backward-compat / P2-5)', async () => {
    const res = await req(h.app, '/api/runtime/models')
    const json = (await res.json()) as Record<string, unknown>
    expect(json.binary).toBe(h.binaryPath)
    expect(json.models).toEqual([
      { id: 'default/d-model', provider: 'default', modelID: 'd-model' },
    ])
  })

  test('P1-1: a runtime NAMED "claude" (opencode) is NOT hijacked into the static list', async () => {
    const claudeNamedBinBase = join(h.tmp, 'oc-claude')
    const claudeNamedBin = writeBinary(claudeNamedBinBase, { modelsStdout: 'fork/named-claude' })
    await createRuntime(h.db, { name: 'claude', protocol: 'opencode', binaryPath: claudeNamedBin })
    const res = await req(h.app, '/api/runtime/models?runtime=claude')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    // its own opencode binary + live list — NOT the static Anthropic list.
    expect(json.binary).toBe(claudeNamedBin)
    expect(json.models).toEqual([
      { id: 'fork/named-claude', provider: 'fork', modelID: 'named-claude' },
    ])
  })

  test('502 carries the runtime name + a redacted message (P2-4)', async () => {
    const failBinBase = join(h.tmp, 'oc-fail')
    const failBin = writeBinary(failBinBase, {
      modelsExit: 4,
      modelsStderr: 'clone https://u:supersecrettoken@github.com/x.git failed',
    })
    await createRuntime(h.db, { name: 'oc-fail', protocol: 'opencode', binaryPath: failBin })
    const res = await req(h.app, '/api/runtime/models?runtime=oc-fail')
    expect(res.status).toBe(502)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.code).toBe('opencode-models-failed')
    expect(json.runtime).toBe('oc-fail')
    // the git-URL credential is redacted before reaching the client.
    expect(String(json.message)).not.toContain('supersecrettoken')
  })
})
