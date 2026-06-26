// RFC-001 HTTP integration tests for /api/runtime/opencode and /api/runtime/models.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { applyConfigPatch, loadConfig } from '../src/config'
import { clearOpencodeModelsCache } from '../src/util/opencode-models'
import { MIN_OPENCODE_VERSION } from '../src/util/opencode'

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
): void {
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
}

describe('GET /api/runtime/opencode', () => {
  let h: Harness

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-runtime-bin-'))
    const bin = join(tmp, 'opencode')
    writeBinary(bin, {})
    h = makeHarness({ binary: bin })
    clearOpencodeModelsCache()
  })

  afterEach(() => {
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('returns probe result for valid binary', async () => {
    const res = await req(h.app, '/api/runtime/opencode')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.binary).toBe(h.binaryPath)
    expect(json.version).toBe('1.14.25')
    expect(json.compatible).toBe(true)
    expect(json.minVersion).toBe(MIN_OPENCODE_VERSION)
    expect(json.maxVersionExclusive).toBeUndefined()
    expect(json.incompatibleReason).toBeUndefined()
  })

  test('returns null version + compatible=false when binary missing', async () => {
    applyConfigPatch(h.configPath, { opencodePath: '/no/such/path/opencode-xyz' })
    const res = await req(h.app, '/api/runtime/opencode')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.version).toBeNull()
    expect(json.compatible).toBe(false)
  })

  test('flags version below MIN_OPENCODE_VERSION as incompatible', async () => {
    writeBinary(h.binaryPath, { versionStdout: 'stub-opencode 1.0.0' })
    const res = await req(h.app, '/api/runtime/opencode')
    const json = (await res.json()) as Record<string, unknown>
    expect(json.version).toBe('1.0.0')
    expect(json.compatible).toBe(false)
    expect(typeof json.incompatibleReason).toBe('string')
    expect(json.incompatibleReason as string).toContain(MIN_OPENCODE_VERSION)
  })

  test('accepts versions above the former upper bound (no version ceiling)', async () => {
    // Regression guard: the upper-bound gate was removed (user request
    // 2026-06-19). Any version >= MIN_OPENCODE_VERSION must probe as
    // compatible — including ones that the old 1.17.0 cap rejected, and far
    // beyond it. If a ceiling is ever reintroduced, this test goes red.
    for (const v of ['1.17.0', '1.99.99', '2.0.0', '10.0.0']) {
      writeBinary(h.binaryPath, { versionStdout: `stub-opencode ${v}` })
      const res = await req(h.app, '/api/runtime/opencode')
      const json = (await res.json()) as Record<string, unknown>
      expect(json.version).toBe(v)
      expect(json.compatible).toBe(true)
      expect(json.incompatibleReason).toBeUndefined()
    }
  })

  test('401 without token', async () => {
    const res = await h.app.request('/api/runtime/opencode')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/runtime/models', () => {
  let h: Harness

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-runtime-bin-'))
    const bin = join(tmp, 'opencode')
    writeBinary(bin, {
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
    rmSync(h.tmp, { recursive: true, force: true })
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
    writeBinary(h.binaryPath, {
      modelsStdout: 'anthropic/foo',
      recordArgs: argsLog,
    })
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
    const otherBin = join(otherDir, 'opencode')
    writeBinary(otherBin, { modelsStdout: 'openai/bar' })
    applyConfigPatch(h.configPath, { opencodePath: otherBin })
    const res = await req(h.app, '/api/runtime/models')
    const json = (await res.json()) as Record<string, unknown>
    expect(json.cached).toBe(false)
    expect(json.binary).toBe(otherBin)
    rmSync(otherDir, { recursive: true, force: true })
  })

  test('returns 502 with error code on non-zero exit', async () => {
    writeBinary(h.binaryPath, { modelsExit: 3, modelsStderr: 'kaboom' })
    const res = await req(h.app, '/api/runtime/models')
    expect(res.status).toBe(502)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.code).toBe('opencode-models-failed')
    expect(String(json.message)).toContain('kaboom')
  })
})

// RFC-111 — claude-code runtime probe + static model list.
describe('GET /api/runtime/claude + models?runtime=claude (RFC-111)', () => {
  let h: Harness
  let claudeBin: string
  beforeEach(() => {
    // opencode path is a non-empty placeholder (claude routes never invoke it).
    h = makeHarness({ binary: 'opencode' })
    claudeBin = join(h.tmp, 'fake-claude')
    writeBinary(claudeBin, { versionStdout: '2.1.193 (Claude Code)' })
    applyConfigPatch(h.configPath, { claudeCodePath: claudeBin })
  })
  afterEach(() => rmSync(h.tmp, { recursive: true, force: true }))

  test('probe returns version + compatible for a present claude', async () => {
    const res = await req(h.app, '/api/runtime/claude')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.binary).toBe(claudeBin)
    expect(json.version).toBe('2.1.193')
    expect(json.compatible).toBe(true)
    expect(typeof json.minVersion).toBe('string')
  })

  test('probe reports compatible=false when claude binary is missing (soft, no crash)', async () => {
    applyConfigPatch(h.configPath, { claudeCodePath: join(h.tmp, 'nonexistent-claude') })
    const res = await req(h.app, '/api/runtime/claude')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.version).toBeNull()
    expect(json.compatible).toBe(false)
  })

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
