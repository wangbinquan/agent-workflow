// RFC-031 T6 — agent save-time guard: every `plugins[]` entry must exist
// (plugin-not-found) and be enabled (plugin-disabled) at create / update time.
//
// Without this guard, agents save fine but the scheduler fails to load the
// missing plugin at runtime (or worse, silently drops it), turning "agent X
// needs plugin Y" into a non-actionable mystery.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, updateAgent } from '../src/services/agent'
import { createPlugin } from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')

let pluginsDir = ''

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-guard-'))
  resetNpmProbeCacheForTests()
  process.env.FAKE_NPM_MODE = 'success'
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  delete process.env.FAKE_NPM_MODE
})

const opts = () => ({ pluginsDir, npmBin: FAKE_NPM })

function agentInput(name: string, plugins: string[] = []): Parameters<typeof createAgent>[1] {
  return {
    name,
    description: '',
    outputs: [],
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins,
    frontmatterExtra: {},
    bodyMd: '',
  }
}

describe('agent.plugins save-time guard', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('create succeeds when every plugin resolves + enabled', async () => {
    await createPlugin(db, { name: 'p1', spec: 'p1@1' }, opts())
    const a = await createAgent(db, agentInput('consumer', ['p1']))
    expect(a.plugins).toEqual(['p1'])
  })

  test('create fails 422 plugin-not-found when a plugin is missing', async () => {
    try {
      await createAgent(db, agentInput('a', ['nope']))
      throw new Error('expected ValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const e = err as ValidationError
      expect(e.code).toBe('plugin-not-found')
      expect(e.details).toEqual(expect.objectContaining({ notFound: ['nope'] }))
    }
  })

  test('create fails 422 plugin-disabled when referenced plugin has enabled=false', async () => {
    const p = await createPlugin(db, { name: 'off', spec: 'p@1' }, opts())
    // Flip enabled off via direct service call.
    await (
      await import('../src/services/plugin')
    ).updatePlugin(db, p.id, { enabled: false }, opts())
    try {
      await createAgent(db, agentInput('a', ['off']))
      throw new Error('expected ValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const e = err as ValidationError
      expect(e.code).toBe('plugin-disabled')
    }
  })

  test('update fails 422 plugin-not-found when patched name unknown', async () => {
    await createPlugin(db, { name: 'p1', spec: 'p@1' }, opts())
    await createAgent(db, agentInput('a', ['p1']))
    try {
      await updateAgent(db, 'a', { plugins: ['nope'] })
      throw new Error('expected ValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).code).toBe('plugin-not-found')
    }
  })

  test('update without `plugins` field skips the check (preserves existing)', async () => {
    await createPlugin(db, { name: 'p1', spec: 'p@1' }, opts())
    await createAgent(db, agentInput('a', ['p1']))
    // Now disable the plugin from under the agent — patching unrelated field
    // must still succeed; guard only runs when caller touches `plugins`.
    const { updatePlugin } = await import('../src/services/plugin')
    const { eq } = await import('drizzle-orm')
    const { plugins: pluginsTable } = await import('../src/db/schema')
    const row = (await db.select().from(pluginsTable).where(eq(pluginsTable.name, 'p1')))[0]!
    await updatePlugin(db, row.id, { enabled: false }, opts())
    // PATCH something unrelated; should NOT trigger plugin validation, so it
    // passes even though the stale `plugins: ['p1']` is now disabled.
    const updated = await updateAgent(db, 'a', { description: 'unrelated' })
    expect(updated.plugins).toEqual(['p1'])
  })
})
