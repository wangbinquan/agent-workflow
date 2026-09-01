// RFC-234 runtime selection after RFC-276: Intent Builder uses the selected
// runtime's natural system-agent spawn. Both built-in protocols are admissible,
// inheritance remains intact, and neither config save nor turn launch invents
// a platform permission-profile capability gate.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig } from '@/config'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { seedBuiltinRuntimes, updateRuntime } from '@/services/runtimeRegistry'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import { resolveIntentTurnConfig } from '@/services/intent/turnEngine'
import { intentTurnRuntimeResolverForTest } from './helpers/intentResourceCatalogBinding'

const TOKEN = 'c'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function makeApp(): Promise<{
  app: ReturnType<typeof createApp>
  configPath: string
  db: DbClient
}> {
  const root = mkdtempSync(join(tmpdir(), 'rfc234-intent-runtime-'))
  roots.push(root)
  const configPath = join(root, 'config.json')
  loadConfig(configPath)
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(runtimeRegistryPersistence(db))
  await updateRuntime(runtimeRegistryPersistence(db), 'opencode', { model: 'openai/gpt-5' })
  await updateRuntime(runtimeRegistryPersistence(db), 'claude-code', {
    model: 'anthropic/claude-sonnet-5',
  })
  const app = createApp({
    token: TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
  })
  return { app, configPath, db }
}

async function putConfig(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/api/config', {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('RFC-276 natural intentBuilderRuntime admission', () => {
  test('claude-code is accepted and persisted', async () => {
    const { app, configPath } = await makeApp()
    const res = await putConfig(app, { intentBuilderRuntime: 'claude-code' })
    expect(res.status).toBe(200)
    expect(loadConfig(configPath).intentBuilderRuntime).toBe('claude-code')
  })

  test('an opencode runtime is accepted and persisted', async () => {
    const { app, configPath } = await makeApp()
    const res = await putConfig(app, { intentBuilderRuntime: 'opencode' })
    expect(res.status).toBe(200)
    expect(loadConfig(configPath).intentBuilderRuntime).toBe('opencode')
    // Clearing back to inherit works via the null-in-patch contract.
    const cleared = await putConfig(app, { intentBuilderRuntime: null })
    expect(cleared.status).toBe(200)
    expect(loadConfig(configPath).intentBuilderRuntime).toBeUndefined()
  })

  test('switching defaultRuntime with intent unset preserves natural inheritance', async () => {
    const { app, configPath } = await makeApp()
    const res = await putConfig(app, { defaultRuntime: 'claude-code' })
    expect(res.status).toBe(200)
    expect(loadConfig(configPath).defaultRuntime).toBe('claude-code')
    expect(loadConfig(configPath).intentBuilderRuntime).toBeUndefined()
  })

  test('clearing the override returns to the inherited runtime', async () => {
    const { app, configPath } = await makeApp()
    expect((await putConfig(app, { intentBuilderRuntime: 'claude-code' })).status).toBe(200)
    const cleared = await putConfig(app, { intentBuilderRuntime: null })
    expect(cleared.status).toBe(200)
    expect(loadConfig(configPath).intentBuilderRuntime).toBeUndefined()
  })

  test('resolveIntentTurnConfig admits a claude-code selection naturally', async () => {
    const { db } = await makeApp()
    const cfg = await resolveIntentTurnConfig(intentTurnRuntimeResolverForTest(db), {
      intentBuilderRuntime: 'claude-code',
    })
    expect(cfg.runtime.protocol).toBe('claude-code')
    expect(cfg.runtime.configDir.env).toBe('CLAUDE_CONFIG_DIR')
  })

  test('config save and launch contain no retired Intent permission-profile gate', () => {
    const src = (p: string): string =>
      readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')
    for (const path of [
      'routes/config.ts',
      'services/intent/turnEngine.ts',
      'services/runtime/types.ts',
    ]) {
      const text = src(path)
      expect(text).not.toContain('intent-read-v1')
      expect(text).not.toContain('narrowedSystemPermissionProfiles')
      expect(text).not.toContain('systemPermissionProfile')
      expect(text).not.toContain('intent-runtime-unsupported')
    }
  })
})
