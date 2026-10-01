// RFC-370: selected workspace maintenance reads may be remote and asynchronous.
// Use real provider stores/claims with explicit effect fakes; local fallback must
// not run and durable cleanup completion must follow acknowledged effects.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows, taskExecutionMaintenanceClaims } from '@/db/schema'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/application/ports/workspaceMaintenance'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { DrizzleWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/workspaceMaintenanceStore'
import { DrizzleTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import { describeEachProvider } from './helpers/eachProvider'

const ulid = monotonicFactory()
function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
function selectedEffects(
  overrides: Partial<WorkspaceMaintenanceFilesystem>,
): WorkspaceMaintenanceFilesystem {
  const unexpected = () => {
    throw new Error('unexpected workspace effect')
  }
  return {
    exists: unexpected,
    isMaterializingTask: () => false,
    removeWorkspace: unexpected,
    removeIsoContainer: unexpected,
    isMerged: unexpected,
    listScratchDirectories: () => [],
    listWorktreeLeaves: () => [],
    listIsoTaskIds: () => [],
    removeAgedPath: unexpected,
    runPartialCloneGc: async () => ({ scanned: 0, removed: 0 }),
    ...overrides,
  }
}
function command(db: ProviderNeutralDatabase, filesystem: WorkspaceMaintenanceFilesystem) {
  return composeWorkspaceMaintenanceCommand({
    db,
    appHome: '/selected-adapter-only',
    terminalMaintenance: new DrizzleTerminalMaintenancePersistence(db),
    isMaterializingTask() {
      throw new Error('local materialization query must not run')
    },
    invalidateWorkspacePath() {
      throw new Error('local invalidation must not run')
    },
    filesystem,
  })
}
async function terminalTask(db: ProviderNeutralDatabase) {
  const workflowId = ulid(),
    taskId = ulid(),
    workspace = `workspace://${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'RFC370 workspace',
    definition: '{}',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'selected workspace',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: workspace,
    worktreePath: workspace,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    spaceKind: 'scratch',
    startedAt: 1,
    finishedAt: 2,
    lifecycleEventRevision: 1,
  })
  return { taskId, workspace }
}
function gcInput(
  phase: 'worktree' | 'iso' | 'scratch' | 'orphan',
  activeTaskIds: readonly string[] = [],
) {
  return {
    phase,
    activeTaskIds,
    worktreeAutoGc: { enabled: true },
    gitCloneTimeoutMs: 30000,
    now: 10000,
  }
}

describeEachProvider('RFC-370 selected async workspace maintenance', (harness) => {
  test('awaits existence before healing a missing workspace; failures leave durable state intact', async () => {
    const { taskId, workspace } = await terminalTask(harness.db)
    const entered = barrier(),
      release = barrier()
    const calls: string[] = []
    let fail = true
    const maintenance = command(
      harness.db,
      selectedEffects({
        async exists(path) {
          expect(path).toBe(workspace)
          calls.push('exists')
          if (fail) {
            entered.release()
            await release.pending
            throw new Error('remote existence unavailable')
          }
          return false
        },
      }),
    )
    const first = maintenance.runGcPhase(gcInput('worktree'))
    // Observe rejection immediately, while retaining a promise for the assertion.
    const firstResult = first.then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await entered.pending
      const pendingRow = (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
      expect(pendingRow.workspacePruningAt).toBeNull()
      expect(pendingRow.workspacePrunedAt).toBeNull()
      release.release()
      expect(await firstResult).toEqual(new Error('remote existence unavailable'))
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBeNull()
      fail = false
      expect(await maintenance.runGcPhase(gcInput('worktree'))).toEqual({
        scanned: 1,
        removed: 0,
        skipped: 1,
      })
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBe(10000)
      expect(calls).toEqual(['exists', 'exists'])
    } finally {
      release.release()
      await firstResult
    }
  })

  test('retains the claim after failed cleanup, waits for retry acknowledgement before finalization', async () => {
    const { taskId, workspace } = await terminalTask(harness.db)
    const entered = barrier(),
      release = barrier()
    let removes = 0
    const maintenance = command(
      harness.db,
      selectedEffects({
        async exists(path) {
          expect(path).toBe(workspace)
          return true
        },
        async removeWorkspace(task, repositories) {
          expect(task.id).toBe(taskId)
          expect(repositories).toEqual([])
          removes++
          if (removes === 1) throw new Error('remote cleanup unavailable')
          entered.release()
          await release.pending
          return true
        },
      }),
    )
    expect(await maintenance.runGcPhase(gcInput('worktree'))).toEqual({
      scanned: 1,
      removed: 0,
      skipped: 1,
    })
    const row = (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(row.workspacePruningAt).toBe(10000)
    expect(row.workspacePrunedAt).toBeNull()
    const retry = maintenance.recover({ activeTaskIds: [], now: 10001, webhookClaims: 'all' })
    try {
      await entered.pending
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBeNull()
      expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
        'claimed',
      )
      release.release()
      expect(await retry).toEqual({ completed: 1, failed: 0, skipped: 0, healed: 0 })
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBe(10001)
      expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
        'completed',
      )
      expect(removes).toBe(2)
    } finally {
      release.release()
      await retry.catch(() => {})
    }
  })

  test('recovery awaits existence and preserves a workspace that is still present', async () => {
    const { taskId, workspace } = await terminalTask(harness.db)
    const entered = barrier(),
      release = barrier()
    const maintenance = command(
      harness.db,
      selectedEffects({
        async exists(path) {
          expect(path).toBe(workspace)
          entered.release()
          await release.pending
          return true
        },
      }),
    )
    const recovery = maintenance.recover({ activeTaskIds: [], now: 10000 })
    try {
      await entered.pending
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBeNull()
      release.release()
      expect(await recovery).toEqual({ completed: 0, failed: 0, skipped: 0, healed: 0 })
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBeNull()
    } finally {
      release.release()
      await recovery.catch(() => {})
    }
  })

  test('recovery awaits a false existence receipt and can retry an unavailable receipt', async () => {
    const { taskId, workspace } = await terminalTask(harness.db)
    const entered = barrier(),
      release = barrier()
    let fail = true
    const maintenance = command(
      harness.db,
      selectedEffects({
        async exists(path) {
          expect(path).toBe(workspace)
          if (fail) {
            entered.release()
            await release.pending
            throw new Error('remote recovery existence unavailable')
          }
          return false
        },
      }),
    )
    const first = maintenance.recover({ activeTaskIds: [], now: 10000 })
    const firstResult = first.then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await entered.pending
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBeNull()
      release.release()
      expect(await firstResult).toEqual(new Error('remote recovery existence unavailable'))
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBeNull()
      fail = false
      expect(await maintenance.recover({ activeTaskIds: [], now: 10001 })).toEqual({
        completed: 0,
        failed: 0,
        skipped: 0,
        healed: 1,
      })
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
      ).toBe(10001)
    } finally {
      release.release()
      await firstResult
    }
  })

  for (const stale of ['resumed', 'new-terminal-revision', 'changed-path', 'deleted'] as const) {
    test(`a pending existence read cannot heal a ${stale} task snapshot`, async () => {
      const { taskId, workspace } = await terminalTask(harness.db)
      const entered = barrier(),
        release = barrier()
      const maintenance = command(
        harness.db,
        selectedEffects({
          async exists(path) {
            expect(path).toBe(workspace)
            entered.release()
            await release.pending
            return false
          },
        }),
      )
      const recovery = maintenance.recover({ activeTaskIds: [], now: 10000 })
      try {
        await entered.pending
        await harness.db
          .update(tasks)
          .set(
            stale === 'resumed'
              ? { status: 'pending', lifecycleEventRevision: 2 }
              : stale === 'new-terminal-revision'
                ? { lifecycleEventRevision: 2 }
                : stale === 'changed-path'
                  ? { worktreePath: `${workspace}/new` }
                  : { deletedAt: 10001 },
          )
          .where(eq(tasks.id, taskId))
        release.release()
        expect(await recovery).toEqual({ completed: 0, failed: 0, skipped: 0, healed: 0 })
        expect(
          (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
        ).toBeNull()
      } finally {
        release.release()
        await recovery.catch(() => {})
      }
    })
  }

  // A recovery probe can overlap foreground finalization. Its old false result
  // must not stamp completion before the new cleanup claim receives its ACK.
  for (const failsFirstAck of [false, true]) {
    test(`a stale recovery probe preserves an in-flight cleanup claim (${failsFirstAck ? 'failed' : 'successful'} ACK)`, async () => {
      const { taskId, workspace } = await terminalTask(harness.db)
      const existenceEntered = barrier(),
        existenceReleased = barrier(),
        cleanupEntered = barrier(),
        cleanupReleased = barrier()
      let removes = 0
      const effects = selectedEffects({
        async exists(path) {
          expect(path).toBe(workspace)
          existenceEntered.release()
          await existenceReleased.pending
          return false
        },
        async removeWorkspace(task) {
          expect(task.id).toBe(taskId)
          removes++
          if (removes === 1) {
            cleanupEntered.release()
            await cleanupReleased.pending
            if (failsFirstAck) throw new Error('remote cleanup ACK unavailable')
          }
          return true
        },
      })
      const recovery = command(harness.db, effects).recover({ activeTaskIds: [], now: 10000 })
      let finalizationResult: Promise<unknown> = Promise.resolve(null)
      try {
        await existenceEntered.pending
        expect(
          await new DrizzleWorkspaceMaintenanceStore(harness.db).claimWorkspace(taskId, 10001),
        ).toBe(true)
        finalizationResult = command(harness.db, effects)
          .finalizeClaimedWorkspace(taskId, 10001)
          .then(
            () => null,
            (error: unknown) => error,
          )
        await cleanupEntered.pending
        existenceReleased.release()
        expect(await recovery).toEqual({ completed: 0, failed: 0, skipped: 0, healed: 0 })
        const pending = (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
        expect(pending.workspacePruningAt).toBe(10001)
        expect(pending.workspacePrunedAt).toBeNull()
        expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
          'claimed',
        )
        cleanupReleased.release()
        const result = await finalizationResult
        if (failsFirstAck) {
          expect(result).toEqual(new Error(`workspace-prune-finalization-failed:${taskId}`))
          expect(
            (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
              .workspacePrunedAt,
          ).toBeNull()
          expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
            'claimed',
          )
          expect(
            await command(harness.db, effects).recover({ activeTaskIds: [], now: 10003 }),
          ).toEqual({
            completed: 1,
            failed: 0,
            skipped: 0,
            healed: 0,
          })
        } else {
          expect(result).toBeNull()
        }
        expect(
          (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workspacePrunedAt,
        ).toBe(failsFirstAck ? 10003 : 10001)
        expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
          'completed',
        )
        expect(removes).toBe(failsFirstAck ? 2 : 1)
      } finally {
        existenceReleased.release()
        cleanupReleased.release()
        await Promise.all([recovery.catch(() => {}), finalizationResult])
      }
    })
  }

  for (const phase of ['scratch', 'orphan'] as const) {
    test(`${phase} awaits listing and materialization before deleting orphan content`, async () => {
      const protectedId = ulid(),
        removableId = ulid(),
        entered = barrier(),
        release = barrier(),
        materializing = barrier(),
        materialized = barrier()
      const entries = [protectedId, removableId].map((taskId) => ({
        taskId,
        path: `workspace://${taskId}`,
      }))
      const calls: string[] = []
      const list = async () => {
        calls.push('list')
        entered.release()
        await release.pending
        return entries
      }
      const maintenance = command(
        harness.db,
        selectedEffects({
          ...(phase === 'scratch'
            ? { listScratchDirectories: list }
            : { listWorktreeLeaves: list }),
          async isMaterializingTask(taskId) {
            calls.push(`materializing:${taskId}`)
            if (taskId === protectedId) {
              materializing.release()
              await materialized.pending
              return true
            }
            return false
          },
          async removeAgedPath(path, now, age) {
            calls.push(`remove:${path}`)
            expect(path).toBe(`workspace://${removableId}`)
            expect(now).toBe(10000)
            expect(age).toBe(24 * 60 * 60 * 1000)
            return true
          },
        }),
      )
      const gc = maintenance.runGcPhase(gcInput(phase))
      try {
        await entered.pending
        expect(calls).toEqual(['list'])
        release.release()
        await materializing.pending
        expect(calls).toEqual(['list', `materializing:${protectedId}`])
        materialized.release()
        expect(await gc).toEqual({ scanned: 2, removed: 1, skipped: 1 })
        expect(calls).toEqual([
          'list',
          `materializing:${protectedId}`,
          `materializing:${removableId}`,
          `remove:workspace://${removableId}`,
        ])
      } finally {
        release.release()
        materialized.release()
        await gc.catch(() => {})
      }
    })
  }

  test('iso awaits its selected listing and skips active tasks before effect invocation', async () => {
    const activeId = ulid(),
      orphanId = ulid(),
      entered = barrier(),
      release = barrier(),
      calls: string[] = []
    const maintenance = command(
      harness.db,
      selectedEffects({
        async listIsoTaskIds() {
          entered.release()
          await release.pending
          return [activeId, orphanId]
        },
        async removeIsoContainer(task, taskId) {
          expect(task).toBeNull()
          expect(taskId).toBe(orphanId)
          calls.push(taskId)
          return true
        },
      }),
    )
    const gc = maintenance.runGcPhase(gcInput('iso', [activeId]))
    try {
      await entered.pending
      expect(calls).toEqual([])
      release.release()
      expect(await gc).toEqual({ scanned: 2, removed: 1, skipped: 1 })
      expect(calls).toEqual([orphanId])
    } finally {
      release.release()
      await gc.catch(() => {})
    }
  })
})
