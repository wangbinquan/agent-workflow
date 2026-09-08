// One physical task lifecycle CAS, companion and event sequence. The caller
// owns the transaction and chooses synchronous or asynchronous interpretation.
import type { TaskStatus } from '@agent-workflow/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import {
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import type { TerminalWorkspacePruneDecision } from '@/services/lifecycle'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import type {
  TaskCommittedEventIdentity,
  TaskLifecycleTransitionCommittedEventInput,
} from './taskLifecycleCommittedEvents'

export type TaskLifecycleWriteExtra = Partial<
  Pick<
    typeof tasks.$inferInsert,
    | 'finishedAt'
    | 'errorSummary'
    | 'errorMessage'
    | 'failedNodeId'
    | 'workflowSnapshot'
    | 'workflowVersion'
    | 'refClosureJson'
    | 'workgroupConfigJson'
    | 'sourceTerminationFence'
    | 'sourceTerminationEffectRev'
  >
>

export interface TaskLifecycleWriteInput<Tx extends ProviderNeutralDatabase> {
  readonly taskId: string
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly extra?: TaskLifecycleWriteExtra
  readonly now: number
  readonly isRevival?: boolean
  readonly workspacePruneDecision: TerminalWorkspacePruneDecision
  readonly previousErrorSummary: string | null
  readonly expectedLifecycleRevision?: number
  readonly nodeChanges?: readonly TaskNodeChangeV1[]
  readonly sourceTerminationEffectRef?: string | null
  readonly committedEventIdentity?: Partial<TaskCommittedEventIdentity>
  readonly onTransitionTx?: (
    tx: Tx,
    transition: Readonly<{ from: TaskStatus; to: TaskStatus }>,
    collector: Readonly<{ addNodeChanges(changes: readonly TaskNodeChangeV1[]): void }>,
  ) => void | Promise<void>
}

/** A miss stops before the companion. Strict/error adaptation and publication
 * remain at the existing entry points, outside this transaction-local program. */
export function* taskLifecycleWriteSequence<Tx extends ProviderNeutralDatabase>(
  tx: Tx,
  input: TaskLifecycleWriteInput<Tx>,
  append: (
    tx: Tx,
    event: TaskLifecycleTransitionCommittedEventInput,
  ) => CommittedEventRef | null | Promise<CommittedEventRef | null>,
): Generator<
  TransactionProgramStep,
  { lifecycleEventRevision: number; eventRef: CommittedEventRef | null } | null,
  void
> {
  const prune = input.workspacePruneDecision
  // rfc097-allow-direct-task-status-write -- single allowlisted writer
  const updated = yield* transactionStep(() =>
    tx
      .update(tasks)
      .set({
        status: input.to,
        ...(input.to === 'running'
          ? { runningSince: input.now }
          : input.from === 'running'
            ? {
                runningMs: sql`${tasks.runningMs} + (${input.now} - COALESCE(${tasks.runningSince}, ${input.now}))`,
                runningSince: null,
              }
            : {}),
        ...(input.extra ?? {}),
        ...(prune.prune ? { workspacePruningAt: input.now, workspacePruneCause: prune.cause } : {}),
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.status, input.from),
          ...(input.expectedLifecycleRevision === undefined
            ? []
            : [eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision)]),
          ...(input.isRevival
            ? [isNull(tasks.workspacePruningAt), isNull(tasks.workspacePrunedAt)]
            : []),
          ...(prune.prune
            ? [
                isNull(tasks.workspacePruningAt),
                isNull(tasks.workspacePruneCause),
                isNull(tasks.workspacePrunedAt),
              ]
            : []),
        ),
      )
      .returning({ id: tasks.id, lifecycleEventRevision: tasks.lifecycleEventRevision })
      .all(),
  )
  const changed = updated[0]
  if (changed === undefined) return null
  const nodeChanges = [...(input.nodeChanges ?? [])]
  yield* transactionStep(() =>
    input.onTransitionTx?.(
      tx,
      { from: input.from, to: input.to },
      {
        addNodeChanges: (changes) => {
          nodeChanges.push(...changes)
        },
      },
    ),
  )
  const eventRef = yield* transactionStep(() =>
    append(tx, {
      taskId: input.taskId,
      lifecycleRevision: changed.lifecycleEventRevision,
      previousStatus: input.from,
      status: input.to,
      errorSummary:
        input.extra?.errorSummary === undefined
          ? input.previousErrorSummary
          : (input.extra.errorSummary ?? null),
      nodeChanges,
      workspacePruneClaim: prune.prune
        ? { claimedAt: new Date(input.now).toISOString(), cause: prune.cause }
        : null,
      sourceTerminationEffectRef: input.sourceTerminationEffectRef,
      identity: input.committedEventIdentity,
      occurredAt: input.now,
    }),
  )
  return { lifecycleEventRevision: changed.lifecycleEventRevision, eventRef }
}
