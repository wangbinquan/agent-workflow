// RFC-251 T1 — `buildPluginSpecArray`, the single encoding of a platform
// `plugins` selection into opencode's `config.plugin`.
//
// Why this test exists: RFC-031 built these rules inline for the legacy spawn
// path; RFC-251 lifted them into `pluginSpec.ts` so the verified path's
// controlled config (hermetic.ts) shares ONE implementation. A drift between
// two copies would fail silently — opencode would load a different plugin set
// than the operator selected, with no error surfaced anywhere. These cases are
// the contract both assemblers are held to.
//
// The legacy-path behaviour itself stays locked by runner-plugin-inject.test.ts,
// which must keep passing unchanged after the extraction.

import { describe, expect, test } from 'bun:test'
import type { Plugin } from '@agent-workflow/shared'
import { buildPluginSpecArray } from '@/services/runtime/opencode/pluginSpec'

function plugin(name: string, partial: Partial<Plugin> = {}): Plugin {
  const base: Plugin = {
    id: 'p-' + name,
    name,
    spec: `${name}@1.0.0`,
    options: {},
    description: '',
    enabled: true,
    sourceKind: 'npm',
    cachedPath: `/tmp/aw-plugins/${name}/node_modules/${name}`,
    resolvedVersion: '1.0.0',
    installedAt: 0,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  return { ...base, ...partial }
}

describe('RFC-251 — buildPluginSpecArray', () => {
  test('empty input produces an empty array (callers omit the key entirely)', () => {
    expect(buildPluginSpecArray([])).toEqual([])
  })

  test('an enabled plugin becomes a bare file:// spec, never the user spec', () => {
    const specs = buildPluginSpecArray([plugin('dd')])
    expect(specs).toEqual(['file:///tmp/aw-plugins/dd/node_modules/dd'])
    // The npm specifier must never leak through — opencode would re-resolve it
    // over the network and defeat the eager-install contract.
    expect(JSON.stringify(specs)).not.toContain('dd@1.0.0')
  })

  test('non-empty options make it a [spec, options] tuple', () => {
    expect(buildPluginSpecArray([plugin('dd', { options: { apiKey: 'x' } })])).toEqual([
      ['file:///tmp/aw-plugins/dd/node_modules/dd', { apiKey: 'x' }],
    ])
  })

  test('an empty options bag stays a bare string, not an empty tuple', () => {
    expect(buildPluginSpecArray([plugin('dd', { options: {} })])).toEqual([
      'file:///tmp/aw-plugins/dd/node_modules/dd',
    ])
  })

  test('a cachedPath that is already a file:// URL passes through verbatim', () => {
    expect(buildPluginSpecArray([plugin('local', { cachedPath: 'file:///abs/p.ts' })])).toEqual([
      'file:///abs/p.ts',
    ])
  })

  test('disabled rows are dropped entirely', () => {
    expect(buildPluginSpecArray([plugin('off', { enabled: false })])).toEqual([])
    expect(buildPluginSpecArray([plugin('off', { enabled: false }), plugin('on')])).toEqual([
      'file:///tmp/aw-plugins/on/node_modules/on',
    ])
  })

  test('the same id reached twice through a closure is emitted once', () => {
    const p = plugin('shared')
    expect(buildPluginSpecArray([p, p, { ...p }])).toEqual([
      'file:///tmp/aw-plugins/shared/node_modules/shared',
    ])
  })

  test('distinct ids sharing a display name both survive', () => {
    const a = plugin('dup', { id: 'p-a', cachedPath: '/tmp/a' })
    const b = plugin('dup', { id: 'p-b', cachedPath: '/tmp/b' })
    expect(buildPluginSpecArray([a, b])).toEqual(['file:///tmp/a', 'file:///tmp/b'])
  })

  test('selection order is preserved', () => {
    expect(buildPluginSpecArray([plugin('z'), plugin('a')])).toEqual([
      'file:///tmp/aw-plugins/z/node_modules/z',
      'file:///tmp/aw-plugins/a/node_modules/a',
    ])
  })
})
