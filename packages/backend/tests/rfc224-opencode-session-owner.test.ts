// RFC-224 T14 — locks the pre-prompt owner barrier and single-writer lease:
// new is one owner+run transaction; resume acquires before store access and
// only links the run after the same nonce returns; release/repair are triple CAS.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, opencodeSessionOwners, tasks, workflows } from '../src/db/schema'
import {
  claimNewOpencodeSession,
  confirmOpencodeSessionResume,
  getOpencodeSessionOwner,
  OpencodeSessionOwnerError,
  preclaimOpencodeSessionResume,
  releaseOpencodeSessionLease,
  repairOpencodeSessionLease,
  type NewOpencodeSessionClaim,
  type OpencodeSessionOwnerImmutable,
} from '../src/services/opencodeSessionOwner'
import { resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient, taskId = 'task-a'): Promise<void> {
  await db.insert(workflows).values({
    id: `workflow-${taskId}`,
    name: `workflow-${taskId}`,
    definition: '{}',
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `workflow-${taskId}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `aw/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
}

async function seedRun(
  db: DbClient,
  input: {
    id: string
    taskId?: string
    nodeId?: string
    status?: 'pending' | 'running' | 'done' | 'failed' | 'canceled' | 'interrupted'
  },
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: input.id,
    taskId: input.taskId ?? 'task-a',
    nodeId: input.nodeId ?? 'node-a',
    status: input.status ?? 'running',
  })
}

function newClaim(overrides: Partial<NewOpencodeSessionClaim> = {}): NewOpencodeSessionClaim {
  return {
    sessionId: 'session-a',
    taskId: 'task-a',
    nodeId: 'node-a',
    currentNodeRunId: 'run-created',
    identityDigest: 'identity-a',
    officialBuildDigest: 'build-a',
    sessionContractDigest: 'contract-a',
    sessionStoreKey: 'store-a',
    projectId: 'project-a',
    opencodeVersion: '1.18.3',
    leaseNonceDigest: 'nonce-a',
    leasedAt: 100,
    ...overrides,
  }
}

function immutableOf(input: NewOpencodeSessionClaim): OpencodeSessionOwnerImmutable {
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    nodeId: input.nodeId,
    createdNodeRunId: input.currentNodeRunId,
    identityDigest: input.identityDigest,
    officialBuildDigest: input.officialBuildDigest,
    sessionContractDigest: input.sessionContractDigest,
    sessionStoreKey: input.sessionStoreKey,
    projectId: input.projectId,
    opencodeVersion: input.opencodeVersion,
  }
}

function expectOwnerError(fn: () => unknown, reason: OpencodeSessionOwnerError['reason']): void {
  try {
    fn()
    throw new Error('expected OpencodeSessionOwnerError')
  } catch (error) {
    expect(error).toBeInstanceOf(OpencodeSessionOwnerError)
    expect((error as OpencodeSessionOwnerError).reason).toBe(reason)
    expect((error as OpencodeSessionOwnerError).message).toBe('execution-identity-session-mismatch')
  }
}

describe('RFC-224 OpenCode session owner service', () => {
  test('new marker atomically inserts owner+lease and CAS-links exactly one running run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-created' })

    const owner = claimNewOpencodeSession(db, newClaim())
    expect(owner).toMatchObject({
      sessionId: 'session-a',
      createdNodeRunId: 'run-created',
      sessionContractDigest: 'contract-a',
      leaseNodeRunId: 'run-created',
      leaseNonceDigest: 'nonce-a',
      leasedAt: 100,
    })
    expect(getOpencodeSessionOwner(db, 'session-a')).toEqual(owner)
    expect(
      await db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-created'))
        .get(),
    ).toEqual({ sessionId: 'session-a' })

    await seedRun(db, { id: 'run-not-running', status: 'pending' })
    expectOwnerError(
      () =>
        claimNewOpencodeSession(
          db,
          newClaim({
            sessionId: 'session-rollback',
            sessionStoreKey: 'store-rollback',
            currentNodeRunId: 'run-not-running',
          }),
        ),
      'run-not-claimable',
    )
    expect(getOpencodeSessionOwner(db, 'session-rollback')).toBeUndefined()
  })

  test('new claim rejects both duplicate session and aliased private store without linking losers', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-created' })
    await seedRun(db, { id: 'run-session-loser' })
    await seedRun(db, { id: 'run-store-loser' })
    claimNewOpencodeSession(db, newClaim())

    expectOwnerError(
      () =>
        claimNewOpencodeSession(
          db,
          newClaim({
            currentNodeRunId: 'run-session-loser',
            sessionStoreKey: 'different-store',
          }),
        ),
      'owner-conflict',
    )
    expectOwnerError(
      () =>
        claimNewOpencodeSession(
          db,
          newClaim({
            sessionId: 'different-session',
            currentNodeRunId: 'run-store-loser',
          }),
        ),
      'owner-conflict',
    )
    expect(
      await db
        .select({ id: nodeRuns.id, sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, 'task-a')),
    ).toEqual([
      { id: 'run-created', sessionId: 'session-a' },
      { id: 'run-session-loser', sessionId: null },
      { id: 'run-store-loser', sessionId: null },
    ])
  })

  test('resume preclaims exact immutable provenance before linking the current run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-created' })
    await seedRun(db, { id: 'run-resume' })
    await seedRun(db, { id: 'run-loser' })
    const initial = newClaim()
    claimNewOpencodeSession(db, initial)
    expect(
      releaseOpencodeSessionLease(db, {
        sessionId: initial.sessionId,
        nodeRunId: initial.currentNodeRunId,
        leaseNonceDigest: initial.leaseNonceDigest,
      }),
    ).toBe(true)

    const immutable = immutableOf(initial)
    const claimed = preclaimOpencodeSessionResume(db, {
      ...immutable,
      currentNodeRunId: 'run-resume',
      leaseNonceDigest: 'nonce-resume',
      leasedAt: 200,
    })
    expect(claimed).toMatchObject({
      leaseNodeRunId: 'run-resume',
      leaseNonceDigest: 'nonce-resume',
      leasedAt: 200,
    })
    expect(
      await db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-resume'))
        .get(),
    ).toEqual({ sessionId: null })

    expectOwnerError(
      () =>
        preclaimOpencodeSessionResume(db, {
          ...immutable,
          currentNodeRunId: 'run-loser',
          leaseNonceDigest: 'nonce-loser',
        }),
      'lease-held',
    )
    expectOwnerError(
      () =>
        confirmOpencodeSessionResume(db, {
          sessionId: initial.sessionId,
          nodeRunId: 'run-resume',
          leaseNonceDigest: 'wrong-nonce',
        }),
      'lease-mismatch',
    )

    confirmOpencodeSessionResume(db, {
      sessionId: initial.sessionId,
      nodeRunId: 'run-resume',
      leaseNonceDigest: 'nonce-resume',
    })
    expect(
      await db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-resume'))
        .get(),
    ).toEqual({ sessionId: 'session-a' })
  })

  test('resume rejects any immutable drift, including the canonical session contract digest', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-created' })
    await seedRun(db, { id: 'run-resume' })
    const initial = newClaim()
    claimNewOpencodeSession(db, initial)
    releaseOpencodeSessionLease(db, {
      sessionId: initial.sessionId,
      nodeRunId: initial.currentNodeRunId,
      leaseNonceDigest: initial.leaseNonceDigest,
    })

    expectOwnerError(
      () =>
        preclaimOpencodeSessionResume(db, {
          ...immutableOf(initial),
          sessionContractDigest: 'contract-drift',
          currentNodeRunId: 'run-resume',
          leaseNonceDigest: 'nonce-resume',
        }),
      'owner-mismatch',
    )
    expect(getOpencodeSessionOwner(db, initial.sessionId)).toMatchObject({
      leaseNodeRunId: null,
      leaseNonceDigest: null,
      leasedAt: null,
    })
  })

  test('release and terminal repair use triple CAS and prevent delayed-cleanup ABA', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-created' })
    await seedRun(db, { id: 'run-resume' })
    const initial = newClaim()
    claimNewOpencodeSession(db, initial)
    const tokenA = {
      sessionId: initial.sessionId,
      nodeRunId: initial.currentNodeRunId,
      leaseNonceDigest: initial.leaseNonceDigest,
    }

    expect(releaseOpencodeSessionLease(db, { ...tokenA, leaseNonceDigest: 'wrong' })).toBe(false)
    expect(repairOpencodeSessionLease(db, { ...tokenA, processGroupDead: true })).toBe(false)

    await db
      .update(nodeRuns)
      .set({ status: 'failed' })
      .where(eq(nodeRuns.id, initial.currentNodeRunId))
    expect(repairOpencodeSessionLease(db, { ...tokenA, processGroupDead: true })).toBe(true)

    preclaimOpencodeSessionResume(db, {
      ...immutableOf(initial),
      currentNodeRunId: 'run-resume',
      leaseNonceDigest: 'nonce-b',
      leasedAt: 300,
    })
    expect(releaseOpencodeSessionLease(db, tokenA)).toBe(false)
    expect(getOpencodeSessionOwner(db, initial.sessionId)).toMatchObject({
      leaseNodeRunId: 'run-resume',
      leaseNonceDigest: 'nonce-b',
      leasedAt: 300,
    })

    confirmOpencodeSessionResume(db, {
      sessionId: initial.sessionId,
      nodeRunId: 'run-resume',
      leaseNonceDigest: 'nonce-b',
    })
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, 'run-resume'))
    expect(
      repairOpencodeSessionLease(db, {
        sessionId: initial.sessionId,
        nodeRunId: 'run-resume',
        leaseNonceDigest: 'nonce-b',
        processGroupDead: true,
      }),
    ).toBe(true)
    expect(getOpencodeSessionOwner(db, initial.sessionId)).toMatchObject({
      leaseNodeRunId: null,
      leaseNonceDigest: null,
      leasedAt: null,
    })

    const history = await db
      .select({ id: nodeRuns.id, sessionId: nodeRuns.opencodeSessionId })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, 'task-a'))
    expect(history).toEqual([
      { id: 'run-created', sessionId: 'session-a' },
      { id: 'run-resume', sessionId: 'session-a' },
    ])
    expect(await db.select().from(opencodeSessionOwners)).toHaveLength(1)
  })
})
