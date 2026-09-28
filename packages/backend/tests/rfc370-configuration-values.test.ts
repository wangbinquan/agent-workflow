// RFC-370: hosted configuration must share standalone value semantics.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { applyConfigPatch, loadConfig, previewConfigPatch } from '@/config'
import {
  mergeValidatedConfigurationPatch,
  resolveConfigurationValue,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'

function withConfig<T>(raw: unknown, action: (path: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-config-values-'))
  const path = join(root, 'config.json')
  try {
    if (raw !== undefined) writeFileSync(path, JSON.stringify(raw))
    return action(path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('RFC-370 configuration value rules', () => {
  test('stored partial values backfill the same defaults with either storage source', () => {
    const raw = {
      $schema_version: 1,
      theme: 'dark',
      worktreeAutoGc: { enabled: true, olderThanDays: 42 },
      eventsArchiveThresholds: { perNodeRunRows: 999 },
    }
    const resolved = resolveConfigurationValue(raw)
    expect(resolved.theme).toBe('dark')
    expect(resolved.eventsArchiveThresholds.globalRows).toBe(
      DEFAULT_CONFIG.eventsArchiveThresholds.globalRows,
    )
    withConfig(raw, (path) => expect(loadConfig(path)).toEqual(resolved))
  })

  test('nested patches and explicit null keep the original inheritance behavior', () => {
    const current = resolveConfigurationValue({
      worktreeAutoGc: { enabled: true, olderThanDays: 42 },
      memoryDistillRuntime: 'custom-runtime',
      commitPushRuntime: 'keep-runtime',
    })
    const before = structuredClone(current)
    const patch = { worktreeAutoGc: { enabled: false }, memoryDistillRuntime: null }
    const next = mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch))
    expect(current).toEqual(before)
    expect(patch.memoryDistillRuntime).toBeNull()
    expect(next.worktreeAutoGc).toEqual({ enabled: false, olderThanDays: 42 })
    expect(next.memoryDistillRuntime).toBeUndefined()
    expect(next.commitPushRuntime).toBe('keep-runtime')
    withConfig(current, (path) => {
      expect(previewConfigPatch(path, patch)).toEqual(next)
      expect(loadConfig(path)).toEqual(before)
      expect(applyConfigPatch(path, patch)).toEqual(next)
      expect(loadConfig(path)).toEqual(next)
    })
  })

  test('database changes preserve variant replacement and schema default semantics', () => {
    const current = resolveConfigurationValue({ theme: 'dark' })
    const patches = [
      {
        patch: { database: { provider: 'postgresql', urlEnv: 'CS_PG_URL', poolMax: 9 } },
        expected: { provider: 'postgresql', urlEnv: 'CS_PG_URL', poolMax: 9 },
      },
      {
        patch: { database: { provider: 'postgresql', poolMax: 12 } },
        expected: { provider: 'postgresql', urlEnv: 'AGENT_WORKFLOW_DATABASE_URL', poolMax: 12 },
      },
      { patch: { database: { provider: 'sqlite' } }, expected: { provider: 'sqlite' } },
    ]
    withConfig(current, (path) => {
      let value = current
      for (const { patch, expected } of patches) {
        value = mergeValidatedConfigurationPatch(value, validateConfigurationPatch(patch))
        expect(applyConfigPatch(path, patch)).toEqual(value)
        expect(loadConfig(path)).toEqual(value)
        expect(value.theme).toBe('dark')
        expect(value.database).toMatchObject(expected)
      }
      expect(value.database).toEqual({ provider: 'sqlite' })
    })
  })

  test('invalid patches are rejected before a missing file can be materialized', () => {
    const patch = { maxConcurrentNodes: -1 }
    expect(() => validateConfigurationPatch(patch)).toThrow('config patch failed validation')
    withConfig(undefined, (path) => {
      expect(() => previewConfigPatch(path, patch)).toThrow('config patch failed validation')
      expect(() => applyConfigPatch(path, patch)).toThrow('config patch failed validation')
      expect(existsSync(path)).toBe(false)
    })
  })

  test('invalid stored values retain the standalone validation error', () => {
    const raw = { bindPort: 'invalid' }
    expect(() => resolveConfigurationValue(raw)).toThrow('config: validation failed:')
    withConfig(raw, (path) => {
      expect(() => loadConfig(path)).toThrow('config: validation failed:')
    })
  })
})
