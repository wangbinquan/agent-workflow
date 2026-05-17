// RFC-031 T10 — detectPluginLoadFailure recognises opencode's plugin error
// log lines and maps the file:// spec back to a plugin record's name so the
// UI can render an actionable warning chip instead of opaque stderr.

import { describe, expect, test } from 'bun:test'
import type { Plugin } from '@agent-workflow/shared'
import { detectPluginLoadFailure } from '../src/services/runner'

function plugin(name: string, cachedPath: string): Plugin {
  return {
    id: `p-${name}`,
    name,
    spec: `${name}@1`,
    options: {},
    description: '',
    enabled: true,
    sourceKind: 'npm',
    cachedPath,
    resolvedVersion: '1.0.0',
    installedAt: 0,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('detectPluginLoadFailure', () => {
  test('returns null for non-error lines', () => {
    expect(detectPluginLoadFailure('hello world', [])).toBeNull()
  })

  test('Failed to load plugin <file://...>: <msg> — maps to plugin name by cachedPath', () => {
    const p = plugin('dd-trace', '/aw/plugins/p1/node_modules/dd-trace')
    const line =
      'ERROR Failed to load plugin file:///aw/plugins/p1/node_modules/dd-trace: TypeError x'
    const r = detectPluginLoadFailure(line, [p])
    expect(r).not.toBeNull()
    expect(r?.pluginName).toBe('dd-trace')
    expect(r?.message).toContain('TypeError')
  })

  test('Failed to install plugin — also detected', () => {
    const line = 'Failed to install plugin nonexistent@99: ETARGET no matching version'
    const r = detectPluginLoadFailure(line, [])
    expect(r?.pluginName).toBe('')
    expect(r?.message).toContain('ETARGET')
  })

  test('Plugin <spec> skipped — detected', () => {
    const line = 'Plugin file:///abs/path skipped: incompatible opencode version'
    const r = detectPluginLoadFailure(line, [])
    expect(r).not.toBeNull()
    expect(r?.message).toContain('incompatible')
  })

  test('unknown plugin name when no match found → empty string + message kept', () => {
    const p = plugin('something-else', '/aw/plugins/p2/node_modules/some')
    const line = 'Failed to load plugin file:///aw/plugins/p1/node_modules/dd-trace: boom'
    const r = detectPluginLoadFailure(line, [p])
    expect(r?.pluginName).toBe('')
    expect(r?.message).toContain('boom')
  })

  test('source contains rfc031 tag literal (regression guard)', async () => {
    const src = await Bun.file(new URL('../src/services/runner.ts', import.meta.url)).text()
    expect(src).toContain('[rfc031/plugin-load-failed]')
  })
})
