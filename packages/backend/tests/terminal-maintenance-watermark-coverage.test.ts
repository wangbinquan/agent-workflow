// Locks in two workspace-GC defects found while chasing a PostgreSQL daemon that
// warned "workspace prune failed (durable claim kept for recovery)" once per GC
// tick for ~30 terminal tasks, whose worktrees were therefore never reclaimed.
//
// 1. `assertSettledLedgerCoverageTx` (both providers) compared EVERY settled
//    effect's requestHash/slotPathDigest against the retained watermark. The
//    watermark is a per-family HIGH-WATER MARK: one row per
//    (execution_lineage_id, operation_family_key) that carries the digests of
//    the highest settled generation only. So as soon as a family settled a
//    second business generation carrying a different request, the older
//    generation's row could never satisfy the check and terminal maintenance
//    was refused forever. Both writers (settleTx / recovery upsertWatermark)
//    already scope the digest equality to `highestSettledGeneration ===
//    effect.operationGeneration`; the reader now agrees.
// 2. `finishClaimedWorkspace` only recognised WorkspaceMaintenanceConflictError,
//    so a `task-terminal-maintenance-conflict` raised by the terminal
//    maintenance store fell through to 'failed' — warning on every tick and
//    making `finalizeClaimedWorkspace` throw at a task-terminal event. The
//    legacy SQLite path (systemWorkspaceGc.ts) classified it as 'busy'.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '@/db/client'
import { taskExecutionLineageOperationRecords, tasks } from '@/db/schema'
import { createWorkspaceMaintenanceCommand } from '@/modules/source-control/application/workspaceMaintenance'
import { createNodeWorkspaceMaintenanceFilesystem } from '@/modules/source-control/infrastructure/nodeWorkspaceMaintenanceFilesystem'
import { SqliteWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/sqliteWorkspaceMaintenanceStore'
import { createTaskExecutionTestModule } from '@/modules/task-execution/composition'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { createVerifiedStopProof } from '@/modules/task-execution/domain/ownership'
import { retainedWatermarkCoversSettledEffect } from '@/modules/task-execution/domain/terminalMaintenance'
import { SqliteTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/sqliteTerminalMaintenancePersistence'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function seedTask(database: DbClient, taskId: string, worktreePath: string): void {
  database
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-watermark-coverage',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      spaceKind: 'scratch',
      startedAt: 1,
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(rootPath(taskId)),
    })
    .run()
}

function continuation(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

/**
 * One family that settled TWO business generations carrying different requests
 * — what a re-run of the same slot leaves behind — then went quiescent.
 */
function settledTwoGenerationTask(taskId: string): {
  readonly database: DbClient
  readonly module: ReturnType<typeof createTaskExecutionTestModule>
} {
  const database = createInMemoryDb(MIGRATIONS)
  seedTask(database, taskId, '/tmp/worktree')
  const module = createTaskExecutionTestModule(`daemon-${taskId}`)
  const intent = module.intents.submit({
    db: database,
    request: continuation(taskId),
    intentId: `intent-${taskId}`,
  })
  const owned = module.claim({ db: database, intentId: intent.intentId, now: 60 })
  module.claimGate.leave(owned.permit)

  const slotPath = rootPath(taskId)
  const pathJson = canonicalJson(slotPath)
  const family = operationFamilyKey({
    executionLineageId: taskId,
    slotPath,
    effectKind: 'repository',
    stableActionOrdinal: 'two-generation-fixture',
  })
  const settleGeneration = (generation: number, request: unknown, now: number): void => {
    const prepared = module.effects.prepareAndAcquire({
      db: database,
      token: owned.token,
      intentId: intent.intentId,
      operationKey: 'root:two-generation-fixture',
      executionLineageId: taskId,
      operationFamilyKey: family,
      operationGeneration: generation,
      kind: 'repository',
      requestHash: requestHash(request),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      candidateId: `two-generation-${generation}`,
      recoveryClass: 'local-convergent',
      classifierVersion: 'test-v1',
      transportPolicyVersion: 'test-v1',
      retryAuthority: 'none',
      resourceKeys: ['repository:two-generation-fixture'],
      now,
    })
    module.effects.settle({
      db: database,
      token: owned.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
      receiptJson: '{"ok":true}',
      now: now + 1,
    })
  }
  settleGeneration(0, { operation: 'first-request' }, 61)
  settleGeneration(1, { operation: 'second-request' }, 63)

  database.update(tasks).set({ status: 'done', finishedAt: 65 }).where(eq(tasks.id, taskId)).run()
  const owner = module.ownership.read(database, taskId)!
  module.ownership.releaseAfterStop({
    db: database,
    token: owned.token,
    intentId: intent.intentId,
    proof: createVerifiedStopProof({
      taskId,
      ownerRevision: owner.revision,
      epoch: owned.token.epoch,
      evidenceDigest: 'two-generation-reaped',
      verifiedAt: 66,
    }),
    now: 66,
  })
  return { database, module }
}

function claimWorkspaceGc(
  database: DbClient,
  module: ReturnType<typeof createTaskExecutionTestModule>,
  taskId: string,
): void {
  const members = module.terminalMaintenance.snapshotTree(database, taskId)
  module.terminalMaintenance.claim({
    db: database,
    rootTaskId: taskId,
    operation: 'workspace-gc',
    members,
    cleanupPlanJson: JSON.stringify({ v: 1, kind: 'workspace-prune', taskId }),
    now: 67,
  })
}

describe('terminal maintenance retained-watermark coverage', () => {
  test('a family that settled two generations with different requests can still be claimed', () => {
    const taskId = 'task-two-generation-family'
    const { database, module } = settledTwoGenerationTask(taskId)
    expect(() => claimWorkspaceGc(database, module, taskId)).not.toThrow()
  })

  test('coverage is still refused when the retained watermark is gone', () => {
    const taskId = 'task-watermark-erased'
    const { database, module } = settledTwoGenerationTask(taskId)
    database.delete(taskExecutionLineageOperationRecords).run()
    expect(() => claimWorkspaceGc(database, module, taskId)).toThrow(
      /lacks a complete retained watermark/,
    )
  })

  test('a terminal-maintenance conflict is busy, not a failed finalization', async () => {
    const taskId = 'task-conflict-is-busy'
    const appHome = mkdtempSync(join(tmpdir(), 'aw-watermark-coverage-'))
    try {
      const database = createInMemoryDb(MIGRATIONS)
      seedTask(database, taskId, join(appHome, 'scratch', taskId))
      const module = createTaskExecutionTestModule('daemon-conflict-is-busy')
      const intent = module.intents.submit({
        db: database,
        request: continuation(taskId),
        intentId: 'intent-conflict-is-busy',
      })
      // Left claimed on purpose: the execution plane is not quiescent, so the
      // terminal maintenance store rejects the claim with a transient conflict.
      const owned = module.claim({ db: database, intentId: intent.intentId, now: 60 })
      module.claimGate.leave(owned.permit)
      database
        .update(tasks)
        .set({ status: 'done', finishedAt: 65, workspacePruningAt: 66 })
        .where(eq(tasks.id, taskId))
        .run()

      const command = createWorkspaceMaintenanceCommand({
        store: new SqliteWorkspaceMaintenanceStore(database),
        terminalMaintenance: new SqliteTerminalMaintenancePersistence(database),
        filesystem: createNodeWorkspaceMaintenanceFilesystem({
          appHome,
          isMaterializingTask: () => false,
          invalidateWorkspacePath: () => {},
        }),
      })
      await expect(command.finalizeClaimedWorkspace(taskId, 67)).resolves.toBeUndefined()
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})

describe('retained watermark coverage rule', () => {
  const effect = { operationGeneration: 3, requestHash: 'hash-3', slotPathDigest: 'slot' }

  test('an older generation is covered by the generation bound alone', () => {
    expect(
      retainedWatermarkCoversSettledEffect(effect, {
        highestSettledGeneration: 4,
        requestHash: 'hash-4',
        slotPathDigest: 'slot',
      }),
    ).toBeTrue()
  })

  test('the high-water generation still has to match digest for digest', () => {
    expect(
      retainedWatermarkCoversSettledEffect(effect, {
        highestSettledGeneration: 3,
        requestHash: 'hash-3',
        slotPathDigest: 'slot',
      }),
    ).toBeTrue()
    expect(
      retainedWatermarkCoversSettledEffect(effect, {
        highestSettledGeneration: 3,
        requestHash: 'hash-other',
        slotPathDigest: 'slot',
      }),
    ).toBeFalse()
    expect(
      retainedWatermarkCoversSettledEffect(effect, {
        highestSettledGeneration: 3,
        requestHash: 'hash-3',
        slotPathDigest: 'slot-other',
      }),
    ).toBeFalse()
  })

  test('a missing or lagging watermark is not coverage', () => {
    expect(retainedWatermarkCoversSettledEffect(effect, undefined)).toBeFalse()
    expect(
      retainedWatermarkCoversSettledEffect(effect, {
        highestSettledGeneration: 2,
        requestHash: 'hash-3',
        slotPathDigest: 'slot',
      }),
    ).toBeFalse()
    expect(
      retainedWatermarkCoversSettledEffect(effect, {
        highestSettledGeneration: null,
        requestHash: 'hash-3',
        slotPathDigest: 'slot',
      }),
    ).toBeFalse()
  })

  test('both providers read the rule from the domain instead of re-deriving it', () => {
    const root = resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'infrastructure',
    )
    for (const file of [
      'sqliteTerminalMaintenance.ts',
      'postgresqlTerminalMaintenancePersistence.ts',
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source, file).toContain('retainedWatermarkCoversSettledEffect(effect, watermark)')
      expect(source, file).not.toContain('watermark.requestHash !== effect.requestHash')
    }
  })
})
