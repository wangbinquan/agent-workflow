// RFC-234 §1.1 — the intent-builder runtime selection is FAIL-CLOSED at config
// save time: a runtime whose protocol cannot prove the 'intent-read-v1'
// permission profile (v1: anything but opencode) is rejected with
// `intent-runtime-unsupported`; there is no configured-but-degraded state.
// Also the route-error-code-coverage naming test for that code.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig } from '@/config'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { seedBuiltinRuntimes, updateRuntime } from '@/services/runtimeRegistry'

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
  await seedBuiltinRuntimes(db)
  await updateRuntime(db, 'opencode', { model: 'openai/gpt-5' })
  await updateRuntime(db, 'claude-code', { model: 'anthropic/claude-sonnet-5' })
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

describe('RFC-234 intentBuilderRuntime fail-closed admission', () => {
  test('a non-opencode runtime is rejected with intent-runtime-unsupported', async () => {
    const { app, configPath } = await makeApp()
    const res = await putConfig(app, { intentBuilderRuntime: 'claude-code' })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error?: { code?: string }; code?: string }
    const code = body.error?.code ?? body.code
    expect(code).toBe('intent-runtime-unsupported')
    // Fail closed = nothing persisted.
    expect(loadConfig(configPath).intentBuilderRuntime).toBeUndefined()
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
})
