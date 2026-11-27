// RFC-616 §9.4 — process insight settings on the backend.
//
// The runtime setting holds a runtime NAME, so a runtime it names cannot be
// deleted (the analysis would silently fall back to another runtime); both
// settings persist through a patch and are removed again by null.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyConfigPatch, loadConfig } from '../src/config'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { createRuntime, deleteRuntime, listRuntimes } from './helpers/runtimeRegistryApplication'
import { DrizzleRuntimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'

describe('RFC-616 process insight settings are stored and cleared', () => {
  let tmp: string
  let path: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-rfc616-config-'))
    path = join(tmp, 'config.json')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('a patch persists both; null removes each without touching the other', () => {
    expect(loadConfig(path).processInsightSchedule).toBeUndefined()
    applyConfigPatch(path, { processInsightRuntime: 'analysis', processInsightSchedule: 'weekly' })
    expect(loadConfig(path)).toMatchObject({
      processInsightRuntime: 'analysis',
      processInsightSchedule: 'weekly',
    })
    const cleared = applyConfigPatch(path, { processInsightRuntime: null })
    expect(cleared.processInsightRuntime).toBeUndefined()
    expect(loadConfig(path).processInsightSchedule).toBe('weekly')
    applyConfigPatch(path, { processInsightSchedule: null })
    expect(loadConfig(path).processInsightSchedule).toBeUndefined()
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    expect('processInsightRuntime' in onDisk || 'processInsightSchedule' in onDisk).toBe(false)
  })
})

describeEachProvider('RFC-616 a runtime named by the process insight setting', (harness) => {
  const registryOf = (db: PersistenceDb) => new DrizzleRuntimeRegistryPersistence(db)

  test('cannot be deleted while the setting names it; can be once it no longer does', async () => {
    const registry = registryOf(harness.db)
    await createRuntime(registry, { name: 'analysis', protocol: 'opencode' })
    await createRuntime(registry, { name: 'main', protocol: 'opencode' })
    await expect(
      deleteRuntime(registry, 'analysis', { processInsightRuntime: 'analysis' }),
    ).rejects.toMatchObject({
      code: 'runtime-in-use',
      message: expect.stringContaining('config.processInsightRuntime'),
    })
    expect((await listRuntimes(registry)).map((runtime) => runtime.name).sort()).toEqual([
      'analysis',
      'main',
    ])
    await deleteRuntime(registry, 'analysis', { processInsightRuntime: 'main' })
    expect((await listRuntimes(registry)).map((runtime) => runtime.name)).toEqual(['main'])
  })
})

test('RFC-616 the runtime removal use case hands the setting to the reference check', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../src/modules/runtime-management/application/runtimeManagement.ts'),
    'utf8',
  )
  expect(source).toContain('processInsightRuntime: cfg.processInsightRuntime')
})
