// RFC-112 PR-A / RFC-153 — runtime registry data layer: CRUD + in-use / effective-
// default delete block + name/protocol validation + first-startup seed + name →
// (protocol, binary) resolution. RFC-153 removed the built-in read-only flag:
// opencode / claude-code are ORDINARY editable + deletable rows, seeded only on an
// empty table (a deleted row is never re-seeded). agents.runtime /
// config.defaultRuntime reference a row by name; node_runs freeze (protocol,
// binary) so the registry stays mutable (tested in PR-C).

import { beforeEach, describe, expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, runtimes } from '../src/db/schema'
import { SqliteRuntimeRegistryPersistence } from '../src/platform/runtime-registry/infrastructure/sqliteRuntimeRegistryPersistence'
import {
  createRuntime,
  deleteRuntime,
  getRuntime,
  listRuntimes,
  migrateConfigIntoBuiltins,
  resolveAgentRuntime,
  resolveRuntimeByName,
  seedBuiltinRuntimes,
  setRuntimeEnabled,
  updateRuntime,
} from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function freshDb(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

const registryByDb = new WeakMap<DbClient, SqliteRuntimeRegistryPersistence>()

function registryFor(db: DbClient): SqliteRuntimeRegistryPersistence {
  const existing = registryByDb.get(db)
  if (existing !== undefined) return existing
  const registry = new SqliteRuntimeRegistryPersistence(db)
  registryByDb.set(db, registry)
  return registry
}

async function insertAgent(db: DbClient, name: string, runtime?: string): Promise<void> {
  await db.insert(agents).values({ id: ulid(), name, ...(runtime ? { runtime } : {}) })
}

describe('seedBuiltinRuntimes (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(() => {
    db = freshDb()
  })

  test('seeds opencode + claude-code as ordinary rows with NULL binary/model', async () => {
    await seedBuiltinRuntimes(registryFor(db))
    const rows = await listRuntimes(registryFor(db))
    expect(rows.length).toBe(2)
    const oc = rows.find((r) => r.name === 'opencode')!
    const cc = rows.find((r) => r.name === 'claude-code')!
    expect(oc.protocol).toBe('opencode')
    expect(oc.binaryPath).toBeNull()
    expect(oc.model).toBeNull() // RFC-153: NULL = opencode's own default, not preset
    expect(cc.protocol).toBe('claude-code')
  })

  test('idempotent — re-seeding keeps exactly two rows', async () => {
    await seedBuiltinRuntimes(registryFor(db))
    await seedBuiltinRuntimes(registryFor(db))
    expect((await listRuntimes(registryFor(db))).length).toBe(2)
  })

  test('RFC-153: non-empty table → seed is a full no-op (never touches rows, never adds)', async () => {
    // A user row (even one reusing a preseeded name under a DIFFERENT protocol)
    // makes the table non-empty; seed must NOT run, correct identity, or add the
    // other preseeded row — a deletion/customization sticks across restarts.
    await db.insert(runtimes).values({
      id: ulid(),
      name: 'opencode',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('oc'),
      model: 'opus',
    })
    await seedBuiltinRuntimes(registryFor(db))
    const rows = await listRuntimes(registryFor(db))
    expect(rows.length).toBe(1) // no claude-code added
    const oc = rows[0]!
    expect(oc.protocol).toBe('claude-code') // NOT corrected — no identity reset anymore
    expect(oc.binaryPath).toBe(canonicalBinaryPath('oc'))
    expect(oc.model).toBe('opus')
  })
})

describe('createRuntime (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(registryFor(db))
  })

  test('registers a custom opencode-protocol fork', async () => {
    const row = await createRuntime(registryFor(db), {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: canonicalBinaryPath('my-oc'),
      createdBy: 'admin-1',
    })
    expect(row.name).toBe('my-oc')
    expect(row.protocol).toBe('opencode')
    expect(row.binaryPath).toBe(canonicalBinaryPath('my-oc'))
    expect(row.createdBy).toBe('admin-1')
    expect(row.isSandbox).toBe(false)
  })

  test('isSandbox defaults off, is supported only by claude-code, and round-trips', async () => {
    const claude = await createRuntime(registryFor(db), {
      name: 'claude-compat',
      protocol: 'claude-code',
      isSandbox: true,
    })
    expect(claude.isSandbox).toBe(true)

    await expect(
      createRuntime(registryFor(db), {
        name: 'oc-misleading',
        protocol: 'opencode',
        isSandbox: true,
      }),
    ).rejects.toMatchObject({ code: 'runtime-is-sandbox-unsupported' })
  })

  test('RFC-153: names are not reserved — recreate collides on uniqueness, not reservation', async () => {
    // preseeded opencode exists (beforeEach) → name uniqueness blocks it as exists.
    await expect(
      createRuntime(registryFor(db), { name: 'opencode', protocol: 'opencode' }),
    ).rejects.toMatchObject({ code: 'runtime-exists' })
    // Once the preseeded row is deleted the name is free to recreate (any protocol).
    await deleteRuntime(registryFor(db), 'opencode', { defaultRuntime: 'claude-code' }) // non-default here → allowed
    const recreated = await createRuntime(registryFor(db), {
      name: 'opencode',
      protocol: 'claude-code',
    })
    expect(recreated.protocol).toBe('claude-code')
  })

  test('rejects an invalid name (uppercase / spaces / symbols)', async () => {
    for (const bad of ['My-OC', 'my oc', 'my_oc', 'my/oc', '-leading', '']) {
      await expect(
        createRuntime(registryFor(db), { name: bad, protocol: 'opencode' }),
      ).rejects.toMatchObject({
        code: 'runtime-name-invalid',
      })
    }
  })

  test('rejects an invalid protocol', async () => {
    await expect(
      createRuntime(registryFor(db), { name: 'weird', protocol: 'gemini' }),
    ).rejects.toMatchObject({
      code: 'runtime-protocol-invalid',
    })
  })

  test('rejects a duplicate name', async () => {
    await createRuntime(registryFor(db), { name: 'my-oc', protocol: 'opencode' })
    await expect(
      createRuntime(registryFor(db), { name: 'my-oc', protocol: 'claude-code' }),
    ).rejects.toMatchObject({ code: 'runtime-exists' })
  })

  test('rejects a multi-line binary path (no shell injection)', async () => {
    await expect(
      createRuntime(registryFor(db), {
        name: 'evil',
        protocol: 'opencode',
        binaryPath: '/usr/bin/x\nrm -rf /',
      }),
    ).rejects.toMatchObject({ code: 'runtime-binary-invalid' })
  })

  test('enforces the numeric profile bounds exposed in Settings', async () => {
    const edge = await createRuntime(registryFor(db), {
      name: 'bounded-profile',
      protocol: 'opencode',
      temperature: 2,
      steps: 1_000,
      maxSteps: 1_000,
    })
    expect(edge).toMatchObject({ temperature: 2, steps: 1_000, maxSteps: 1_000 })

    await expect(
      createRuntime(registryFor(db), {
        name: 'hot-profile',
        protocol: 'opencode',
        temperature: 2.1,
      }),
    ).rejects.toMatchObject({ code: 'runtime-temperature-invalid' })
    await expect(
      createRuntime(registryFor(db), { name: 'long-profile', protocol: 'opencode', steps: 1_001 }),
    ).rejects.toMatchObject({ code: 'runtime-steps-invalid' })
    await expect(
      createRuntime(registryFor(db), {
        name: 'fractional-profile',
        protocol: 'opencode',
        maxSteps: 1.5,
      }),
    ).rejects.toMatchObject({ code: 'runtime-maxSteps-invalid' })
  })
})

describe('updateRuntime / deleteRuntime guards (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(registryFor(db))
    await createRuntime(registryFor(db), {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: canonicalBinaryPath('a'),
    })
  })

  test('built-in update of binary/model is ALLOWED (RFC-113 D8 — config面 editable)', async () => {
    const updated = await updateRuntime(registryFor(db), 'opencode', {
      binaryPath: canonicalBinaryPath('x'),
      model: 'opus',
    })
    expect(updated.binaryPath).toBe(canonicalBinaryPath('x'))
    expect(updated.model).toBe('opus')
    expect(updated.protocol).toBe('opencode') // identity still immutable
  })

  test('RFC-153: a preseeded runtime is deletable (not the default, not referenced)', async () => {
    // claude-code is not the effective default (opencode is, config unset) and no
    // agent pins it → deletion succeeds and sticks (seed won't re-add it).
    await deleteRuntime(registryFor(db), 'claude-code', {})
    expect(await getRuntime(registryFor(db), 'claude-code')).toBeNull()
  })

  test('custom update changes binary_path + profile', async () => {
    const updated = await updateRuntime(registryFor(db), 'my-oc', {
      binaryPath: canonicalBinaryPath('b'),
      temperature: 0.5,
    })
    expect(updated.binaryPath).toBe(canonicalBinaryPath('b'))
    expect(updated.temperature).toBe(0.5)
    expect(updated.protocol).toBe('opencode') // immutable
  })

  test('execution-profile changes clear a stale smoke receipt, while a no-op preserves it', async () => {
    const receipt = JSON.stringify({ outcome: 'conforms', conforms: true })
    await updateRuntime(registryFor(db), 'my-oc', { lastProbeJson: receipt })

    const unchanged = await updateRuntime(registryFor(db), 'my-oc', {
      binaryPath: canonicalBinaryPath('a'),
    })
    expect(unchanged.lastProbeJson).toBe(receipt)
    expect(unchanged.probeFence).toBe(0)

    const changed = await updateRuntime(registryFor(db), 'my-oc', { model: 'openai/gpt-5.6' })
    expect(changed.lastProbeJson).toBeNull()
    expect(changed.probeFence).toBe(1)

    const freshReceipt = JSON.stringify({ outcome: 'auth-missing', conforms: false })
    const changedWithFreshReceipt = await updateRuntime(registryFor(db), 'my-oc', {
      model: 'openai/gpt-5.7',
      lastProbeJson: freshReceipt,
    })
    expect(changedWithFreshReceipt.lastProbeJson).toBe(freshReceipt)
    expect(changedWithFreshReceipt.probeFence).toBe(2)
  })

  test('changing isSandbox invalidates the runtime smoke receipt and bumps its fence', async () => {
    await createRuntime(registryFor(db), { name: 'claude-compat', protocol: 'claude-code' })
    const receipt = JSON.stringify({ outcome: 'conforms', conforms: true })
    await updateRuntime(registryFor(db), 'claude-compat', { lastProbeJson: receipt })

    const changed = await updateRuntime(registryFor(db), 'claude-compat', { isSandbox: true })
    expect(changed.isSandbox).toBe(true)
    expect(changed.lastProbeJson).toBeNull()
    expect(changed.probeFence).toBe(1)
  })

  test('delete blocked while an agent references it', async () => {
    await insertAgent(db, 'auditor', 'my-oc')
    await expect(deleteRuntime(registryFor(db), 'my-oc', {})).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
  })

  test('delete blocked while it is the config default', async () => {
    await expect(
      deleteRuntime(registryFor(db), 'my-oc', { defaultRuntime: 'my-oc' }),
    ).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
  })

  test('RFC-153 F1: deleting effective default opencode (config.defaultRuntime unset) is blocked', async () => {
    // findRuntimeReferences folds unset → 'opencode', so the fallback default can't
    // be deleted out from under dispatch even when config never set it explicitly.
    await expect(deleteRuntime(registryFor(db), 'opencode', {})).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
  })

  test('delete succeeds once unreferenced', async () => {
    await deleteRuntime(registryFor(db), 'my-oc', {})
    expect(await getRuntime(registryFor(db), 'my-oc')).toBeNull()
  })

  test('delete/update a non-existent runtime is 404', async () => {
    await expect(deleteRuntime(registryFor(db), 'nope', {})).rejects.toMatchObject({
      code: 'runtime-not-found',
    })
    await expect(updateRuntime(registryFor(db), 'nope', {})).rejects.toMatchObject({
      code: 'runtime-not-found',
    })
  })

  test('RFC-153 impl-gate: delete blocked while a per-feature config field references it', async () => {
    // memoryDistillRuntime / commitPushRuntime / mergeAgentRuntime hold runtime
    // NAMEs (resolveInternalAgentRuntime); each must block delete like agents do,
    // else the internal job silently downgrades to the protocol-name fallback.
    await expect(
      deleteRuntime(registryFor(db), 'my-oc', { memoryDistillRuntime: 'my-oc' }),
    ).rejects.toMatchObject({ code: 'runtime-in-use' })
    await expect(
      deleteRuntime(registryFor(db), 'my-oc', { commitPushRuntime: 'my-oc' }),
    ).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
    await expect(
      deleteRuntime(registryFor(db), 'my-oc', { mergeAgentRuntime: 'my-oc' }),
    ).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
  })

  test('RFC-153 impl-gate: cannot delete the LAST runtime even when config.defaultRuntime dangles', async () => {
    // Delete down to a single row under a dangling default; the last-row backstop
    // (checked before the effective-default guard) refuses the final delete so the
    // table can never be emptied — which would let the next boot re-seed the
    // "deleted" preseeded rows (violating "deleted rows stay deleted").
    const refs = { defaultRuntime: 'ghost' } // dangling → not any real row
    await deleteRuntime(registryFor(db), 'my-oc', refs) // 3 → 2 (effective default folds to opencode ≠ my-oc)
    await deleteRuntime(registryFor(db), 'claude-code', refs) // 2 → 1
    await expect(deleteRuntime(registryFor(db), 'opencode', refs)).rejects.toMatchObject({
      code: 'runtime-last',
    })
  })

  test('RFC-153 impl-gate 2nd pass: a stale/dangling default still protects the opencode fallback', async () => {
    // >1 row so the last-row backstop is NOT the blocker. A dangling default
    // resolves (exactly like dispatch / resolveRuntimeByName) to the opencode
    // fallback, so opencode is the EFFECTIVE default and must be undeletable even
    // though config.defaultRuntime literally names something else.
    await expect(
      deleteRuntime(registryFor(db), 'opencode', { defaultRuntime: 'deleted-long-ago' }),
    ).rejects.toMatchObject({ code: 'runtime-in-use' })
    // sanity: a non-fallback row (claude-code) under the same dangling default IS
    // deletable — it isn't the effective default.
    await deleteRuntime(registryFor(db), 'claude-code', { defaultRuntime: 'deleted-long-ago' })
    expect(await getRuntime(registryFor(db), 'claude-code')).toBeNull()
  })

  test('RFC-153 impl-gate 2nd pass: each provider deletes inside one atomic transaction', async () => {
    // The last-row + reference guards are race-free only when each provider keeps
    // count, checks, MCP-test transitions and delete in one transaction. Lock both
    // implementations so a cutover cannot accidentally split the sequence.
    const sqlite = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'platform',
        'runtime-registry',
        'infrastructure',
        'sqliteRuntimeRegistryPersistence.ts',
      ),
      'utf-8',
    )
    const postgresql = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'platform',
        'runtime-registry',
        'infrastructure',
        'postgresqlRuntimeRegistryPersistence.ts',
      ),
      'utf-8',
    )
    const sqliteStart = sqlite.indexOf('  async deleteRuntime(')
    const sqliteDelete = sqlite.slice(
      sqliteStart,
      sqlite.indexOf('\n  async seedBuiltinRuntimes(', sqliteStart),
    )
    const postgresqlStart = postgresql.indexOf('  async deleteRuntime(')
    const postgresqlDelete = postgresql.slice(
      postgresqlStart,
      postgresql.indexOf('\n  async seedBuiltinRuntimes(', postgresqlStart),
    )
    expect(sqliteDelete).toContain('return dbTxSync(this.db, (transaction) => {')
    expect(postgresqlDelete).toContain(
      'return await serializable(this.db, async (transaction) => {',
    )
    expect(postgresql).toContain('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
  })

  test('RFC-153 impl-gate 3rd pass: missing built-in default resolves to itself, not opencode', async () => {
    // config.defaultRuntime='claude-code' but the claude-code ROW is gone. Exactly
    // like resolveRuntimeByName, a MISSING built-in name resolves to its OWN protocol
    // (claude-code), NOT opencode — so opencode is NOT the effective default and IS
    // deletable. (A missing NON-builtin name would fall back to opencode instead.)
    await deleteRuntime(registryFor(db), 'claude-code', { defaultRuntime: 'opencode' }) // 3 → 2 (remove claude-code)
    await deleteRuntime(registryFor(db), 'opencode', { defaultRuntime: 'claude-code' }) // opencode not effective default
    expect(await getRuntime(registryFor(db), 'opencode')).toBeNull()
  })
})

describe('resolution: name → (protocol, binary) (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(registryFor(db))
    await createRuntime(registryFor(db), {
      name: 'my-claude',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('my-cc'),
    })
  })

  test('built-in name resolves to its protocol with NULL binary', async () => {
    expect(await resolveRuntimeByName(registryFor(db), 'opencode')).toMatchObject({
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
    })
  })

  test('custom name resolves to its protocol + binary', async () => {
    expect(await resolveRuntimeByName(registryFor(db), 'my-claude')).toMatchObject({
      name: 'my-claude',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('my-cc'),
    })
  })

  test('unknown name fail-safes to built-in opencode', async () => {
    expect(await resolveRuntimeByName(registryFor(db), 'ghost')).toMatchObject({
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
    })
  })

  test('empty / null name → opencode (inherit default)', async () => {
    expect((await resolveRuntimeByName(registryFor(db), '')).name).toBe('opencode')
    expect((await resolveRuntimeByName(registryFor(db), null)).name).toBe('opencode')
  })

  test('resolveAgentRuntime: agent wins, else default, else opencode', async () => {
    expect((await resolveAgentRuntime(registryFor(db), 'my-claude', 'opencode')).name).toBe(
      'my-claude',
    )
    expect((await resolveAgentRuntime(registryFor(db), null, 'my-claude')).name).toBe('my-claude')
    expect((await resolveAgentRuntime(registryFor(db), null, null)).name).toBe('opencode')
  })
})

describe('setRuntimeEnabled (RFC-118)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(registryFor(db))
  })

  test('disables a non-default built-in (claude-code) — stays in the list', async () => {
    const row = await setRuntimeEnabled(registryFor(db), 'claude-code', false, 'opencode')
    expect(row.enabled).toBe(false)
    expect((await listRuntimes(registryFor(db))).some((r) => r.name === 'claude-code')).toBe(true)
  })

  test('rejects disabling the effective default (opencode = config.defaultRuntime)', async () => {
    await expect(setRuntimeEnabled(registryFor(db), 'opencode', false, 'opencode')).rejects.toThrow(
      /cannot be disabled/,
    )
  })

  test('rejects disabling opencode when config.defaultRuntime is unset (effective default)', async () => {
    // null config → effective default is 'opencode' (runtimeRowToView / resolve fail-safe).
    await expect(setRuntimeEnabled(registryFor(db), 'opencode', false, null)).rejects.toThrow(
      /cannot be disabled/,
    )
  })

  test('re-enables a disabled runtime', async () => {
    await setRuntimeEnabled(registryFor(db), 'claude-code', false, 'opencode')
    const row = await setRuntimeEnabled(registryFor(db), 'claude-code', true, 'opencode')
    expect(row.enabled).toBe(true)
  })

  test('seedBuiltinRuntimes does NOT re-enable a disabled built-in (no resurrection on restart)', async () => {
    await setRuntimeEnabled(registryFor(db), 'claude-code', false, 'opencode')
    await seedBuiltinRuntimes(registryFor(db)) // simulate a daemon restart
    expect((await getRuntime(registryFor(db), 'claude-code'))!.enabled).toBe(false)
  })

  test('resolveRuntimeByName still resolves a DISABLED runtime (D4 — dispatch unaffected)', async () => {
    await setRuntimeEnabled(registryFor(db), 'claude-code', false, 'opencode')
    const resolved = await resolveRuntimeByName(registryFor(db), 'claude-code')
    expect(resolved.name).toBe('claude-code')
    expect(resolved.protocol).toBe('claude-code')
  })

  test('404 on unknown runtime', async () => {
    await expect(setRuntimeEnabled(registryFor(db), 'nope', false, 'opencode')).rejects.toThrow(
      /not found/,
    )
  })
})

describe('migrateConfigIntoBuiltins (RFC-153 F2 — protocol-guarded backfill)', () => {
  let db: DbClient
  beforeEach(() => {
    db = freshDb()
  })

  test('backfills binary onto the canonical rows (protocol matches)', async () => {
    await seedBuiltinRuntimes(registryFor(db))
    await migrateConfigIntoBuiltins(registryFor(db), {
      opencodePath: canonicalBinaryPath('oc'),
      claudeCodePath: canonicalBinaryPath('cc'),
    })
    expect((await getRuntime(registryFor(db), 'opencode'))!.binaryPath).toBe(
      canonicalBinaryPath('oc'),
    )
    expect((await getRuntime(registryFor(db), 'claude-code'))!.binaryPath).toBe(
      canonicalBinaryPath('cc'),
    )
  })

  test('does NOT write the opencode binary into a user row reusing the name under claude-code protocol', async () => {
    await db.insert(runtimes).values({
      id: ulid(),
      name: 'opencode',
      protocol: 'claude-code',
      binaryPath: null,
    })
    await migrateConfigIntoBuiltins(registryFor(db), { opencodePath: canonicalBinaryPath('oc') })
    // protocol mismatch (claude-code !== opencode) → binary stays NULL.
    expect((await getRuntime(registryFor(db), 'opencode'))!.binaryPath).toBeNull()
  })
})

// Save-time binaryPath validation accepts one absolute canonical path or one
// bare PATH token. Relative fragments and argument strings fail near the admin
// input instead of much later at process spawn.
describe('binaryPath save-time validation', () => {
  test('accepts an absolute canonical path and a bare PATH token', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(registryFor(db))
    const abs = await createRuntime(registryFor(db), {
      name: 'abs-fork',
      protocol: 'opencode',
      binaryPath: canonicalBinaryPath('opencode'),
    })
    expect(abs.binaryPath).toBe(canonicalBinaryPath('opencode'))
    const token = await createRuntime(registryFor(db), {
      name: 'token-fork',
      protocol: 'claude-code',
      binaryPath: 'claude',
    })
    expect(token.binaryPath).toBe('claude')
  })

  test('rejects the shapes the seal would reject at exec time', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(registryFor(db))
    const cases: Array<[string, RegExp]> = [
      ['./bin/opencode', /relative paths are cwd-dependent/],
      ['bin/opencode', /relative paths are cwd-dependent/],
      ['/usr/bin/../bin/opencode', /canonical absolute path/],
      ['/usr/local/bin/', /canonical absolute path/],
      ['opencode --flag', /without arguments/],
    ]
    for (const [binaryPath, message] of cases) {
      await expect(
        createRuntime(registryFor(db), {
          name: `bad-${cases.indexOf([binaryPath, message])}`,
          protocol: 'opencode',
          binaryPath,
        }),
      ).rejects.toThrow(message)
    }
    // The historical newline guard is unchanged.
    await expect(
      createRuntime(registryFor(db), {
        name: 'bad-nl',
        protocol: 'opencode',
        binaryPath: '/usr/bin/x\nrm -rf /',
      }),
    ).rejects.toThrow(/single path/)
  })
})
