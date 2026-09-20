import type { SealedPublicRepositorySourceRef } from '@/modules/source-control/public/types'
import { loadFrozenSpaceLayout } from './frozenWorkspaceLayout'
import type { GitCommitIdentity } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import { materializingSpaces } from '@/services/gc'
import type { MaterializedSpace, WorkspaceCleanupReport } from '@/services/task'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { createWorkspacePreparationJournal } from './workspacePreparationJournal'
import { withTaskExecutionWrite } from './ownedTaskExecution'
import type { TaskRepositoryPreparationBinding } from './repositoryPreparationBinding'

export function preMaterializedAdmissionPrefix(appHome: string): string {
  return `task-prepared:${sha256Hex(appHome)}:`
}

async function assertUnadmitted(
  tx: ProviderNeutralDatabase,
  taskId: string,
  operationRef: string,
  states: readonly string[],
) {
  const plan = await createWorkspacePreparationJournal(tx).read(taskId)
  const task = (await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)))[0]
  if (
    plan === null ||
    plan.lane !== 'pre-materialized' ||
    plan.operationRef !== operationRef ||
    plan.admittedTaskId !== null ||
    !states.includes(plan.state) ||
    task !== undefined
  )
    throw new ConflictError(
      'workspace-preparation-owner-changed',
      'workspace is no longer unadmitted',
    )
  return plan
}

/** Same cleanup protocol for request rollback and the existing orphan maintenance job. */
export async function compensatePreMaterializedRepository(input: {
  db: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  taskId: string
}): Promise<WorkspaceCleanupReport> {
  const plan = await withTaskExecutionWrite(input.db, async (tx) => {
    const journal = createWorkspacePreparationJournal(tx)
    const previous = await journal.read(input.taskId)
    if (previous?.operationRef === null || previous === null)
      throw new Error('workspace-preparation-plan-missing')
    const current = await assertUnadmitted(tx, input.taskId, previous.operationRef, [
      'preparing',
      'prepared',
      'compensating',
      'failed',
      'cleaned',
    ])
    if (current.state === 'compensating' || current.state === 'cleaned') return current
    const claimed = await journal.advance({
      id: current.id,
      expectedVersion: current.version,
      ownerFence: current.ownerFence,
      from: current.state,
      to: 'compensating',
      now: Date.now(),
    })
    if (claimed === null) throw new Error('workspace-preparation-owner-changed')
    return claimed
  })
  const operationRef = plan.operationRef!
  const assertCurrent = () =>
    withTaskExecutionWrite(input.db, async (tx) => {
      await assertUnadmitted(tx, input.taskId, operationRef, ['compensating', 'cleaned'])
    })
  const effect = await input.binding.effect({
    taskId: input.taskId,
    operationRef,
    gitCommitIdentity: null,
    signal: new AbortController().signal,
    assertCurrent,
  })
  try {
    const report = await effect.cleanup()
    if (report.complete)
      await withTaskExecutionWrite(input.db, async (tx) => {
        const current = await assertUnadmitted(tx, input.taskId, operationRef, [
          'compensating',
          'cleaned',
        ])
        if (current.state === 'cleaned') return
        if (
          (await createWorkspacePreparationJournal(tx).advance({
            id: current.id,
            expectedVersion: current.version,
            ownerFence: current.ownerFence,
            from: 'compensating',
            to: 'cleaned',
            now: Date.now(),
          })) === null
        )
          throw new Error('workspace-preparation-owner-changed')
      })
    return report
  } finally {
    effect.close()
  }
}

/** Prepare and uploads precede the Task INSERT. The journal exists before Git/FS. */
export async function preparePreMaterializedRepository(input: {
  db: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  authority: RequestAuthority
  taskId: string
  appHome: string
  cachedRepoId: string | null
  repoGroupId: string | null
  base: string
  sealedSource?: SealedPublicRepositorySourceRef
  sourceTaskId?: string
  workingBranch?: string
  gitCommitIdentity: GitCommitIdentity | null
  signal: AbortSignal
}): Promise<{
  space: MaterializedSpace
  admit(tx: ProviderNeutralDatabase): Promise<void>
  commit(): void
  rollback(): Promise<WorkspaceCleanupReport>
}> {
  // Reuse the existing preparation lease. The maintenance worker receives its
  // task ID through activeTaskIdsSnapshot; there is no new timer or scheduler.
  materializingSpaces.set(input.taskId, { dir: input.appHome, startedAt: Date.now() })
  let operationRef: string | undefined
  try {
    operationRef = await withTaskExecutionWrite(input.db, async (tx) => {
      const journal = createWorkspacePreparationJournal(tx)
      const previous = await journal.read(input.taskId)
      if (previous !== null) {
        if (previous.operationRef === null) throw new Error('workspace-preparation-plan-missing')
        await assertUnadmitted(tx, input.taskId, previous.operationRef, ['preparing', 'prepared'])
        return previous.operationRef
      }
      const scope = input.binding.snapshot({
        transaction: tx,
        authority: input.authority,
        now: Date.now(),
      })
      try {
        const selector = {
          cachedRepoId: input.cachedRepoId,
          repoGroupId: input.repoGroupId,
          base: input.base,
          ...(input.sealedSource === undefined ? {} : { sealedSource: input.sealedSource }),
        }
        const source =
          input.sourceTaskId === undefined
            ? await scope.participant.resolveAuthorized(
                input.authority,
                await scope.source(selector),
              )
            : await scope.frozenLayout(await loadFrozenSpaceLayout(tx, input.sourceTaskId))
        const operation = await scope.plan(source)
        await journal.prepare({
          id: input.taskId,
          admissionKey: `${preMaterializedAdmissionPrefix(input.appHome)}${input.taskId}`,
          requestDigest: sha256Hex(
            JSON.stringify({ ...selector, sourceTaskId: input.sourceTaskId ?? null }),
          ),
          lane: 'pre-materialized',
          operationRef: operation,
          ownerFence: 0,
          now: Date.now(),
        })
        return operation
      } finally {
        scope.close()
      }
    })
    const operation = operationRef
    const assertCurrent = () =>
      withTaskExecutionWrite(input.db, async (tx) => {
        await assertUnadmitted(tx, input.taskId, operation, ['preparing', 'prepared'])
      })
    const effect = await input.binding.effect({
      taskId: input.taskId,
      operationRef: operation,
      gitCommitIdentity: input.gitCommitIdentity,
      ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
      signal: input.signal,
      assertCurrent,
    })
    let space: MaterializedSpace
    try {
      const outcome = await effect.participant.prepare(
        effect.capability,
        effect.operation,
        effect.source,
      )
      // A materializer earlyError still creates the same failed Task as before.
      // Domain errors still abort launch without creating a placeholder Task.
      space = await effect.space()
      await withTaskExecutionWrite(input.db, async (tx) => {
        const current = await assertUnadmitted(tx, input.taskId, operation, [
          'preparing',
          'prepared',
        ])
        if (current.state === 'prepared') return
        if (
          (await createWorkspacePreparationJournal(tx).advance({
            id: current.id,
            expectedVersion: current.version,
            ownerFence: current.ownerFence,
            from: 'preparing',
            to: 'prepared',
            artifactJson: JSON.stringify({ version: 1, operation: effect.operation, outcome }),
            now: Date.now(),
          })) === null
        )
          throw new Error('workspace-preparation-owner-changed')
      })
    } finally {
      effect.close()
    }
    return {
      space,
      async admit(tx) {
        const current = await assertUnadmitted(tx, input.taskId, operation, ['prepared'])
        if (
          (await createWorkspacePreparationJournal(tx).advance({
            id: current.id,
            expectedVersion: current.version,
            ownerFence: current.ownerFence,
            from: 'prepared',
            to: 'admitted',
            admittedTaskId: input.taskId,
            now: Date.now(),
          })) === null
        )
          throw new Error('workspace-preparation-owner-changed')
      },
      commit() {
        materializingSpaces.delete(input.taskId)
      },
      async rollback() {
        try {
          return await compensatePreMaterializedRepository(input)
        } finally {
          materializingSpaces.delete(input.taskId)
        }
      },
    }
  } catch (error) {
    try {
      if (operationRef !== undefined) await compensatePreMaterializedRepository(input)
    } catch {
      /* Keep the original launch error; the durable compensating record is retried by GC. */
    }
    materializingSpaces.delete(input.taskId)
    throw error
  }
}
