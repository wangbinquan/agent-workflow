// RFC-234 §1.1 → RFC-237 — the intent-builder runtime selection is FAIL-CLOSED
// at config save time on DRIVER CAPABILITY: only runtimes whose driver declares
// the 'intent-read-v1' narrowed profile are admitted. RFC-237 flipped the
// original protocol-literal gate (claude-code was 422) to the capability gate —
// claude-code now declares the profile and is ACCEPTED; a future driver that
// does not declare it stays rejected (the rfc143 mock-driver test locks the
// empty-declaration contract, and the source assertions below lock that both
// gates consult the declaration instead of protocol literals). Also covers the
// RFC-237 P2-3 inherited-default save gate and the launch-time gate flip.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig } from '@/config'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { seedBuiltinRuntimes, updateRuntime } from '@/services/runtimeRegistry'
import { resolveIntentTurnConfig } from '@/services/intent/turnEngine'

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

describe('RFC-237 intentBuilderRuntime capability admission', () => {
  test('claude-code is ACCEPTED (RFC-237 flip of the RFC-234 protocol-literal rejection)', async () => {
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

  test('P2-3: switching defaultRuntime with intent unset re-validates the inherited runtime (claude default passes)', async () => {
    const { app, configPath } = await makeApp()
    const res = await putConfig(app, { defaultRuntime: 'claude-code' })
    expect(res.status).toBe(200)
    expect(loadConfig(configPath).defaultRuntime).toBe('claude-code')
    expect(loadConfig(configPath).intentBuilderRuntime).toBeUndefined()
  })

  test('impl-gate P2: clearing the override re-validates the inherited runtime too', async () => {
    // The clear path (`intentBuilderRuntime:null`) leaves defaultRuntime
    // untouched, so it must run the SAME inherited-capability check (both
    // built-in protocols qualify → 200; the fail-closed branch for an
    // undeclared future driver is locked by the source assertion below).
    const { app, configPath } = await makeApp()
    expect((await putConfig(app, { intentBuilderRuntime: 'claude-code' })).status).toBe(200)
    const cleared = await putConfig(app, { intentBuilderRuntime: null })
    expect(cleared.status).toBe(200)
    expect(loadConfig(configPath).intentBuilderRuntime).toBeUndefined()
  })

  test('launch gate flip: resolveIntentTurnConfig admits a claude-code selection', async () => {
    const { db } = await makeApp()
    const cfg = await resolveIntentTurnConfig(db, { intentBuilderRuntime: 'claude-code' })
    expect(cfg.runtime.protocol).toBe('claude-code')
    expect(cfg.runtime.configDir.env).toBe('CLAUDE_CONFIG_DIR')
  })

  test('both gates consult the driver capability declaration, not protocol literals (fail-closed source lock)', () => {
    // A third registered driver that does not declare 'intent-read-v1' cannot
    // be constructed through the real registry (the protocol enum is closed),
    // so the fail-closed guarantee is locked structurally: both gates must
    // read narrowedSystemPermissionProfiles — the declaration a new driver
    // omits by default (rfc143 mock locks the empty-set contract).
    const src = (p: string): string =>
      readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')
    const gate = /narrowedSystemPermissionProfiles\.includes\('intent-read-v1'\)/
    expect(src('routes/config.ts')).toMatch(gate)
    expect(src('services/intent/turnEngine.ts')).toMatch(gate)
    // And neither gate re-grew a protocol literal.
    expect(src('routes/config.ts')).not.toMatch(/protocol\s*[!=]==\s*'opencode'/)
    expect(src('services/intent/turnEngine.ts')).not.toMatch(/protocol\s*[!=]==\s*'opencode'/)
    // The stable rejection code survives the flip for undeclared drivers
    // (route-error-code-coverage: a thrown code must stay named by a test).
    expect(src('routes/config.ts')).toContain("'intent-runtime-unsupported'")
    expect(src('services/intent/turnEngine.ts')).toContain("'intent-runtime-unsupported'")
  })
})
