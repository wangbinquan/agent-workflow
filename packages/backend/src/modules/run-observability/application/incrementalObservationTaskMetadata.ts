import type {
  CompleteObservationTask,
  ObservationAttemptFacts,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import type { ProjectionObservationTaskSource } from '../ports/taskObservations'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import { buildCompleteObservationTiming } from './completeObservationTiming'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { IncrementalObservationContributionFold } from '../domain/incrementalObservationFold'

/** Task lifecycle and cheap attempt identities are separate from numeric calls.
 * A new usage fact never opens all of this Task's native/numeric sources. */
export async function projectionTaskMetadata(input: {
  readonly task: ObservationTaskFacts
  readonly tasks: ProjectionObservationTaskSource
  readonly acceptedAttempts: ReadonlySet<string>
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly asOf: number
  readonly signal: AbortSignal
}) {
  const fold: IncrementalObservationContributionFold = emptyCompleteObservationFold()
  let attempts = 0n,
    after: string | undefined
  const timingAttempts: ObservationAttemptFacts[] = []
  for (;;) {
    input.signal.throwIfAborted()
    const page = await input.tasks.attemptPage!(input.task.id, {
      limit: 200,
      ...(after ? { after } : {}),
    })
    for (const attempt of page.items) {
      timingAttempts.push(attempt)
      attempts++
      if (
        !input.acceptedAttempts.has(attempt.id) &&
        (attempt.computeKind === undefined ||
          attempt.computeKind === 'unknown' ||
          (attempt.computeKind === 'agent' && attempt.startedAt !== null))
      )
        completeObservationGap(fold, 'invocation-unobserved')
    }
    await input.rows.insert(
      input.namespace + '/attempts',
      page.items.map((document: ObservationAttemptFacts) => ({ key: document.id, document })),
    )
    if (page.nextCursor === null) break
    if (page.nextCursor === after)
      throw new Error('Projection original attempt EOF did not advance')
    after = page.nextCursor
  }
  const [backlog] = await input.tasks.sourceBacklog([input.task.id])
  if (!backlog) throw new Error('Projection original backlog proof missing')
  if (backlog.pendingRecords !== 0) completeObservationGap(fold, 'source-projection-pending')
  const contribution = {
    ...fold,
    inventory: {
      tasks: '1',
      attempts: String(attempts),
      numericRecords: '0',
      nativeCaptures: '0',
    },
  }
  const task: CompleteObservationTask = {
    task: input.task,
    metrics: completeObservationMetrics(contribution),
    attemptCount: String(attempts),
    timing: await buildCompleteObservationTiming({
      task: input.task,
      asOf: input.asOf,
      rows: input.rows,
      namespace: input.namespace + '/timing',
      attemptsNamespace: input.namespace + '/attempts',
      signal: input.signal,
    }),
  }
  return { task, fold: contribution, timingAttempts }
}
