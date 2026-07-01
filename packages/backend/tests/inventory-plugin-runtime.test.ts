// RFC-029: real-runtime tests for aw-inventory-dump.mjs.
//
// Background: every other inventory test in this RFC mocks one layer *above*
// the plugin (mock-opencode writes inventory.json itself; the framework reads
// it). That left a gap big enough to ship a bug — `client.app.skills()`
// missing on the v1 SDK — through every layer. These tests close that gap
// by:
//
//   1. dynamic-importing the actual `.mjs` file the framework copies into
//      runDir,
//   2. constructing a `PluginInput` whose `client` matches one of the
//      observed opencode SDK shapes (v1 with no `skills()`, v2 with both,
//      missing `app`/`mcp` namespaces, broken methods, …),
//   3. calling `server(input)` and exercising the resulting `Hooks` exactly
//      the way opencode's plugin/index.ts:101 does at boot time,
//   4. asserting the JSON the plugin wrote to `OPENCODE_AW_INVENTORY_OUT`.
//
// If a future SDK change removes a method or renames a field, the matching
// case fails here loudly — before users see "清单插件内部报错" in the UI.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PLUGIN_PATH = resolve(
  import.meta.dir,
  '..',
  'src',
  'opencode-plugin',
  'aw-inventory-dump.mjs',
)

interface PluginModule {
  id: string
  server: (input: unknown) => Promise<{
    config?: (cfg: unknown) => Promise<void>
    'chat.message'?: () => Promise<void>
  }>
}

/**
 * Force a fresh import every test so module-level state (`dumped` flag,
 * `pluginsCache`) starts clean.
 */
async function loadPlugin(): Promise<PluginModule> {
  // cache-busting query keeps each test isolated.
  const url = `${PLUGIN_PATH}?t=${process.hrtime.bigint()}`
  const mod = (await import(url)) as { default: PluginModule }
  return mod.default
}

/** Wait for the queueMicrotask + dump() roundtrip to land. */
async function flushMicrotasks(): Promise<void> {
  // 4 macrotask round-trips is more than enough for Promise.allSettled
  // chains seeded inside a microtask to settle.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
}

let tmpDir: string
let outPath: string
let prevOut: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aw-inv-plugin-rt-'))
  outPath = join(tmpDir, 'inventory.json')
  prevOut = process.env.OPENCODE_AW_INVENTORY_OUT
  process.env.OPENCODE_AW_INVENTORY_OUT = outPath
})

afterEach(() => {
  if (prevOut === undefined) delete process.env.OPENCODE_AW_INVENTORY_OUT
  else process.env.OPENCODE_AW_INVENTORY_OUT = prevOut
  rmSync(tmpDir, { recursive: true, force: true })
})

interface Snapshot {
  captured: boolean
  schemaVersion?: number
  capturedAt?: number
  agents?: Array<{ name: string; mode: string; source: string }>
  skills?: Array<{ name: string; source: string; path: string | null }>
  mcps?: Array<{ name: string; type: string; status: string; hint: string | null }>
  plugins?: Array<{ specifier: string; source: string }>
  reason?: string
  message?: string | null
}

function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(outPath, 'utf-8')) as Snapshot
}

// -------------------------------------------------------------------------
// Fixture builders — each shape mirrors a real opencode SDK state.
// -------------------------------------------------------------------------

const RAW_AGENT_V1 = {
  name: 'reviewer',
  mode: 'primary',
  model: { providerID: 'anthropic', modelID: 'claude-opus-4-7' },
  source: { type: 'inline' },
  permission: { edit: 'deny', bash: 'deny' },
}

const RAW_SKILL = {
  name: 'foo',
  description: 'a skill',
  source: { type: 'managed', path: '/x/foo' },
}

const RAW_MCP_MAP = {
  memcache: { config: { type: 'local' }, status: 'connected' },
  github: { config: { type: 'remote' }, status: 'needs_auth', error: 'token missing' },
}

const RAW_PLUGIN_ORIGINS = [
  { spec: 'file:///plug-a.mjs', source: 'inline' },
  { spec: ['file:///plug-b.mjs', { token: 'x' }], source: 'global' },
]

/** v1 SDK: `app.agents()` + `app._client.get({url:'/skill'})` + `mcp.status()`. */
function makeV1Client(opts: { failSkillsRoute?: boolean } = {}) {
  return {
    client: {
      app: {
        agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
        // intentionally NO `skills` — v1 SDK shape.
        _client: {
          get: ({ url }: { url: string }) => {
            if (url === '/skill') {
              if (opts.failSkillsRoute) return Promise.reject(new Error('404 not found'))
              return Promise.resolve({ data: [RAW_SKILL] })
            }
            return Promise.reject(new Error('unknown url ' + url))
          },
        },
      },
      mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
    },
  }
}

/** v2 SDK: native `app.skills()`. */
function makeV2Client() {
  return {
    client: {
      app: {
        agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
        skills: () => Promise.resolve({ data: [RAW_SKILL] }),
      },
      mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
    },
  }
}

// -------------------------------------------------------------------------
// CASE 1: v1 SDK shape — must use `_client.get('/skill')` fallback.
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: v1 opencode SDK (no app.skills method)', () => {
  test('writes captured:true with skills resolved via /skill HTTP fallback', async () => {
    const plugin = await loadPlugin()
    await plugin.server(makeV1Client())
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.agents).toHaveLength(1)
    expect(snap.agents?.[0]?.name).toBe('reviewer')
    expect(snap.skills).toHaveLength(1)
    expect(snap.skills?.[0]?.name).toBe('foo')
    expect(snap.skills?.[0]?.path).toBe('/x/foo')
    expect(snap.mcps).toHaveLength(2)
  })

  test('failing /skill route degrades skills to [] without flipping captured:false', async () => {
    const plugin = await loadPlugin()
    await plugin.server(makeV1Client({ failSkillsRoute: true }))
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.skills).toEqual([])
    // agents + mcps still landed.
    expect(snap.agents).toHaveLength(1)
    expect(snap.mcps).toHaveLength(2)
  })
})

// -------------------------------------------------------------------------
// CASE 2: v2 SDK shape — native skills().
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: v2 opencode SDK (native app.skills)', () => {
  test('writes captured:true with skills resolved via native method', async () => {
    const plugin = await loadPlugin()
    await plugin.server(makeV2Client())
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.skills?.[0]?.name).toBe('foo')
  })
})

// -------------------------------------------------------------------------
// CASE 3: each individual SDK method failing must degrade just *that* slice.
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: per-method failure degrades only that section', () => {
  test('agents() rejects → agents:[], skills + mcps intact', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.reject(new Error('rpc fail')),
          skills: () => Promise.resolve({ data: [RAW_SKILL] }),
        },
        mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.agents).toEqual([])
    expect(snap.skills).toHaveLength(1)
    expect(snap.mcps).toHaveLength(2)
  })

  test('skills() rejects (no fallback wired) → skills:[], rest intact', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
          skills: () => Promise.reject(new Error('skills broke')),
        },
        mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.skills).toEqual([])
    expect(snap.agents).toHaveLength(1)
    expect(snap.mcps).toHaveLength(2)
  })

  test('mcp.status() rejects → mcps:[], rest intact', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
          skills: () => Promise.resolve({ data: [RAW_SKILL] }),
        },
        mcp: { status: () => Promise.reject(new Error('mcp pool down')) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.mcps).toEqual([])
    expect(snap.agents).toHaveLength(1)
    expect(snap.skills).toHaveLength(1)
  })

  test('all three reject → captured:true with everything empty (NOT dump-plugin-internal-error)', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.reject(new Error('a')),
          skills: () => Promise.reject(new Error('b')),
        },
        mcp: { status: () => Promise.reject(new Error('c')) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.agents).toEqual([])
    expect(snap.skills).toEqual([])
    expect(snap.mcps).toEqual([])
  })
})

// -------------------------------------------------------------------------
// CASE 4: namespace missing entirely (defensive against future SDK pruning).
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: missing SDK namespaces', () => {
  test('client.app undefined → agents + skills both [] but mcps still landed', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.agents).toEqual([])
    expect(snap.skills).toEqual([])
    expect(snap.mcps).toHaveLength(2)
  })

  test('client.mcp undefined → mcps:[] but agents + skills still landed', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
          skills: () => Promise.resolve({ data: [RAW_SKILL] }),
        },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.mcps).toEqual([])
    expect(snap.agents).toHaveLength(1)
    expect(snap.skills).toHaveLength(1)
  })

  test('client undefined entirely → captured:true with all sections empty', async () => {
    const plugin = await loadPlugin()
    await plugin.server({ client: undefined })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.agents).toEqual([])
    expect(snap.skills).toEqual([])
    expect(snap.mcps).toEqual([])
  })
})

// -------------------------------------------------------------------------
// CASE 5: malformed/strange SDK return shapes.
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: malformed SDK responses', () => {
  test('agents() resolves with null data → agents:[]', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: null }),
          skills: () => Promise.resolve({ data: [RAW_SKILL] }),
        },
        mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.agents).toEqual([])
  })

  test('skills() resolves with non-array → skills:[]', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
          skills: () => Promise.resolve({ data: { 'not-an-array': true } }),
        },
        mcp: { status: () => Promise.resolve({ data: RAW_MCP_MAP }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.skills).toEqual([])
  })

  test('mcp.status() resolves with non-object → mcps:[]', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
          skills: () => Promise.resolve({ data: [RAW_SKILL] }),
        },
        mcp: { status: () => Promise.resolve({ data: 'oops' }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.mcps).toEqual([])
  })

  test('mcp.status() data is undefined → mcps:[]', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [RAW_AGENT_V1] }),
          skills: () => Promise.resolve({ data: [] }),
        },
        mcp: { status: () => Promise.resolve({ data: undefined }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.mcps).toEqual([])
  })
})

// -------------------------------------------------------------------------
// CASE 6: hooks contract — config(cfg) and chat.message integration.
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: hooks integration', () => {
  test('hooks expose `config` + `chat.message` callbacks', async () => {
    const plugin = await loadPlugin()
    const hooks = await plugin.server(makeV2Client())
    expect(typeof hooks.config).toBe('function')
    expect(typeof hooks['chat.message']).toBe('function')
  })

  test('first dump before config(cfg) → plugins:[]; chat.message re-dumps with cached plugin_origins', async () => {
    const plugin = await loadPlugin()
    const hooks = await plugin.server(makeV2Client())
    await flushMicrotasks()
    // initial microtask dump: plugins not yet captured.
    let snap = readSnapshot()
    expect(snap.plugins).toEqual([])
    // config hook arrives — plugin caches origins, then chat.message
    // triggers a re-dump (idempotency aware: re-dump only when pluginsCache
    // is non-empty).
    await hooks.config?.({ plugin_origins: RAW_PLUGIN_ORIGINS })
    await hooks['chat.message']?.()
    await flushMicrotasks()
    snap = readSnapshot()
    expect(snap.plugins).toHaveLength(2)
    expect(snap.plugins?.[0]?.specifier).toBe('file:///plug-a.mjs')
    // tuple-form spec must resolve to its first element (the string spec).
    expect(snap.plugins?.[1]?.specifier).toBe('file:///plug-b.mjs')
  })

  test('config hook with missing plugin_origins → plugins:[] (no throw)', async () => {
    const plugin = await loadPlugin()
    const hooks = await plugin.server(makeV2Client())
    await flushMicrotasks()
    // Pass a malformed cfg — must not throw.
    await hooks.config?.({})
    await hooks.config?.({ plugin_origins: null })
    // re-dump path requires non-empty origins, so file content from the
    // initial microtask dump is what we see.
    const snap = readSnapshot()
    expect(snap.captured).toBe(true)
    expect(snap.plugins).toEqual([])
  })

  test('chat.message called twice with no cached plugins → does not re-dump (idempotent)', async () => {
    const plugin = await loadPlugin()
    const hooks = await plugin.server(makeV2Client())
    await flushMicrotasks()
    const firstSnap = readSnapshot()
    // delete file; ensure chat.message with pluginsCache=[] doesn't recreate
    // it (we want the "dumped=true" guard to stick).
    rmSync(outPath)
    await hooks['chat.message']?.()
    await hooks['chat.message']?.()
    await flushMicrotasks()
    let exists = true
    try {
      readFileSync(outPath)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
    expect(firstSnap.captured).toBe(true)
  })
})

// -------------------------------------------------------------------------
// CASE 7: env-var guard (OPENCODE_AW_INVENTORY_OUT).
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: OPENCODE_AW_INVENTORY_OUT guard', () => {
  test('env unset → server() resolves without writing a file (graceful no-op)', async () => {
    delete process.env.OPENCODE_AW_INVENTORY_OUT
    const plugin = await loadPlugin()
    await plugin.server(makeV2Client())
    await flushMicrotasks()
    let exists = true
    try {
      readFileSync(outPath)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  test('env empty string → server() does not write', async () => {
    process.env.OPENCODE_AW_INVENTORY_OUT = ''
    const plugin = await loadPlugin()
    await plugin.server(makeV2Client())
    await flushMicrotasks()
    let exists = true
    try {
      readFileSync(outPath)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})

// -------------------------------------------------------------------------
// CASE 8: dump-plugin-internal-error fallback path
// (triggered when the OUTER try ever throws — typically a write failure).
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: dump-plugin-internal-error path', () => {
  test('write to a non-existent parent dir succeeds via Bun.write mkdir-p (regression lock)', async () => {
    // Bun.write transparently creates missing parent directories. We
    // therefore can't synthesize a "write fails" path on a normal fs from
    // userland. Instead, lock this friendly behavior: even when OUT points
    // at a nested non-existent dir, the plugin still produces a captured:true
    // snapshot rather than crashing opencode. If a future Bun version drops
    // mkdir-p semantics this fails loudly so the framework adds its own
    // mkdir.
    const nested = join(tmpDir, 'no-such-dir', 'inventory.json')
    process.env.OPENCODE_AW_INVENTORY_OUT = nested
    const plugin = await loadPlugin()
    await plugin.server(makeV2Client())
    await flushMicrotasks()
    const snap = JSON.parse(readFileSync(nested, 'utf-8')) as Snapshot
    expect(snap.captured).toBe(true)
  })

  test('fallback stub format is parseable by the framework reader contract', async () => {
    // We can't easily make Bun.write throw on the happy path, but we can
    // verify the *stub* JSON the plugin would write satisfies the contract.
    // The plugin source contains the literal stub object — assert the keys
    // line up with what shared/inventory.ts expects.
    const src = readFileSync(PLUGIN_PATH, 'utf-8')
    expect(src).toContain("reason: 'dump-plugin-internal-error'")
    expect(src).toContain('captured: false')
    expect(src).toContain('message:')
  })
})

// -------------------------------------------------------------------------
// CASE 9: PluginModule export shape — keeps the plugin loadable.
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: module export shape', () => {
  test('default export is a PluginModule with id + server', async () => {
    const plugin = await loadPlugin()
    expect(plugin.id).toBe('aw-inventory-dump')
    expect(typeof plugin.server).toBe('function')
  })

  test('server() returns Hooks even when input is wildly malformed', async () => {
    const plugin = await loadPlugin()
    // No `client`, no anything.
    const hooks = await plugin.server({})
    expect(typeof hooks).toBe('object')
    expect(typeof hooks.config).toBe('function')
    expect(typeof hooks['chat.message']).toBe('function')
  })
})

// -------------------------------------------------------------------------
// CASE 10: real opencode SDK field mapping locks (regression for the
// initial RFC-029 bug where modelProviderID / source.type weren't being
// projected correctly).
// -------------------------------------------------------------------------

describe('aw-inventory-dump runtime: opencode SDK field mapping', () => {
  test('agent.source.type maps through (project)', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () =>
            Promise.resolve({
              data: [
                {
                  name: 'rw',
                  mode: 'primary',
                  permission: { edit: 'deny', bash: 'allow' },
                  source: { type: 'project' },
                },
              ],
            }),
          skills: () => Promise.resolve({ data: [] }),
        },
        mcp: { status: () => Promise.resolve({ data: {} }) },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.agents?.[0]?.source).toBe('project')
  })

  test('mcp Status with `error` field surfaces as `hint`', async () => {
    const plugin = await loadPlugin()
    await plugin.server({
      client: {
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.resolve({ data: [] }),
        },
        mcp: {
          status: () =>
            Promise.resolve({
              data: {
                broken: {
                  config: { type: 'remote' },
                  status: 'failed',
                  error: 'connection refused',
                },
              },
            }),
        },
      },
    })
    await flushMicrotasks()
    const snap = readSnapshot()
    expect(snap.mcps?.[0]?.hint).toBe('connection refused')
    expect(snap.mcps?.[0]?.status).toBe('failed')
  })
})
