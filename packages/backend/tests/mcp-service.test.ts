// RFC-028 T3 — services/mcp.ts CRUD + reference cascade.
//
// Locks: create → list → get → update → rename → delete happy path; type
// immutability; still-referenced delete guard; name-conflict; rename cascade
// updates agents.mcp JSON column atomically.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent } from '../src/services/agent'
import {
  createMcp,
  deleteMcp,
  findAgentsReferencingMcp,
  getMcp,
  listMcps,
  renameMcp,
  updateMcp,
} from '../src/services/mcp'
import { ConflictError, NotFoundError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('services/mcp.ts CRUD', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('create + get round-trip (local)', async () => {
    const m = await createMcp(db, {
      name: 'postgres-prod',
      description: 'prod replica',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'], env: { PG_URL: 'p' } },
      enabled: true,
    })
    expect(m.id).toBeTruthy()
    expect(m.type).toBe('local')
    if (m.type === 'local') {
      expect(m.config.command).toEqual(['uvx', 'pg-mcp'])
      expect(m.config.env).toEqual({ PG_URL: 'p' })
    }
    expect(m.enabled).toBe(true)

    const fetched = await getMcp(db, 'postgres-prod')
    expect(fetched?.name).toBe('postgres-prod')
  })

  test('create + get round-trip (remote)', async () => {
    const m = await createMcp(db, {
      name: 'sentry',
      description: '',
      type: 'remote',
      config: { url: 'https://sentry.io/mcp', headers: { Authorization: 'Bearer x' } },
      enabled: true,
    })
    expect(m.type).toBe('remote')
    if (m.type === 'remote') {
      expect(m.config.url).toBe('https://sentry.io/mcp')
      expect(m.config.headers).toEqual({ Authorization: 'Bearer x' })
    }
  })

  test('list returns all rows', async () => {
    await createMcp(db, {
      name: 'a',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(db, {
      name: 'b',
      description: '',
      type: 'remote',
      config: { url: 'https://b.io' },
      enabled: false,
    })
    const list = await listMcps(db)
    expect(list.map((m) => m.name).sort()).toEqual(['a', 'b'])
    expect(list.find((m) => m.name === 'b')?.enabled).toBe(false)
  })

  test('name conflict on create → 409 mcp-name-in-use', async () => {
    await createMcp(db, {
      name: 'dup',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await expect(
      createMcp(db, {
        name: 'dup',
        description: '',
        type: 'remote',
        config: { url: 'https://x.io' },
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('update: description + enabled patch', async () => {
    await createMcp(db, {
      name: 'm',
      description: 'old',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const updated = await updateMcp(db, 'm', { description: 'new', enabled: false })
    expect(updated.description).toBe('new')
    expect(updated.enabled).toBe(false)
  })

  test('update: config replacement (local)', async () => {
    await createMcp(db, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const updated = await updateMcp(db, 'm', {
      type: 'local',
      config: { command: ['y', '-v'], env: { K: 'v' }, timeoutMs: 7000 },
    })
    if (updated.type !== 'local') throw new Error('type changed unexpectedly')
    expect(updated.config.command).toEqual(['y', '-v'])
    expect(updated.config.timeoutMs).toBe(7000)
  })

  test('update: type change rejected', async () => {
    await createMcp(db, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await expect(
      updateMcp(db, 'm', { type: 'remote', config: { url: 'https://x.io' } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('update: invalid config payload rejected', async () => {
    await createMcp(db, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await expect(
      updateMcp(db, 'm', { type: 'local', config: { command: [] } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('update on missing mcp → NotFoundError', async () => {
    await expect(updateMcp(db, 'nope', { description: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete: happy path when no agents reference it', async () => {
    await createMcp(db, {
      name: 'lonely',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await deleteMcp(db, 'lonely')
    expect(await getMcp(db, 'lonely')).toBeNull()
  })

  test('delete on missing mcp → NotFoundError', async () => {
    await expect(deleteMcp(db, 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('services/mcp.ts reference cascade', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('findAgentsReferencingMcp: exact match, no substring false-positives', async () => {
    await createMcp(db, {
      name: 'sentry',
      description: '',
      type: 'remote',
      config: { url: 'https://s.io' },
      enabled: true,
    })
    await createMcp(db, {
      name: 'sentry-staging',
      description: '',
      type: 'remote',
      config: { url: 'https://s.io' },
      enabled: true,
    })
    await createAgent(db, {
      name: 'a-prod',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['sentry'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'a-staging',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['sentry-staging'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const refs = await findAgentsReferencingMcp(db, 'sentry')
    expect(refs).toEqual([{ id: expect.any(String), name: 'a-prod' }])
  })

  test('delete with references → ConflictError + referencedBy', async () => {
    await createMcp(db, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['m'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    let err: unknown
    try {
      await deleteMcp(db, 'm')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConflictError)
    if (err instanceof ConflictError) {
      expect(err.code).toBe('mcp-still-referenced')
      const refs = (err.details as { referencedBy: { name: string }[] }).referencedBy
      expect(refs.map((r) => r.name)).toEqual(['consumer'])
    }
  })

  test('rename: cascades into agents.mcp array atomically', async () => {
    await createMcp(db, {
      name: 'old-name',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    // T5 save-time guard: also seed the unrelated MCPs that the consumer
    // agents reference, otherwise createAgent rejects with mcp-not-found.
    await createMcp(db, {
      name: 'other',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(db, {
      name: 'other-mcp',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createAgent(db, {
      name: 'consumer-1',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['old-name', 'other'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'consumer-2',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['old-name'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'unrelated',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['other-mcp'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const renamed = await renameMcp(db, 'old-name', { newName: 'new-name' })
    expect(renamed.name).toBe('new-name')

    const a1 = await getAgent(db, 'consumer-1')
    const a2 = await getAgent(db, 'consumer-2')
    const a3 = await getAgent(db, 'unrelated')
    expect(a1?.mcp).toEqual(['new-name', 'other'])
    expect(a2?.mcp).toEqual(['new-name'])
    expect(a3?.mcp).toEqual(['other-mcp'])

    // old name should be gone, new name resolvable
    expect(await getMcp(db, 'old-name')).toBeNull()
    expect(await getMcp(db, 'new-name')).not.toBeNull()
  })

  test('rename: identical name is a no-op', async () => {
    const m = await createMcp(db, {
      name: 'same',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const renamed = await renameMcp(db, 'same', { newName: 'same' })
    expect(renamed.id).toBe(m.id)
  })

  test('rename: target name conflict → ConflictError', async () => {
    await createMcp(db, {
      name: 'a',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(db, {
      name: 'b',
      description: '',
      type: 'local',
      config: { command: ['y'] },
      enabled: true,
    })
    await expect(renameMcp(db, 'a', { newName: 'b' })).rejects.toBeInstanceOf(ConflictError)
  })

  test('rename: missing source → NotFoundError', async () => {
    await expect(renameMcp(db, 'gone', { newName: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })
})
