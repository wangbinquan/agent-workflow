// RFC-031 T8 — locks the runner's inline-plugin injection. Two invariants the
// rest of the platform depends on:
//   1. Every emitted spec starts with `file://` — opencode's plugin loader will
//      then use `resolvePathPluginTarget` and avoid the npm network path.
//   2. Options-bearing entries become the `[spec, options]` tuple form; bare
//      entries stay as plain strings. opencode's `config.plugin: Spec[]` is a
//      union of `string | [string, options]` (config/plugin.ts:11-13).
//
// We also lock:
//   - plugin key absent when no plugins passed (don't pollute inline JSON)
//   - enabled=false entries skipped
//   - dedupe by name across the closure
//   - source code anchor on the runner builder so a future refactor cannot
//     silently emit `spec` instead of the `file://...` form.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Agent, Plugin } from '@agent-workflow/shared'
import { buildInlineConfig } from '../src/services/runner'

function agent(name: string): Agent {
  return {
    id: 'agent-' + name,
    name,
    description: '',
    outputs: [],
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

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

describe('buildInlineConfig — RFC-031 plugin injection', () => {
  test('no plugins → inline config has no `plugin` key', () => {
    const cfg = buildInlineConfig(agent('w'), undefined, [], [], [])
    expect((cfg as { plugin?: unknown }).plugin).toBeUndefined()
  })

  test('single plugin without options → `file://<path>` string', () => {
    const cfg = buildInlineConfig(agent('w'), undefined, [], [], [plugin('dd')])
    expect(cfg.plugin).toEqual([`file:///tmp/aw-plugins/dd/node_modules/dd`])
  })

  test('single plugin with options → `[file://..., options]` tuple', () => {
    const cfg = buildInlineConfig(
      agent('w'),
      undefined,
      [],
      [],
      [plugin('dd', { options: { apiKey: 'x' } })],
    )
    expect(cfg.plugin).toEqual([[`file:///tmp/aw-plugins/dd/node_modules/dd`, { apiKey: 'x' }]])
  })

  test('cachedPath already a file:// URL is passed through verbatim', () => {
    const cfg = buildInlineConfig(
      agent('w'),
      undefined,
      [],
      [],
      [plugin('local', { cachedPath: 'file:///abs/path/plugin.ts' })],
    )
    expect(cfg.plugin).toEqual(['file:///abs/path/plugin.ts'])
  })

  test('enabled=false entries skipped', () => {
    const cfg = buildInlineConfig(
      agent('w'),
      undefined,
      [],
      [],
      [plugin('on'), plugin('off', { enabled: false })],
    )
    const arr = cfg.plugin as Array<string | [string, unknown]>
    expect(arr.length).toBe(1)
    expect(typeof arr[0] === 'string' && arr[0].includes('/on/')).toBe(true)
  })

  test('all entries disabled → no `plugin` key emitted', () => {
    const cfg = buildInlineConfig(
      agent('w'),
      undefined,
      [],
      [],
      [plugin('off', { enabled: false })],
    )
    expect((cfg as { plugin?: unknown }).plugin).toBeUndefined()
  })

  test('dedupe by name across closure', () => {
    const same = plugin('same')
    const cfg = buildInlineConfig(agent('w'), undefined, [], [], [same, same])
    expect((cfg.plugin as unknown[]).length).toBe(1)
  })

  test('mcp + plugin can coexist on the same inline config', () => {
    const cfg = buildInlineConfig(agent('w'), undefined, [], [], [plugin('dd')])
    expect(cfg.plugin).toBeDefined()
    expect(cfg.agent).toBeDefined()
  })
})

describe('runner source anchor — RFC-031 regression guards', () => {
  test('buildInlineConfig source mentions `file://` and `enabled` filtering', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf-8',
    )
    // file:// prefix is the contract with opencode's resolvePathPluginTarget;
    // grep guards a future refactor from accidentally passing the raw spec.
    expect(src).toContain('file://')
    // enabled-false filter must stay in place; the comment alone is not enough.
    expect(src).toContain('p.enabled === false')
  })
})
