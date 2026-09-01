// RFC-028 T3 — services/mcp.ts CRUD + reference cascade.
//
// Locks: create → list → get → update → rename → delete happy path; canonical
// id addressing; type immutability; still-referenced delete guard; name
// conflict; rename leaves id-based references untouched.

import { buildActor } from '../src/auth/actor'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import { composeMcpCatalog } from '../src/modules/resource-catalog/composition/mcpOperations'
import { createSqliteMcpRepository } from '../src/modules/resource-catalog/infrastructure/sqliteMcpRepository'
import type { McpCatalogModule } from '../src/modules/resource-catalog/public/operations'
import type { McpOperationContext } from '../src/modules/resource-catalog/public/participants'
import { createAgent } from '../src/services/agent'
import {
  createMcpForTest as createMcp,
  deleteMcpForTest as deleteMcp,
  listMcpsForTest as listMcps,
  renameMcpForTest as renameMcp,
  type McpCatalogTestBinding as McpServiceBinding,
  updateMcpForTest as updateMcp,
} from './helpers/mcpServiceBinding'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'
import { getAgent, getMcp } from './helpers/resourceLookup'
import { ConflictError, NotFoundError, ValidationError } from '../src/util/errors'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function authorityFor(userId: string, role: 'admin' | 'user' = 'admin'): McpOperationContext {
  const projection = buildActor({
    user: { id: userId, username: userId, displayName: userId, role, status: 'active' },
    source: 'session',
  })
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId, source: 'session' },
    { ...projection, userId },
  ).actor
}

function composeTestMcpCatalog(db: DbClient): McpCatalogModule {
  return composeMcpCatalog({
    db,
    coordinator: new ResourceOperationCoordinator(),
    nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
    runtime: Object.freeze({
      prepareDelete: async () => undefined,
      reconcileDurableIntents: async () => undefined,
    }),
    transitionMutationInTx: () => undefined,
    deletePreparedInTx: () => undefined,
  })
}

function serviceBinding(
  catalog: McpCatalogModule,
  userId = 'u-t6-test',
  role: 'admin' | 'user' = 'admin',
): McpServiceBinding {
  return Object.freeze({ catalog, authority: authorityFor(userId, role) })
}

function findAgentReferences(db: DbClient, mcpId: string) {
  return createSqliteMcpRepository({
    db,
    lifecycle: Object.freeze({
      transitionMutation: () => undefined,
      deletePrepared: () => undefined,
    }),
  }).repository.findAgentReferences(mcpId)
}

function localMcp(name: string): Parameters<typeof createMcp>[1] {
  return {
    name,
    description: '',
    type: 'local',
    config: { command: ['x'] },
    enabled: true,
  }
}

describe('services/mcp.ts CRUD', () => {
  let db: DbClient
  let catalog: McpCatalogModule
  let binding: McpServiceBinding
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    catalog = composeTestMcpCatalog(db)
    binding = serviceBinding(catalog)
  })

  test('create + get round-trip (local)', async () => {
    const m = await createMcp(binding, {
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
    const m = await createMcp(binding, {
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
    await createMcp(binding, {
      name: 'a',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(binding, {
      name: 'b',
      description: '',
      type: 'remote',
      config: { url: 'https://b.io' },
      enabled: false,
    })
    const list = await listMcps(binding)
    expect(list.map((m) => m.name).sort()).toEqual(['a', 'b'])
    expect(list.find((m) => m.name === 'b')?.enabled).toBe(false)
  })

  test('name conflict on create → 409 mcp-name-in-use', async () => {
    await createMcp(binding, {
      name: 'dup',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await expect(
      createMcp(binding, {
        name: 'dup',
        description: '',
        type: 'remote',
        config: { url: 'https://x.io' },
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('RFC-223 scopes create and rename conflicts to the owner bucket', async () => {
    const ownerA = serviceBinding(catalog, 'owner-a', 'user')
    const ownerB = serviceBinding(catalog, 'owner-b', 'user')
    const ownerC = serviceBinding(catalog, 'owner-c', 'user')
    const source = await createMcp(ownerA, localMcp('source'))
    await createMcp(ownerB, localMcp('shared'))

    await expect(renameMcp(ownerA, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })

    await createMcp(ownerA, localMcp('taken'))
    await expect(renameMcp(ownerA, source.id, { newName: 'taken' })).rejects.toMatchObject({
      code: 'mcp-name-in-use',
    })
    await expect(createMcp(ownerA, localMcp('taken'))).rejects.toMatchObject({
      code: 'mcp-name-in-use',
    })

    await expect(createMcp(ownerC, localMcp('shared'))).resolves.toMatchObject({
      name: 'shared',
      ownerUserId: 'owner-c',
    })
    await expect(renameMcp(ownerA, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })
  })

  test('RFC-223 maps a same-owner create race to one stable 409 conflict', async () => {
    const results = await Promise.allSettled([
      createMcp(serviceBinding(catalog, 'owner-a', 'user'), localMcp('raced')),
      createMcp(serviceBinding(catalog, 'owner-a', 'user'), localMcp('raced')),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({ code: 'mcp-name-in-use', status: 409 })
  })

  test('update: description + enabled patch', async () => {
    const created = await createMcp(binding, {
      name: 'm',
      description: 'old',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const updated = await updateMcp(binding, created.id, { description: 'new', enabled: false })
    expect(updated.description).toBe('new')
    expect(updated.enabled).toBe(false)
  })

  test('update: config replacement (local)', async () => {
    const created = await createMcp(binding, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const updated = await updateMcp(binding, created.id, {
      type: 'local',
      config: { command: ['y', '-v'], env: { K: 'v' }, timeoutMs: 7000 },
    })
    if (updated.type !== 'local') throw new Error('type changed unexpectedly')
    expect(updated.config.command).toEqual(['y', '-v'])
    expect(updated.config.timeoutMs).toBe(7000)
  })

  test('update: type change rejected', async () => {
    const created = await createMcp(binding, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await expect(
      updateMcp(binding, created.id, { type: 'remote', config: { url: 'https://x.io' } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('update: invalid config payload rejected', async () => {
    const created = await createMcp(binding, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await expect(
      updateMcp(binding, created.id, { type: 'local', config: { command: [] } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('update on missing mcp → NotFoundError', async () => {
    await expect(updateMcp(binding, 'nope', { description: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('delete: happy path when no agents reference it', async () => {
    const created = await createMcp(binding, {
      name: 'lonely',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await deleteMcp(binding, created.id)
    expect(await getMcp(db, 'lonely')).toBeNull()
  })

  test('delete on missing mcp → NotFoundError', async () => {
    await expect(deleteMcp(binding, 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('services/mcp.ts reference cascade', () => {
  let db: DbClient
  let catalog: McpCatalogModule
  let binding: McpServiceBinding
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    catalog = composeTestMcpCatalog(db)
    binding = serviceBinding(catalog)
  })

  // RFC-223 (PR-1): agents.mcp stores mcp IDS, so the reverse lookup keys on the
  // mcp id — only the agent that references THIS id is returned.
  test('findAgentsReferencingMcp: matches by id, not another mcp', async () => {
    const sentry = await createMcp(binding, {
      name: 'sentry',
      description: '',
      type: 'remote',
      config: { url: 'https://s.io' },
      enabled: true,
    })
    const staging = await createMcp(binding, {
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
      mcp: [sentry.id],
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
      mcp: [staging.id],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const refs = await findAgentReferences(db, sentry.id)
    expect(refs).toEqual([
      { id: expect.any(String), name: 'a-prod', ownerUserId: null, visibility: 'private' },
    ])
    // The other mcp's id resolves to its own consumer only.
    expect((await findAgentReferences(db, staging.id)).map((r) => r.name)).toEqual(['a-staging'])
  })

  test('delete with references → ConflictError + principal-aware visible list', async () => {
    const mcp = await createMcp(binding, {
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
      mcp: [mcp.id],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    let err: unknown
    try {
      await deleteMcp(binding, mcp.id)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConflictError)
    if (err instanceof ConflictError) {
      expect(err.code).toBe('mcp-still-referenced')
      const refs = (err.details as { visible: { name: string }[] }).visible
      expect(refs.map((r) => r.name)).toEqual(['consumer'])
    }
  })

  // RFC-223 (PR-1 / D7): a rename NO LONGER cascades — agents.mcp stores the mcp
  // ID, which is stable across the rename, so referencing rows are untouched and
  // still resolve the (now-renamed) mcp by id.
  test('rename: does NOT rewrite agents.mcp (ids are stable)', async () => {
    const oldMcp = await createMcp(binding, {
      name: 'old-name',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    // T5 save-time guard: also seed the unrelated MCPs that the consumer
    // agents reference, otherwise createAgent rejects with mcp-not-found.
    const other = await createMcp(binding, {
      name: 'other',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const otherMcp = await createMcp(binding, {
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
      mcp: [oldMcp.id, other.id],
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
      mcp: [oldMcp.id],
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
      mcp: [otherMcp.id],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const renamed = await renameMcp(binding, oldMcp.id, { newName: 'new-name' })
    expect(renamed.name).toBe('new-name')

    const a1 = await getAgent(db, 'consumer-1')
    const a2 = await getAgent(db, 'consumer-2')
    const a3 = await getAgent(db, 'unrelated')
    // Ids unchanged by the rename — no cascade.
    expect(a1?.mcp).toEqual([oldMcp.id, other.id])
    expect(a2?.mcp).toEqual([oldMcp.id])
    expect(a3?.mcp).toEqual([otherMcp.id])

    // old name should be gone, new name resolvable → same id.
    expect(await getMcp(db, 'old-name')).toBeNull()
    expect((await getMcp(db, 'new-name'))?.id).toBe(oldMcp.id)
  })

  test('rename: identical name is a no-op', async () => {
    const m = await createMcp(binding, {
      name: 'same',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const renamed = await renameMcp(binding, m.id, { newName: 'same' })
    expect(renamed.id).toBe(m.id)
  })

  test('rename: target name conflict → ConflictError', async () => {
    const a = await createMcp(binding, {
      name: 'a',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(binding, {
      name: 'b',
      description: '',
      type: 'local',
      config: { command: ['y'] },
      enabled: true,
    })
    await expect(renameMcp(binding, a.id, { newName: 'b' })).rejects.toBeInstanceOf(ConflictError)
  })

  test('rename: missing source → NotFoundError', async () => {
    await expect(renameMcp(binding, 'gone', { newName: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })
})
