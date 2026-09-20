import { repositoryPreparationLane } from './workspaceLaunchLane'
import type { SealedPublicRepositorySourceRef } from '@/modules/source-control/public/types'
import type { GitCommitIdentity } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { MaterializedSpace } from '../application/ports/preparedWorkspace'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import { createWorkspacePreparationJournal } from './workspacePreparationJournal'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'
import type { TaskRepositoryPreparationBinding } from './repositoryPreparationBinding'

export async function admitDeferredRepositoryPreparation(input: {
  transaction: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  authority: RequestAuthority
  taskId: string
  cachedRepoId: string | null
  repoGroupId: string | null
  base: string
  sealedSource?: SealedPublicRepositorySourceRef
}) {
  const now = Date.now()
  const scope = input.binding.snapshot({
    transaction: input.transaction,
    authority: input.authority,
    now,
  })
  try {
    const selector = {
      cachedRepoId: input.cachedRepoId,
      repoGroupId: input.repoGroupId,
      base: input.base,
      ...(input.sealedSource === undefined ? {} : { sealedSource: input.sealedSource }),
    }
    const source = await scope.participant.resolveAuthorized(
      input.authority,
      await scope.source(selector),
    )
    const operationRef = await scope.plan(source)
    const journal = createWorkspacePreparationJournal(input.transaction)
    const plan = await journal.prepare({
      id: input.taskId,
      admissionKey: `task-root:${input.taskId}`,
      requestDigest: sha256Hex(JSON.stringify(selector)),
      lane: 'repository-preparation',
      operationRef,
      ownerFence: 0,
      now,
    })
    if (
      (await journal.bindTask({
        id: plan.id,
        expectedVersion: plan.version,
        ownerFence: 0,
        taskId: input.taskId,
        now,
      })) === null
    )
      throw new ConflictError(
        'workspace-preparation-version-changed',
        'workspace admission changed',
      )
    return repositoryPreparationLane(plan.id, source)
  } finally {
    scope.close()
  }
}

/** Null is only the documented pre-journal Task compatibility path. */
export async function prepareDurableRepositoryWorkspace(input: {
  db: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  taskId: string
  workingBranch?: string
  gitCommitIdentity: GitCommitIdentity | null
  signal: AbortSignal
}): Promise<MaterializedSpace | null> {
  const journal = createWorkspacePreparationJournal(input.db)
  let plan = await journal.forTask(input.taskId)
  if (plan === null) return null
  const context = currentTaskExecutionContext(input.taskId)
  const ownerFence = context?.token.epoch ?? plan.ownerFence
  plan = await withTaskExecutionWrite(input.db, async (tx) => {
    await fenceTaskWrite(tx, { taskId: input.taskId, context })
    const current = await createWorkspacePreparationJournal(tx).forTask(input.taskId)
    if (current === null || current.operationRef === null)
      throw new Error('workspace-preparation-plan-missing')
    const adopted = await createWorkspacePreparationJournal(tx).adoptOwner({
      id: current.id,
      expectedVersion: current.version,
      previousFence: current.ownerFence,
      ownerFence,
      now: Date.now(),
    })
    if (adopted === null)
      throw new ConflictError(
        'workspace-preparation-version-changed',
        'workspace preparation owner changed',
      )
    const nextOperation = await input.binding.nextAttempt({
      transaction: tx,
      operationRef: adopted.operationRef!,
      now: Date.now(),
    })
    if (nextOperation === adopted.operationRef) return adopted
    const replaced = await createWorkspacePreparationJournal(tx).replaceOperation({
      id: adopted.id,
      expectedVersion: adopted.version,
      ownerFence,
      previousOperationRef: adopted.operationRef!,
      operationRef: nextOperation,
      now: Date.now(),
    })
    if (replaced === null) throw new Error('workspace-preparation-owner-changed')
    return replaced
  })
  const operationRef = plan.operationRef!
  const assertCurrent = () =>
    withTaskExecutionWrite(input.db, async (tx) => {
      await fenceTaskWrite(tx, { taskId: input.taskId, context })
      const current = await createWorkspacePreparationJournal(tx).forTask(input.taskId)
      const task = (
        await tx.select({ path: tasks.worktreePath }).from(tasks).where(eq(tasks.id, input.taskId))
      )[0]
      if (
        current?.operationRef !== operationRef ||
        current.ownerFence !== ownerFence ||
        current.state === 'admitted' ||
        task === undefined ||
        task.path !== ''
      )
        throw new ConflictError(
          'workspace-preparation-owner-changed',
          'workspace preparation is no longer unbound',
        )
    })
  const effect = await input.binding.effect({
    taskId: input.taskId,
    operationRef,
    gitCommitIdentity: input.gitCommitIdentity,
    ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
    signal: input.signal,
    assertCurrent,
  })
  try {
    const outcome = await effect.participant.prepare(
      effect.capability,
      effect.operation,
      effect.source,
    )
    if (outcome.kind !== 'prepared') {
      // Preserve the original diagnostic before cleanup records its own receipt.
      let error: unknown
      let failed: MaterializedSpace | undefined
      try {
        failed = await effect.space()
      } catch (caught) {
        error = caught
      }
      const cleanup = await effect.cleanup()
      if (cleanup.complete && !input.signal.aborted) {
        await withTaskExecutionWrite(input.db, async (tx) => {
          await fenceTaskWrite(tx, { taskId: input.taskId, context })
          const current = await createWorkspacePreparationJournal(tx).forTask(input.taskId)
          if (current?.operationRef !== operationRef || current.ownerFence !== ownerFence)
            throw new Error('workspace-preparation-owner-changed')
          const next = await input.binding.nextAttempt({
            transaction: tx,
            operationRef,
            now: Date.now(),
          })
          if (
            next !== operationRef &&
            (await createWorkspacePreparationJournal(tx).replaceOperation({
              id: current.id,
              expectedVersion: current.version,
              ownerFence,
              previousOperationRef: operationRef,
              operationRef: next,
              now: Date.now(),
            })) === null
          )
            throw new Error('workspace-preparation-owner-changed')
        })
      }
      if (error !== undefined) throw error
      if (failed !== undefined) return failed
      throw new Error('repository preparation aborted')
    }
    const space = await effect.space()
    await withTaskExecutionWrite(input.db, async (tx) => {
      await fenceTaskWrite(tx, { taskId: input.taskId, context })
      const current = await createWorkspacePreparationJournal(tx).forTask(input.taskId)
      if (current?.operationRef !== operationRef || current.ownerFence !== ownerFence)
        throw new Error('workspace-preparation-owner-changed')
      if (current.state === 'prepared') return
      if (
        (await createWorkspacePreparationJournal(tx).advance({
          id: current.id,
          expectedVersion: current.version,
          ownerFence,
          from: 'preparing',
          to: 'prepared',
          artifactJson: JSON.stringify({
            version: 1,
            operation: effect.operation,
            receipt: outcome.receipt,
          }),
          now: Date.now(),
        })) === null
      )
        throw new Error('workspace-preparation-owner-changed')
    })
    return space
  } finally {
    effect.close()
  }
}

/** Called inside the exact transaction that installs the workspace projection. */
export async function acceptDurableRepositoryWorkspace(
  tx: ProviderNeutralDatabase,
  taskId: string,
): Promise<void> {
  const journal = createWorkspacePreparationJournal(tx)
  const plan = await journal.forTask(taskId)
  if (plan === null) return
  await fenceTaskWrite(tx, { taskId })
  const current = currentTaskExecutionContext(taskId)
  if (current !== undefined && current.token.epoch !== plan.ownerFence)
    throw new ConflictError(
      'workspace-preparation-owner-changed',
      'prepared receipt belongs to a previous Task owner',
    )
  if (plan.state === 'admitted') return
  if (
    plan.state !== 'prepared' ||
    (await journal.advance({
      id: plan.id,
      expectedVersion: plan.version,
      ownerFence: plan.ownerFence,
      from: 'prepared',
      to: 'admitted',
      admittedTaskId: taskId,
      now: Date.now(),
    })) === null
  )
    throw new Error('workspace-preparation-receipt-not-prepared')
}

export async function cleanupDurableRepositoryWorkspace(input: {
  db: ProviderNeutralDatabase
  binding: TaskRepositoryPreparationBinding
  taskId: string
  gitCommitIdentity: GitCommitIdentity | null
  workingBranch?: string
  signal: AbortSignal
}) {
  const plan = await createWorkspacePreparationJournal(input.db).forTask(input.taskId)
  if (plan === null) return null
  if (plan.operationRef === null) throw new Error('workspace-preparation-plan-missing')
  const context = currentTaskExecutionContext(input.taskId)
  const assertCurrent = () =>
    withTaskExecutionWrite(input.db, async (tx) => {
      await fenceTaskWrite(tx, { taskId: input.taskId, context })
      const current = await createWorkspacePreparationJournal(tx).forTask(input.taskId)
      const task = (
        await tx.select({ path: tasks.worktreePath }).from(tasks).where(eq(tasks.id, input.taskId))
      )[0]
      if (
        current?.operationRef !== plan.operationRef ||
        current.ownerFence !== plan.ownerFence ||
        current.state === 'admitted' ||
        (task !== undefined && task.path !== '')
      )
        throw new ConflictError(
          'workspace-preparation-owner-changed',
          'cannot clean an accepted or replaced workspace',
        )
    })
  const effect = await input.binding.effect({
    ...input,
    operationRef: plan.operationRef,
    assertCurrent,
  })
  try {
    return await effect.cleanup()
  } finally {
    effect.close()
  }
}

export async function hasDurableRepositoryPreparation(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<boolean> {
  return (await createWorkspacePreparationJournal(db).forTask(taskId)) !== null
}
