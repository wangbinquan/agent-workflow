import {
  DAEMON_RESTART_ERROR_SUMMARY,
  isDaemonInterruptionAbortReason,
} from '@agent-workflow/shared'
import type { TaskRunPorts } from '../../application/ports/taskRun'
import { taskStopProjection, type TaskStopCause } from '../../domain/sourceTermination'
import type { TaskScopeOutcome } from '../../domain/taskEngine'

// RFC-408 — the task control plane's terminal writes and outcome settlement, moved verbatim from
// composition/taskEngineApplication.ts (`failRuntimeTask` / `cancelRuntimeTask` and the tail of the
// orchestrator after the drive).

/** What the terminal writes and the outcome settlement read from the task control plane's ports. */
export type TaskSettlementPorts = Pick<
  TaskRunPorts<unknown>,
  'taskId' | 'log' | 'settlementLog' | 'execution' | 'signal' | 'persistence' | 'reviewMutation'
>

function taskStopCauseFromUnknown(value: unknown): TaskStopCause | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null
  const candidate = value as TaskStopCause
  switch (candidate.kind) {
    case 'user':
    case 'daemon-shutdown':
      return candidate
    case 'parent-cascade':
      return typeof candidate.parentTaskId === 'string' ? candidate : null
    case 'webhook-terminal':
      return (candidate.terminal === 'closed' || candidate.terminal === 'merged') &&
        typeof candidate.deliveryId === 'string' &&
        Number.isInteger(candidate.streamRevision)
        ? candidate
        : null
    default:
      return null
  }
}

export async function failTaskRun(
  ports: TaskSettlementPorts,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
): Promise<void> {
  const won = await ports.persistence.runtimeLifecycle.trySet({
    taskId: ports.taskId,
    to: 'failed',
    allowedFrom: ['pending', 'running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary,
      errorMessage,
      ...(failedNodeId === undefined ? {} : { failedNodeId }),
    },
    ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
    now: Date.now(),
    reason: `failTask: ${errorSummary}`,
  })
  if (!won) {
    ports.settlementLog.warn('failTask write lost to a concurrent transition — respecting winner', {
      taskId: ports.taskId,
      errorSummary,
    })
  }
}

export async function cancelTaskRun(
  ports: TaskSettlementPorts,
  failedNodeId?: string,
  abortReason?: unknown,
): Promise<void> {
  await ports.reviewMutation.run(async () => {
    const now = Date.now()
    if (isDaemonInterruptionAbortReason(abortReason)) {
      await ports.persistence.runtimeLifecycle.trySet({
        taskId: ports.taskId,
        to: 'interrupted',
        allowedFrom: ['running'],
        extra: {
          finishedAt: now,
          errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
          errorMessage:
            'daemon shutdown interrupted this task; resume (or auto-resume) continues it',
          ...(failedNodeId === undefined ? {} : { failedNodeId }),
        },
        ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
        now,
        reason: 'cancelTaskRow-shutdown',
      })
      return
    }
    const structuredCause = taskStopCauseFromUnknown(abortReason)
    const projection = taskStopProjection(structuredCause ?? { kind: 'user' })
    const won = await ports.persistence.runtimeLifecycle.trySet({
      taskId: ports.taskId,
      to: 'canceled',
      allowedFrom: ['running'],
      extra: {
        finishedAt: now,
        errorSummary: projection.summary,
        errorMessage:
          structuredCause?.kind === 'webhook-terminal'
            ? `${projection.code}: delivery=${structuredCause.deliveryId} revision=${structuredCause.streamRevision}`
            : structuredCause?.kind === 'parent-cascade' && structuredCause.rootCause !== undefined
              ? `${projection.code}: parent=${structuredCause.parentTaskId} delivery=${structuredCause.rootCause.deliveryId} revision=${structuredCause.rootCause.streamRevision}`
              : projection.code,
        ...(failedNodeId === undefined ? {} : { failedNodeId }),
      },
      ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
      now,
      reason: 'cancelTaskRow',
    })
    if (!won) {
      ports.settlementLog.warn(
        'cancelTaskRow lost to a concurrent transition — respecting winner',
        { taskId: ports.taskId },
      )
    }
  })
}

/**
 * Settle the drive's scope outcome: consume a late manual question first, then fail / cancel / park for
 * review or clarification / complete — cancel keeps precedence and both human-gate parks retry while a
 * durable manual question is pending.
 */
export async function settleTaskScopeOutcome(
  ports: TaskSettlementPorts,
  result: TaskScopeOutcome,
): Promise<void> {
  const { taskId, log } = ports
  // A question can arrive after the frontier's last read. Consume the
  // obligation at the owner-held settle point before choosing any outcome.
  // Explicit cancellation keeps its existing precedence.
  if (result.kind !== 'canceled' && ports.signal?.aborted !== true) {
    const manualPark = await ports.persistence.humanGateLifecycle.settleManualQuestionParks({
      taskId,
      ...(ports.execution === undefined ? {} : { token: ports.execution.token }),
      now: Date.now(),
    })
    if (manualPark.parked) {
      log.info('task parked for a durable manual question at settle', { taskId })
      return
    }
  }

  if (result.kind === 'failed' && result.detail) {
    await failTaskRun(ports, result.detail.summary, result.detail.message, result.detail.nodeId)
    return
  }
  if (result.kind === 'canceled') {
    await cancelTaskRun(ports, result.detail?.nodeId, ports.signal?.reason)
    return
  }
  if (result.kind === 'awaiting_review') {
    // RFC-005: task pauses with status=awaiting_review until a decision lands
    // via REST. Decision handler will call resumeTask which re-enters here.
    // RFC-097: cancel wins — an abort that landed after runScope's last
    // signal check must not be overwritten by a park/terminal write.
    if (ports.signal?.aborted === true) {
      await cancelTaskRun(ports, undefined, ports.signal.reason)
      return
    }
    let parkedForReview = false
    while (true) {
      let manualQuestionPending = false
      const statusBeforeReviewPark = await ports.persistence.drive.findStatus(taskId)
      if (statusBeforeReviewPark === 'awaiting_human') {
        // RFC-333 parks a clarify as soon as its projection commits. If the
        // answer lands while this exact driver is still attached, the live
        // scope can consume the rerun and reach a later review gate without
        // resumeTask ever owning a second driver. Restore the canonical
        // running state before parking the new gate; otherwise workgroup
        // completion can be awaiting_confirmation forever while the task row
        // remains awaiting_human. This mirrors the done-settle path below.
        const unparked = await ports.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks(
          {
            taskId,
            to: 'running',
            allowedFrom: ['awaiting_human'],
            ...(ports.execution !== undefined ? { executionContext: ports.execution } : {}),
            now: Date.now(),
            reason: 'active-clarify-released-before-review',
          },
        )
        manualQuestionPending = unparked.kind === 'manual-question-pending'
      }
      if (!manualQuestionPending) {
        const parked = await ports.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
          taskId,
          to: 'awaiting_review',
          allowedFrom: ['running'],
          ...(ports.execution !== undefined ? { executionContext: ports.execution } : {}),
          now: Date.now(),
          reason: 'scope-awaiting-review',
        })
        manualQuestionPending = parked.kind === 'manual-question-pending'
        if (parked.kind === 'settled') parkedForReview = parked.won
      }
      if (!manualQuestionPending) {
        break
      }
      const manualPark = await ports.persistence.humanGateLifecycle.settleManualQuestionParks({
        taskId,
        ...(ports.execution === undefined ? {} : { token: ports.execution.token }),
        now: Date.now(),
      })
      if (manualPark.parked) {
        log.info('task review outcome yielded to a durable manual question', { taskId })
        return
      }
    }
    if (parkedForReview) {
      log.info('task awaiting human review', { taskId })
    } else {
      const parked = await ports.persistence.drive.findStatus(taskId)
      if (parked === 'awaiting_review') {
        // RFC-333: the review executor already committed TaskParkTx together
        // with the gate projection. Publish that committed status; do not issue
        // a second lifecycle write.
        log.info('task review gate already parked atomically', { taskId })
      } else {
        log.warn('awaiting_review write lost to a concurrent transition — respecting winner', {
          taskId,
        })
      }
    }
    return
  }
  if (result.kind === 'awaiting_human') {
    // RFC-023: an agent (or one or more agent-multi shard children) emitted a
    // <workflow-clarify> envelope. The clarify node_run is parked
    // awaiting_human; the source agent has no rerun row yet — that's
    // created when the user POSTs answers. Per design §7.3 awaiting_human
    // outranks awaiting_review on the task chip when both can fire at once.
    if (ports.signal?.aborted === true) {
      await cancelTaskRun(ports, undefined, ports.signal.reason)
      return
    }
    if (
      await ports.persistence.runtimeLifecycle.trySet({
        taskId,
        to: 'awaiting_human',
        allowedFrom: ['running'],
        ...(ports.execution !== undefined ? { executionContext: ports.execution } : {}),
        now: Date.now(),
        reason: 'scope-awaiting-human',
      })
    ) {
      log.info('task awaiting human clarification', { taskId })
    } else {
      const parked = await ports.persistence.drive.findStatus(taskId)
      if (parked === 'awaiting_human') {
        // RFC-333 T7: clarify creation already committed the node, round,
        // eager question snapshots and task park in one TaskParkTx.
        log.info('task clarify gate already parked atomically', { taskId })
      } else {
        log.warn('awaiting_human write lost to a concurrent transition — respecting winner', {
          taskId,
        })
      }
    }
    return
  }

  // 9. Done. RFC-097: cancel wins — final aborted check before the terminal
  // CAS; a cancelTask fallback racing us resolves by whoever's CAS lands
  // (from-sets are disjoint winners: done from=running vs canceled CAS).
  if (ports.signal?.aborted === true) {
    await cancelTaskRun(ports, undefined, ports.signal.reason)
    return
  }
  let completed = false
  while (true) {
    let manualQuestionPending = false
    const statusBeforeCompletion = await ports.persistence.drive.findStatus(taskId)
    if (
      statusBeforeCompletion === 'awaiting_review' ||
      statusBeforeCompletion === 'awaiting_human'
    ) {
      // A human decision can land while this exact driver is still attached.
      // resumeTask correctly refuses to attach a second driver in that
      // window; after this scope consumes the released rerun and derives
      // `done`, first apply the canonical unpark edge, then complete from
      // running. The scope outcome proves no review/clarify gate remains,
      // and the in-tx manual-question assertion closes the external
      // late-arrival path.
      const unparked = await ports.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
        taskId,
        to: 'running',
        allowedFrom: ['awaiting_review', 'awaiting_human'],
        ...(ports.execution !== undefined ? { executionContext: ports.execution } : {}),
        now: Date.now(),
        reason: 'active-human-gate-released-before-complete',
      })
      manualQuestionPending = unparked.kind === 'manual-question-pending'
    }
    if (!manualQuestionPending) {
      const settled = await ports.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        extra: { finishedAt: Date.now() },
        ...(ports.execution !== undefined ? { executionContext: ports.execution } : {}),
        now: Date.now(),
        reason: 'task-done',
      })
      manualQuestionPending = settled.kind === 'manual-question-pending'
      if (settled.kind === 'settled') completed = settled.won
    }
    if (!manualQuestionPending) {
      break
    }
    const manualPark = await ports.persistence.humanGateLifecycle.settleManualQuestionParks({
      taskId,
      ...(ports.execution === undefined ? {} : { token: ports.execution.token }),
      now: Date.now(),
    })
    if (manualPark.parked) {
      log.info('task completion yielded to a durable manual question', { taskId })
      return
    }
    // The row was dispatched/confirmed between creation and settle. Its
    // obligation is now completed; retry the terminal CAS with the same
    // business outcome and a fresh in-transaction no-obligation check.
  }
  if (completed) {
    log.info('task done', { taskId })
  } else {
    log.warn('done write lost to a concurrent transition — respecting winner', { taskId })
  }
}
