// RFC-029-T1: normalizeInventoryRaw — pure & total coercion of dump-plugin
// JSON into a valid `InventorySnapshotCaptured`.

import { describe, expect, test } from 'bun:test'
import { normalizeInventoryRaw } from '../src/inventory'

describe('normalizeInventoryRaw', () => {
  test('empty input → all arrays empty, schemaVersion 1, capturedAt 0', () => {
    const out = normalizeInventoryRaw({})
    expect(out.captured).toBe(true)
    expect(out.schemaVersion).toBe(1)
    expect(out.capturedAt).toBe(0)
    expect(out.agents).toEqual([])
    expect(out.skills).toEqual([])
    expect(out.mcps).toEqual([])
    expect(out.plugins).toEqual([])
  })

  test('agents: missing fields → defaults; sorted by name', () => {
    const out = normalizeInventoryRaw({
      agents: [{ name: 'zeta' }, { name: 'alpha', mode: 'subagent', source: 'project' }],
    })
    expect(out.agents.map((a) => a.name)).toEqual(['alpha', 'zeta'])
    expect(out.agents[0]).toEqual({
      name: 'alpha',
      mode: 'subagent',
      modelProviderId: null,
      modelId: null,
      source: 'project',
    })
    expect(out.agents[1]!.mode).toBe('unknown')
  })

  test('skills: nullable path & description preserved', () => {
    const out = normalizeInventoryRaw({
      skills: [{ name: 'foo', source: 'managed', path: '/x', description: 'hi' }, { name: 'bar' }],
    })
    expect(out.skills.map((s) => s.name)).toEqual(['bar', 'foo'])
    expect(out.skills[1]!.path).toBe('/x')
    expect(out.skills[0]!.path).toBeNull()
  })

  test('mcps as array: passed through with defaults', () => {
    const out = normalizeInventoryRaw({
      mcps: [{ name: 'memcache', type: 'local', status: 'connected' }],
    })
    expect(out.mcps).toEqual([{ name: 'memcache', type: 'local', status: 'connected', hint: null }])
  })

  test('mcps as opencode Record<name, Status> → flattened & sorted', () => {
    const out = normalizeInventoryRaw({
      mcps: {
        memcache: { type: 'local', status: 'connected' },
        github: { type: 'remote', status: 'needs_auth', error: 'token missing' },
      },
    })
    expect(out.mcps.map((m) => m.name)).toEqual(['github', 'memcache'])
    expect(out.mcps[0]).toEqual({
      name: 'github',
      type: 'remote',
      status: 'needs_auth',
      hint: 'token missing',
    })
  })

  test('plugins: sorted by specifier', () => {
    const out = normalizeInventoryRaw({
      plugins: [
        { specifier: 'file:///z.mjs', source: 'inline' },
        { specifier: 'file:///a.mjs', source: 'global' },
      ],
    })
    expect(out.plugins.map((p) => p.specifier)).toEqual(['file:///a.mjs', 'file:///z.mjs'])
  })

  test('non-finite capturedAt → 0; positive number → truncated', () => {
    expect(normalizeInventoryRaw({ capturedAt: Number.NaN }).capturedAt).toBe(0)
    expect(normalizeInventoryRaw({ capturedAt: 1700000000123.7 }).capturedAt).toBe(1700000000123)
  })

  test('non-object input (null / number) → empty result, no throw', () => {
    expect(normalizeInventoryRaw(null).agents).toEqual([])
    expect(normalizeInventoryRaw(42 as unknown).agents).toEqual([])
  })
})
