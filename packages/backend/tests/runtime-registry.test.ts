// RFC-112 PR-A / RFC-153 — runtime registry data layer: CRUD + in-use / effective-
// default delete block + name/protocol validation + first-startup seed + name →
// (protocol, binary) resolution. RFC-153 removed the built-in read-only flag:
// opencode / claude-code are ORDINARY editable + deletable rows, seeded only on an
// empty table (a deleted row is never re-seeded). agents.runtime /
// config.defaultRuntime reference a row by name; node_runs freeze (protocol,
// binary) so the registry stays mutable (tested in PR-C).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, runtimes } from '../src/db/schema'
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

async function insertAgent(db: DbClient, name: string, runtime?: string): Promise<void> {
  await db.insert(agents).values({ id: ulid(), name, ...(runtime ? { runtime } : {}) })
}

describe('seedBuiltinRuntimes (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(() => {
    db = freshDb()
  })

  test('seeds opencode + claude-code as ordinary rows with NULL binary/model', async () => {
    await seedBuiltinRuntimes(db)
    const rows = await listRuntimes(db)
    expect(rows.length).toBe(2)
    const oc = rows.find((r) => r.name === 'opencode')!
    const cc = rows.find((r) => r.name === 'claude-code')!
    expect(oc.protocol).toBe('opencode')
    expect(oc.binaryPath).toBeNull()
    expect(oc.model).toBeNull() // RFC-153: NULL = opencode's own default, not preset
    expect(cc.protocol).toBe('claude-code')
  })

  test('idempotent — re-seeding keeps exactly two rows', async () => {
    await seedBuiltinRuntimes(db)
    await seedBuiltinRuntimes(db)
    expect((await listRuntimes(db)).length).toBe(2)
  })

  test('RFC-153: non-empty table → seed is a full no-op (never touches rows, never adds)', async () => {
    // A user row (even one reusing a preseeded name under a DIFFERENT protocol)
    // makes the table non-empty; seed must NOT run, correct identity, or add the
    // other preseeded row — a deletion/customization sticks across restarts.
    await db.insert(runtimes).values({
      id: ulid(),
      name: 'opencode',
      protocol: 'claude-code',
      binaryPath: '/usr/local/bin/oc',
      model: 'opus',
    })
    await seedBuiltinRuntimes(db)
    const rows = await listRuntimes(db)
    expect(rows.length).toBe(1) // no claude-code added
    const oc = rows[0]!
    expect(oc.protocol).toBe('claude-code') // NOT corrected — no identity reset anymore
    expect(oc.binaryPath).toBe('/usr/local/bin/oc')
    expect(oc.model).toBe('opus')
  })
})

describe('createRuntime (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(db)
  })

  test('registers a custom opencode-protocol fork', async () => {
    const row = await createRuntime(db, {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: '/usr/local/bin/my-oc',
      createdBy: 'admin-1',
    })
    expect(row.name).toBe('my-oc')
    expect(row.protocol).toBe('opencode')
    expect(row.binaryPath).toBe('/usr/local/bin/my-oc')
    expect(row.createdBy).toBe('admin-1')
  })

  test('RFC-153: names are not reserved — recreate collides on uniqueness, not reservation', async () => {
    // preseeded opencode exists (beforeEach) → name uniqueness blocks it as exists.
    await expect(
      createRuntime(db, { name: 'opencode', protocol: 'opencode' }),
    ).rejects.toMatchObject({ code: 'runtime-exists' })
    // Once the preseeded row is deleted the name is free to recreate (any protocol).
    await deleteRuntime(db, 'opencode', 'claude-code') // non-default here → allowed
    const recreated = await createRuntime(db, { name: 'opencode', protocol: 'claude-code' })
    expect(recreated.protocol).toBe('claude-code')
  })

  test('rejects an invalid name (uppercase / spaces / symbols)', async () => {
    for (const bad of ['My-OC', 'my oc', 'my_oc', 'my/oc', '-leading', '']) {
      await expect(createRuntime(db, { name: bad, protocol: 'opencode' })).rejects.toMatchObject({
        code: 'runtime-name-invalid',
      })
    }
  })

  test('rejects an invalid protocol', async () => {
    await expect(createRuntime(db, { name: 'weird', protocol: 'gemini' })).rejects.toMatchObject({
      code: 'runtime-protocol-invalid',
    })
  })

  test('rejects a duplicate name', async () => {
    await createRuntime(db, { name: 'my-oc', protocol: 'opencode' })
    await expect(
      createRuntime(db, { name: 'my-oc', protocol: 'claude-code' }),
    ).rejects.toMatchObject({ code: 'runtime-exists' })
  })

  test('rejects a multi-line binary path (no shell injection)', async () => {
    await expect(
      createRuntime(db, { name: 'evil', protocol: 'opencode', binaryPath: '/bin/x\nrm -rf /' }),
    ).rejects.toMatchObject({ code: 'runtime-binary-invalid' })
  })
})

describe('updateRuntime / deleteRuntime guards (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, { name: 'my-oc', protocol: 'opencode', binaryPath: '/a' })
  })

  test('built-in update of binary/model is ALLOWED (RFC-113 D8 — config面 editable)', async () => {
    const updated = await updateRuntime(db, 'opencode', { binaryPath: '/x', model: 'opus' })
    expect(updated.binaryPath).toBe('/x')
    expect(updated.model).toBe('opus')
    expect(updated.protocol).toBe('opencode') // identity still immutable
  })

  test('RFC-153: a preseeded runtime is deletable (not the default, not referenced)', async () => {
    // claude-code is not the effective default (opencode is, config unset) and no
    // agent pins it → deletion succeeds and sticks (seed won't re-add it).
    await deleteRuntime(db, 'claude-code', null)
    expect(await getRuntime(db, 'claude-code')).toBeNull()
  })

  test('custom update changes binary_path + profile', async () => {
    const updated = await updateRuntime(db, 'my-oc', { binaryPath: '/b', temperature: 0.5 })
    expect(updated.binaryPath).toBe('/b')
    expect(updated.temperature).toBe(0.5)
    expect(updated.protocol).toBe('opencode') // immutable
  })

  test('delete blocked while an agent references it', async () => {
    await insertAgent(db, 'auditor', 'my-oc')
    await expect(deleteRuntime(db, 'my-oc', null)).rejects.toMatchObject({ code: 'runtime-in-use' })
  })

  test('delete blocked while it is the config default', async () => {
    await expect(deleteRuntime(db, 'my-oc', 'my-oc')).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
  })

  test('RFC-153 F1: deleting effective default opencode (config.defaultRuntime unset) is blocked', async () => {
    // findRuntimeReferences folds unset → 'opencode', so the fallback default can't
    // be deleted out from under dispatch even when config never set it explicitly.
    await expect(deleteRuntime(db, 'opencode', null)).rejects.toMatchObject({
      code: 'runtime-in-use',
    })
  })

  test('delete succeeds once unreferenced', async () => {
    await deleteRuntime(db, 'my-oc', null)
    expect(await getRuntime(db, 'my-oc')).toBeNull()
  })

  test('delete/update a non-existent runtime is 404', async () => {
    await expect(deleteRuntime(db, 'nope', null)).rejects.toMatchObject({
      code: 'runtime-not-found',
    })
    await expect(updateRuntime(db, 'nope', {})).rejects.toMatchObject({ code: 'runtime-not-found' })
  })
})

describe('resolution: name → (protocol, binary) (RFC-112 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'my-claude',
      protocol: 'claude-code',
      binaryPath: '/opt/my-cc',
    })
  })

  test('built-in name resolves to its protocol with NULL binary', async () => {
    expect(await resolveRuntimeByName(db, 'opencode')).toMatchObject({
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
    })
  })

  test('custom name resolves to its protocol + binary', async () => {
    expect(await resolveRuntimeByName(db, 'my-claude')).toMatchObject({
      name: 'my-claude',
      protocol: 'claude-code',
      binaryPath: '/opt/my-cc',
    })
  })

  test('unknown name fail-safes to built-in opencode', async () => {
    expect(await resolveRuntimeByName(db, 'ghost')).toMatchObject({
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
    })
  })

  test('empty / null name → opencode (inherit default)', async () => {
    expect((await resolveRuntimeByName(db, '')).name).toBe('opencode')
    expect((await resolveRuntimeByName(db, null)).name).toBe('opencode')
  })

  test('resolveAgentRuntime: agent wins, else default, else opencode', async () => {
    expect((await resolveAgentRuntime(db, 'my-claude', 'opencode')).name).toBe('my-claude')
    expect((await resolveAgentRuntime(db, null, 'my-claude')).name).toBe('my-claude')
    expect((await resolveAgentRuntime(db, null, null)).name).toBe('opencode')
  })
})

describe('setRuntimeEnabled (RFC-118)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = freshDb()
    await seedBuiltinRuntimes(db)
  })

  test('disables a non-default built-in (claude-code) — stays in the list', async () => {
    const row = await setRuntimeEnabled(db, 'claude-code', false, 'opencode')
    expect(row.enabled).toBe(false)
    expect((await listRuntimes(db)).some((r) => r.name === 'claude-code')).toBe(true)
  })

  test('rejects disabling the effective default (opencode = config.defaultRuntime)', async () => {
    await expect(setRuntimeEnabled(db, 'opencode', false, 'opencode')).rejects.toThrow(
      /cannot be disabled/,
    )
  })

  test('rejects disabling opencode when config.defaultRuntime is unset (effective default)', async () => {
    // null config → effective default is 'opencode' (runtimeRowToView / resolve fail-safe).
    await expect(setRuntimeEnabled(db, 'opencode', false, null)).rejects.toThrow(
      /cannot be disabled/,
    )
  })

  test('re-enables a disabled runtime', async () => {
    await setRuntimeEnabled(db, 'claude-code', false, 'opencode')
    const row = await setRuntimeEnabled(db, 'claude-code', true, 'opencode')
    expect(row.enabled).toBe(true)
  })

  test('seedBuiltinRuntimes does NOT re-enable a disabled built-in (no resurrection on restart)', async () => {
    await setRuntimeEnabled(db, 'claude-code', false, 'opencode')
    await seedBuiltinRuntimes(db) // simulate a daemon restart
    expect((await getRuntime(db, 'claude-code'))!.enabled).toBe(false)
  })

  test('resolveRuntimeByName still resolves a DISABLED runtime (D4 — dispatch unaffected)', async () => {
    await setRuntimeEnabled(db, 'claude-code', false, 'opencode')
    const resolved = await resolveRuntimeByName(db, 'claude-code')
    expect(resolved.name).toBe('claude-code')
    expect(resolved.protocol).toBe('claude-code')
  })

  test('404 on unknown runtime', async () => {
    await expect(setRuntimeEnabled(db, 'nope', false, 'opencode')).rejects.toThrow(/not found/)
  })
})

describe('migrateConfigIntoBuiltins (RFC-153 F2 — protocol-guarded backfill)', () => {
  let db: DbClient
  beforeEach(() => {
    db = freshDb()
  })

  test('backfills binary onto the canonical rows (protocol matches)', async () => {
    await seedBuiltinRuntimes(db)
    await migrateConfigIntoBuiltins(db, { opencodePath: '/opt/oc', claudeCodePath: '/opt/cc' })
    expect((await getRuntime(db, 'opencode'))!.binaryPath).toBe('/opt/oc')
    expect((await getRuntime(db, 'claude-code'))!.binaryPath).toBe('/opt/cc')
  })

  test('does NOT write the opencode binary into a user row reusing the name under claude-code protocol', async () => {
    await db.insert(runtimes).values({
      id: ulid(),
      name: 'opencode',
      protocol: 'claude-code',
      binaryPath: null,
    })
    await migrateConfigIntoBuiltins(db, { opencodePath: '/opt/oc' })
    // protocol mismatch (claude-code !== opencode) → binary stays NULL.
    expect((await getRuntime(db, 'opencode'))!.binaryPath).toBeNull()
  })
})
