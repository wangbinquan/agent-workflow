import { preparedArtifactLane } from './workspaceLaunchLane'
import type { GitCommitIdentity } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import { materializingSpaces } from '@/services/gc'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { TaskRepositoryPreparationBinding } from './repositoryPreparationBinding'
import type { WorkspacePreparationState } from '../application/ports/workspacePreparationJournal'
import { createWorkspacePreparationJournal } from './workspacePreparationJournal'
import { withTaskExecutionWrite } from './ownedTaskExecution'

export function scratchAdmissionPrefix(appHome: string): string {
  return `task-scratch:${sha256Hex(appHome)}:`
}

async function assertUnbound(
  db: ProviderNeutralDatabase,
  taskId: string,
  states: readonly WorkspacePreparationState[],
) {
  const plan = await createWorkspacePreparationJournal(db).read(taskId)
  if (
    plan === null ||
    plan.operationRef !== null ||
    plan.lane !== 'pre-materialized' ||
    plan.admittedTaskId !== null ||
    !plan.admissionKey.startsWith('task-scratch:') ||
    !states.includes(plan.state) ||
    (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length !== 0
  )
    throw new ConflictError(
      'workspace-preparation-owner-changed',
      'scratch workspace is no longer unadmitted',
    )
  return plan
}

export async function compensateScratchWorkspace(input: {
  db: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  taskId: string
}) {
  const plan = await withTaskExecutionWrite(input.db, async (tx) => {
    const current = await assertUnbound(tx, input.taskId, [
      'preparing',
      'prepared',
      'compensating',
      'cleaned',
      'failed',
    ])
    if (current.state === 'cleaned' || current.state === 'compensating') return current
    const claimed = await createWorkspacePreparationJournal(tx).advance({
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
  if (plan.state === 'cleaned') return { taskId: input.taskId, complete: true, failures: [] }
  const report = await input.binding.cleanupScratch({
    taskId: input.taskId,
    assertCurrent: async () => {
      await withTaskExecutionWrite(input.db, (tx) =>
        assertUnbound(tx, input.taskId, ['compensating']),
      )
    },
  })
  if (report.complete)
    await withTaskExecutionWrite(input.db, async (tx) => {
      const current = await assertUnbound(tx, input.taskId, ['compensating', 'cleaned'])
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
}

/** A scratch artifact has no repository source or SC repository operation. */
export async function prepareScratchWorkspace(input: {
  db: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  appHome: string
  taskId: string
  gitCommitIdentity: GitCommitIdentity | null
  signal: AbortSignal
}) {
  materializingSpaces.set(input.taskId, { dir: input.appHome, startedAt: Date.now() })
  let prepared = false
  try {
    const current = await withTaskExecutionWrite(input.db, async (tx) => {
      await createWorkspacePreparationJournal(tx).prepare({
        id: input.taskId,
        admissionKey: `${scratchAdmissionPrefix(input.appHome)}${input.taskId}`,
        requestDigest: sha256Hex(
          JSON.stringify({ version: 1, gitCommitIdentity: input.gitCommitIdentity }),
        ),
        operationRef: null,
        lane: 'pre-materialized',
        ownerFence: 0,
        now: Date.now(),
      })
      return assertUnbound(tx, input.taskId, ['preparing', 'prepared'])
    })
    prepared = true
    const space =
      current.state === 'prepared'
        ? input.binding.restoreScratch(input.taskId, current.artifactJson!)
        : await input.binding.prepareScratch({
            taskId: input.taskId,
            gitCommitIdentity: input.gitCommitIdentity,
            signal: input.signal,
            assertCurrent: async () => {
              await withTaskExecutionWrite(input.db, (tx) =>
                assertUnbound(tx, input.taskId, ['preparing']),
              )
            },
          })
    await withTaskExecutionWrite(input.db, async (tx) => {
      const current = await assertUnbound(tx, input.taskId, ['preparing', 'prepared'])
      if (current.state === 'prepared') return
      if (
        (await createWorkspacePreparationJournal(tx).advance({
          id: current.id,
          expectedVersion: current.version,
          ownerFence: current.ownerFence,
          from: 'preparing',
          to: 'prepared',
          artifactJson: JSON.stringify({ version: 1, space }),
          now: Date.now(),
        })) === null
      )
        throw new Error('workspace-preparation-owner-changed')
    })
    return {
      space,
      async admit(tx: ProviderNeutralDatabase) {
        const current = await assertUnbound(tx, input.taskId, ['prepared'])
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
        return preparedArtifactLane(current.id)
      },
      commit() {
        materializingSpaces.delete(input.taskId)
      },
      async rollback() {
        try {
          return await compensateScratchWorkspace(input)
        } finally {
          materializingSpaces.delete(input.taskId)
        }
      },
    }
  } catch (error) {
    try {
      if (prepared) await compensateScratchWorkspace(input)
    } catch {
      /* Existing scratch maintenance retries the durable compensation. */
    }
    materializingSpaces.delete(input.taskId)
    throw error
  }
}
