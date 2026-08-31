// RFC-342 / RFC-294 P0-A — Memory scope moves are a dedicated OCC command.
//
// These tests lock the command boundary, old+new scope authorization, durable
// event atomicity, mutation races, and the eventual prompt-injection audience.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { MemoryWsMessage } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  cachedRepos,
  memories,
  memoryScopeMoveEvents,
  repoGroups,
  resourceGrants,
  workflows,
} from '../src/db/schema'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import type {
  CommandContext,
  PrincipalSource,
} from '../src/modules/identity-access/public/participants'
import {
  createManualCandidate,
  getMemoryById,
  moveMemory as moveMemoryWithAuthorization,
  promoteCandidate,
} from '../src/services/memory'
import { loadInjectableMemories } from '../src/services/memoryInject'
import { createUser } from '../src/services/users'
import { MEMORY_CHANNEL, memoryBroadcaster, resetBroadcastersForTests } from '../src/ws/broadcaster'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './helpers/resourceScopeAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_789_747_212_066

function moveMemory(
  db: Parameters<typeof moveMemoryWithAuthorization>[0],
  contexts: Parameters<typeof moveMemoryWithAuthorization>[1],
  context: Parameters<typeof moveMemoryWithAuthorization>[2],
  id: Parameters<typeof moveMemoryWithAuthorization>[4],
  input: Parameters<typeof moveMemoryWithAuthorization>[5],
  hooks?: Parameters<typeof moveMemoryWithAuthorization>[6],
) {
  return moveMemoryWithAuthorization(
    db,
    contexts,
    context,
    TEST_RESOURCE_SCOPE_AUTHORIZATION,
    id,
    input,
    hooks,
  )
}

function captureBroadcasts(): { messages: MemoryWsMessage[]; stop: () => void } {
  const messages: MemoryWsMessage[] = []
  const stop = memoryBroadcaster.subscribe(MEMORY_CHANNEL, (message) => messages.push(message))
  return { messages, stop }
}

describe('RFC-342 memory scope move correctness', () => {
  let db: DbClient
  let contexts: ReturnType<typeof composeIdentityAccess>['contexts']
  let ownerId = ''
  let otherOwnerId = ''
  let editorId = ''
  let readerId = ''
  let managerId = ''
  let agentId = ''
  let workflowId = ''
  let foreignWorkflowId = ''
  let repoId = ''
  let repoGroupId = ''

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    contexts = composeIdentityAccess(db).contexts
    resetBroadcastersForTests()

    const makeUser = async (username: string, role: 'user' | 'manager'): Promise<string> =>
      (
        await createUser(db, {
          username,
          displayName: username,
          role,
          password: 'pw12345678',
        })
      ).id
    ownerId = await makeUser('move-owner', 'user')
    otherOwnerId = await makeUser('move-other-owner', 'user')
    editorId = await makeUser('move-editor', 'user')
    readerId = await makeUser('move-reader', 'user')
    managerId = await makeUser('move-manager', 'manager')

    agentId = ulid()
    workflowId = ulid()
    foreignWorkflowId = ulid()
    repoId = ulid()
    repoGroupId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: `rfc342-agent-${agentId.slice(-6)}`,
      description: '',
      ownerUserId: ownerId,
      visibility: 'private',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(workflows).values([
      {
        id: workflowId,
        name: `rfc342-workflow-${workflowId.slice(-6)}`,
        description: '',
        definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
        version: 1,
        ownerUserId: ownerId,
        visibility: 'private',
        aclRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: foreignWorkflowId,
        name: `rfc342-foreign-${foreignWorkflowId.slice(-6)}`,
        description: '',
        definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
        version: 1,
        ownerUserId: otherOwnerId,
        visibility: 'public',
        aclRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
    await db.insert(cachedRepos).values({
      id: repoId,
      urlHash: repoId.slice(-8).toLowerCase(),
      urlRedacted: 'https://example.invalid/org/repo.git',
      localPath: `/tmp/rfc342-${repoId}`,
      defaultBranch: 'main',
      lastFetchedAt: NOW,
      createdAt: NOW,
    })
    await db.insert(repoGroups).values({
      id: repoGroupId,
      name: `rfc342-group-${repoGroupId.slice(-6)}`,
      description: '',
      version: 1,
      createdByUserId: managerId,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    })
    await db.insert(resourceGrants).values([
      {
        resourceType: 'agent',
        resourceId: agentId,
        userId: editorId,
        level: 'write',
        addedBy: ownerId,
        addedAt: NOW,
      },
      {
        resourceType: 'workflow',
        resourceId: workflowId,
        userId: editorId,
        level: 'write',
        addedBy: ownerId,
        addedAt: NOW,
      },
      {
        resourceType: 'agent',
        resourceId: agentId,
        userId: readerId,
        level: 'read',
        addedBy: ownerId,
        addedAt: NOW,
      },
      {
        resourceType: 'workflow',
        resourceId: workflowId,
        userId: readerId,
        level: 'write',
        addedBy: ownerId,
        addedAt: NOW,
      },
    ])
  })

  function contextFor(userId: string, source: PrincipalSource = 'session'): CommandContext {
    return contexts.fromAuthenticatedPrincipal({ userId, source }, 'http', NOW)
  }

  async function candidateAt(
    scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global',
    scopeId: string | null,
  ) {
    return createManualCandidate(db, {
      scopeType,
      scopeId,
      title: `move-${scopeType}`,
      bodyMd: `body-${scopeType}`,
    })
  }

  test('owner move atomically writes scope+version+durable event, then emits WS', async () => {
    const memory = await candidateAt('agent', agentId)
    const context = contextFor(ownerId)
    const capture = captureBroadcasts()

    const result = moveMemory(db, contexts, context, memory.id, {
      expectedVersion: memory.version,
      scopeType: 'workflow',
      scopeId: workflowId,
    })
    capture.stop()

    expect(result).toMatchObject({
      moved: true,
      memory: { scopeType: 'workflow', scopeId: workflowId, version: memory.version + 1 },
    })
    const events = await db
      .select()
      .from(memoryScopeMoveEvents)
      .where(eq(memoryScopeMoveEvents.memoryId, memory.id))
    expect(events).toEqual([
      expect.objectContaining({
        id: context.operationId,
        memoryId: memory.id,
        actorUserId: ownerId,
        actorSource: 'session',
        fromScopeType: 'agent',
        fromScopeId: agentId,
        toScopeType: 'workflow',
        toScopeId: workflowId,
        expectedVersion: memory.version,
        resultingVersion: memory.version + 1,
        correlationId: context.correlationId,
        occurredAt: NOW,
      }),
    ])
    expect(capture.messages.filter((message) => message.type === 'memory.updated')).toEqual([
      {
        type: 'memory.updated',
        memoryId: memory.id,
        changedFields: ['scopeType', 'scopeId'],
        version: memory.version + 1,
      },
    ])
  })

  test('old and destination scopes both require current write authority', async () => {
    const foreignDestination = await candidateAt('agent', agentId)
    expect(() =>
      moveMemory(db, contexts, contextFor(ownerId), foreignDestination.id, {
        expectedVersion: foreignDestination.version,
        scopeType: 'workflow',
        scopeId: foreignWorkflowId,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-forbidden' }))

    const readOnlyCurrent = await candidateAt('agent', agentId)
    expect(() =>
      moveMemory(db, contexts, contextFor(readerId), readOnlyCurrent.id, {
        expectedVersion: readOnlyCurrent.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-forbidden' }))

    for (const memory of [foreignDestination, readOnlyCurrent]) {
      expect((await getMemoryById(db, memory.id))?.memory).toMatchObject({
        scopeType: 'agent',
        scopeId: agentId,
        version: memory.version,
      })
    }
    expect(await db.select().from(memoryScopeMoveEvents)).toEqual([])
  })

  test('write grants permit agent→workflow, but ordinary users cannot cross to global', async () => {
    const granted = await candidateAt('agent', agentId)
    const moved = moveMemory(db, contexts, contextFor(editorId), granted.id, {
      expectedVersion: granted.version,
      scopeType: 'workflow',
      scopeId: workflowId,
    })
    expect(moved.memory).toMatchObject({ scopeType: 'workflow', scopeId: workflowId })

    const globalAttempt = await candidateAt('agent', agentId)
    expect(() =>
      moveMemory(db, contexts, contextFor(ownerId), globalAttempt.id, {
        expectedVersion: globalAttempt.version,
        scopeType: 'global',
        scopeId: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-forbidden' }))
  })

  test('session bypass can move global→repo→repo_group, while the same account PAT cannot borrow bypass', async () => {
    const memory = await candidateAt('global', null)
    expect(() =>
      moveMemory(db, contexts, contextFor(managerId, 'pat'), memory.id, {
        expectedVersion: memory.version,
        scopeType: 'repo',
        scopeId: repoId,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-forbidden' }))

    const result = moveMemory(db, contexts, contextFor(managerId), memory.id, {
      expectedVersion: memory.version,
      scopeType: 'repo',
      scopeId: repoId,
    })
    expect(result.memory).toMatchObject({ scopeType: 'repo', scopeId: repoId, version: 2 })

    const grouped = moveMemory(db, contexts, contextFor(managerId), memory.id, {
      expectedVersion: result.memory.version,
      scopeType: 'repo_group',
      scopeId: repoGroupId,
    })
    expect(grouped.memory).toMatchObject({
      scopeType: 'repo_group',
      scopeId: repoGroupId,
      version: 3,
    })
  })

  test('destination target must exist, including bypass-managed repo scope', async () => {
    const memory = await candidateAt('global', null)
    expect(() =>
      moveMemory(db, contexts, contextFor(managerId), memory.id, {
        expectedVersion: memory.version,
        scopeType: 'repo',
        scopeId: 'missing-repo',
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-target-not-found' }))
  })

  test('stale memory revision and approved/archived states cannot move', async () => {
    const stale = await candidateAt('agent', agentId)
    expect(() =>
      moveMemory(db, contexts, contextFor(ownerId), stale.id, {
        expectedVersion: stale.version + 1,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
    ).toThrow(expect.objectContaining({ code: 'resource-operation-stale' }))

    const approved = await candidateAt('agent', agentId)
    await promoteCandidate(db, approved.id, { action: 'approve' }, ownerId)
    expect(() =>
      moveMemory(db, contexts, contextFor(ownerId), approved.id, {
        expectedVersion: approved.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-move-status-forbidden' }))

    await db.update(memories).set({ status: 'archived' }).where(eq(memories.id, approved.id))
    expect(() =>
      moveMemory(db, contexts, contextFor(ownerId), approved.id, {
        expectedVersion: approved.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-move-status-forbidden' }))
  })

  test('same-scope no-op does not bump version, append event, or emit WS', async () => {
    const memory = await candidateAt('agent', agentId)
    const capture = captureBroadcasts()
    const result = moveMemory(db, contexts, contextFor(ownerId), memory.id, {
      expectedVersion: memory.version,
      scopeType: 'agent',
      scopeId: agentId,
    })
    capture.stop()
    expect(result).toMatchObject({ moved: false, memory: { version: memory.version } })
    expect(await db.select().from(memoryScopeMoveEvents)).toEqual([])
    expect(capture.messages.some((message) => message.type === 'memory.updated')).toBe(false)
  })

  test('target deletion between authorization and CAS rolls back target mutation with no ghost event', async () => {
    const memory = await candidateAt('agent', agentId)
    const capture = captureBroadcasts()
    expect(() =>
      moveMemory(
        db,
        contexts,
        contextFor(ownerId),
        memory.id,
        {
          expectedVersion: memory.version,
          scopeType: 'workflow',
          scopeId: workflowId,
        },
        {
          afterMoveAuthorizationInTx: (tx) => {
            tx.delete(workflows).where(eq(workflows.id, workflowId)).run()
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-target-not-found' }))
    capture.stop()

    expect((await db.select().from(workflows).where(eq(workflows.id, workflowId))).length).toBe(1)
    expect((await getMemoryById(db, memory.id))?.memory).toMatchObject({
      scopeType: 'agent',
      scopeId: agentId,
      version: memory.version,
    })
    expect(await db.select().from(memoryScopeMoveEvents)).toEqual([])
    expect(capture.messages.some((message) => message.type === 'memory.updated')).toBe(false)
  })

  test('authority drift is re-read in-tx and the simulated grant removal rolls back', async () => {
    const memory = await candidateAt('agent', agentId)
    expect(() =>
      moveMemory(
        db,
        contexts,
        contextFor(editorId),
        memory.id,
        {
          expectedVersion: memory.version,
          scopeType: 'workflow',
          scopeId: workflowId,
        },
        {
          afterMoveAuthorizationInTx: (tx) => {
            tx.delete(resourceGrants)
              .where(
                and(
                  eq(resourceGrants.resourceType, 'workflow'),
                  eq(resourceGrants.resourceId, workflowId),
                  eq(resourceGrants.userId, editorId),
                ),
              )
              .run()
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'memory-scope-target-not-found' }))

    const grants = await db
      .select()
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, 'workflow'),
          eq(resourceGrants.resourceId, workflowId),
          eq(resourceGrants.userId, editorId),
        ),
      )
    expect(grants).toHaveLength(1)
    expect(await db.select().from(memoryScopeMoveEvents)).toEqual([])
  })

  test('memory mutation race and post-write fault roll back scope, receipt, and WS', async () => {
    const raced = await candidateAt('agent', agentId)
    expect(() =>
      moveMemory(
        db,
        contexts,
        contextFor(ownerId),
        raced.id,
        {
          expectedVersion: raced.version,
          scopeType: 'workflow',
          scopeId: workflowId,
        },
        {
          afterMoveAuthorizationInTx: (tx) => {
            tx.update(memories).set({ version: 99 }).where(eq(memories.id, raced.id)).run()
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'resource-operation-stale' }))
    expect((await getMemoryById(db, raced.id))?.memory.version).toBe(raced.version)

    const faulted = await candidateAt('agent', agentId)
    const capture = captureBroadcasts()
    expect(() =>
      moveMemory(
        db,
        contexts,
        contextFor(ownerId),
        faulted.id,
        {
          expectedVersion: faulted.version,
          scopeType: 'workflow',
          scopeId: workflowId,
        },
        {
          afterWriteInTx: () => {
            throw new Error('rollback-after-move-write')
          },
        },
      ),
    ).toThrow('rollback-after-move-write')
    capture.stop()
    expect((await getMemoryById(db, faulted.id))?.memory).toMatchObject({
      scopeType: 'agent',
      scopeId: agentId,
      version: faulted.version,
    })
    expect(await db.select().from(memoryScopeMoveEvents)).toEqual([])
    expect(capture.messages.some((message) => message.type === 'memory.updated')).toBe(false)
  })

  test('forged serialized command context is rejected before any database mutation', async () => {
    const memory = await candidateAt('agent', agentId)
    const forged = {
      authority: {},
      operationId: 'forged-operation',
      correlationId: 'forged-correlation',
      now: NOW,
    } as unknown as CommandContext
    expect(() =>
      moveMemory(db, contexts, forged, memory.id, {
        expectedVersion: memory.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
    ).toThrow('untrusted-operation-context')
    expect(await db.select().from(memoryScopeMoveEvents)).toEqual([])
  })

  test('after move+approval, prompt injection sees only the new scope audience', async () => {
    const memory = await candidateAt('agent', agentId)
    const moved = moveMemory(db, contexts, contextFor(ownerId), memory.id, {
      expectedVersion: memory.version,
      scopeType: 'workflow',
      scopeId: workflowId,
    })
    await promoteCandidate(db, moved.memory.id, { action: 'approve' }, ownerId)

    const oldAudience = await loadInjectableMemories(db, {
      agentIds: [agentId],
      workflowId: null,
      repoIds: [],
      repoGroupId: null,
    })
    const newAudience = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId,
      repoIds: [],
      repoGroupId: null,
    })
    expect(oldAudience.byScope.agent.map((item) => item.id)).not.toContain(memory.id)
    expect(newAudience.byScope.workflow.map((item) => item.id)).toEqual([memory.id])
  })
})
