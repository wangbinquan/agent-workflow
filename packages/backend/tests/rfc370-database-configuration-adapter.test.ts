// RFC-370 A-T2 — the standalone database configuration adapter preserves
// defaults, independent settings and activation failures while separating IO
// from the migration owner. This is file behavior, not a mock CS adapter.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseConfigSchema } from '@agent-workflow/shared'
import { applyConfigPatch, invalidateReadConfigCache, loadConfig } from '@/config'
import { createFileDatabaseConfiguration } from '@/modules/system-operations/infrastructure/local/fileDatabaseConfiguration'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-database-config-'))
  roots.push(root)
  const path = join(root, 'config.json')
  return { path, adapter: createFileDatabaseConfiguration(path) }
}

describe('RFC-370 standalone database configuration adapter', () => {
  test('construction is lazy; first read preserves default-file creation', async () => {
    const { path, adapter } = fixture()
    expect(existsSync(path)).toBe(false)
    expect(await adapter.read()).toEqual({ provider: 'sqlite' })
    expect(loadConfig(path).database).toEqual({ provider: 'sqlite' })
    expect(existsSync(path)).toBe(true)
  })

  test('activation patches current configuration without losing another setting edit', async () => {
    const { path, adapter } = fixture()
    await adapter.read()
    applyConfigPatch(path, { maxConcurrentNodes: 7, theme: 'dark' })
    const target = DatabaseConfigSchema.parse({ provider: 'postgresql', poolMax: 3 })
    await adapter.write(target)
    expect(await adapter.read()).toEqual(target)
    expect(loadConfig(path)).toMatchObject({ maxConcurrentNodes: 7, theme: 'dark' })
    // Source activation replaces the discriminated database branch completely.
    await adapter.write({ provider: 'sqlite' })
    expect(await adapter.read()).toEqual({ provider: 'sqlite' })
    expect(loadConfig(path)).toMatchObject({ maxConcurrentNodes: 7, theme: 'dark' })
  })

  test('read does not expose a mutable cached configuration object', async () => {
    const { adapter } = fixture()
    await adapter.write(DatabaseConfigSchema.parse({ provider: 'postgresql', poolMax: 3 }))
    const first = await adapter.read()
    if (first.provider !== 'postgresql') throw new Error('expected PostgreSQL configuration')
    first.poolMax = 99
    expect(await adapter.read()).toMatchObject({ poolMax: 3 })
  })

  test('invalid persisted configuration remains an error and is not overwritten', async () => {
    const { path, adapter } = fixture()
    await adapter.read()
    const corrupt = '{ invalid config'
    writeFileSync(path, corrupt)
    invalidateReadConfigCache(path)
    await expect(Promise.resolve().then(() => adapter.read())).rejects.toThrow('failed to parse')
    await expect(
      Promise.resolve().then(() => adapter.write({ provider: 'sqlite' })),
    ).rejects.toThrow('failed to parse')
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
  })
})
