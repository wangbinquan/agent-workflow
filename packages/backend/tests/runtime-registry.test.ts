// RFC-112 PR-A — runtime registry data layer: CRUD + built-in read-only guards
// + in-use delete block + name/protocol validation + hard-reset seed + name →
// (protocol, binary) resolution. The two built-ins (opencode/claude-code) are
// seeded read-only; custom forks (renamed binaries) register additional rows.
// agents.runtime / config.defaultRuntime reference a row by name; node_runs
// freeze (protocol, binary) so the registry stays mutable (tested in PR-C).

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
  resolveAgentRuntime,
  resolveRuntimeByName,
  runtimeHead,
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

  test('seeds opencode + claude-code as read-only rows with NULL binary', async () => {
    await seedBuiltinRuntimes(db)
    const rows = await listRuntimes(db)
    expect(rows.length).toBe(2)
    const oc = rows.find((r) => r.name === 'opencode')!
    const cc = rows.find((r) => r.name === 'claude-code')!
    expect(oc.protocol).toBe('opencode')
    expect(oc.builtin).toBe(true)
    expect(oc.binaryPath).toBeNull()
    expect(cc.protocol).toBe('claude-code')
    expect(cc.builtin).toBe(true)
  })

  test('idempotent — re-seeding keeps exactly two rows', async () => {
    await seedBuiltinRuntimes(db)
    await seedBuiltinRuntimes(db)
    expect((await listRuntimes(db)).length).toBe(2)
  })

  test('resets IDENTITY (protocol/builtin) but PRESERVES binary/profile (RFC-113 D8)', async () => {
    // corruption: wrong protocol + non-builtin. RFC-113 narrows the reset to
    // identity only — a legitimately admin-set binary_path / model must survive
    // (built-in rows now carry editable binary + profile params).
    await db.insert(runtimes).values({
      id: ulid(),
      name: 'opencode',
      protocol: 'claude-code',
      binaryPath: '/usr/local/bin/oc',
      model: 'opus',
      builtin: false,
    })
    await seedBuiltinRuntimes(db)
    const oc = await getRuntime(db, 'opencode')
    expect(oc!.protocol).toBe('opencode') // identity corrected
    expect(oc!.builtin).toBe(true) // identity corrected
    expect(oc!.binaryPath).toBe('/usr/local/bin/oc') // PRESERVED (was reset to NULL pre-RFC-113)
    expect(oc!.model).toBe('opus') // PRESERVED
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
    expect(row.builtin).toBe(false)
    expect(row.createdBy).toBe('admin-1')
  })

  test('rejects a reserved built-in name', async () => {
    await expect(
      createRuntime(db, { name: 'opencode', protocol: 'opencode' }),
    ).rejects.toMatchObject({ code: 'runtime-name-reserved' })
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

  test('built-in delete is 403 read-only (identity locked)', async () => {
    await expect(deleteRuntime(db, 'claude-code', null)).rejects.toMatchObject({
      code: 'runtime-builtin-readonly',
    })
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

describe('runtimeHead (RFC-112 PR-A)', () => {
  test('custom binary → that binary', () => {
    expect(
      runtimeHead(
        {
          name: 'my-oc',
          protocol: 'opencode',
          binaryPath: '/a/my-oc',
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        {},
      ),
    ).toEqual(['/a/my-oc'])
  })

  test('built-in opencode → config.opencodePath ?? PATH', () => {
    expect(
      runtimeHead(
        {
          name: 'opencode',
          protocol: 'opencode',
          binaryPath: null,
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        {},
      ),
    ).toEqual(['opencode'])
    expect(
      runtimeHead(
        {
          name: 'opencode',
          protocol: 'opencode',
          binaryPath: null,
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        { opencodePath: '/p/oc' },
      ),
    ).toEqual(['/p/oc'])
  })

  test('built-in claude → config.claudeCodePath ?? PATH', () => {
    expect(
      runtimeHead(
        {
          name: 'claude-code',
          protocol: 'claude-code',
          binaryPath: null,
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        {},
      ),
    ).toEqual(['claude'])
    expect(
      runtimeHead(
        {
          name: 'claude-code',
          protocol: 'claude-code',
          binaryPath: null,
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        { claudeCodePath: '/p/cc' },
      ),
    ).toEqual(['/p/cc'])
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
