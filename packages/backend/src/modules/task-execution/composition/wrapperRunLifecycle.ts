import type { WrapperRunLedgerPort } from '../application/ports/wrapperRunLedger'
import type { WrapperStatusPublisherPort } from '../application/ports/wrapperStatusPublisher'
import {
  WrapperSupersededSignal,
  type OpenWrapperGeneration,
  type WrapperExecutionRequest,
  type WrapperNodeKind,
  type WrapperSettlement,
} from '../domain/wrapperExecution'
import { wrapperExternalUpstreamSources } from '@/services/dispatchFrontier'
import { createLogger } from '@/util/log'
import { broadcastNodeStatus, type SchedulerState } from './nodeMechanics'

function isSupersedableTransitionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'illegal-node-run-transition' || code === 'concurrent-node-run-transition'
}

async function supersedingWrapperOutcome(state: SchedulerState, wrapperRunId: string) {
  const current = await state.opts.persistence.wrapperRuns.readStatus(wrapperRunId)
  if (current === 'canceled') {
    return {
      kind: 'canceled' as const,
      summary: 'wrapper canceled while finalizing',
      message: 'wrapper-superseded-canceled',
    }
  }
  if (current === 'interrupted') {
    return {
      kind: 'failed' as const,
      summary: 'wrapper interrupted while finalizing',
      message: 'wrapper-superseded-interrupted',
    }
  }
  return null
}

async function clearWrapperReuseDisabled(
  state: SchedulerState,
  wrapperRunId: string,
): Promise<void> {
  await state.opts.persistence.wrapperRuns.clearReuseDisabled({
    nodeRunId: wrapperRunId,
    ...(state.opts.executionContext === undefined
      ? {}
      : { executionContext: state.opts.executionContext }),
  })
}

async function settleTerminal(
  state: SchedulerState,
  wrapperRunId: string,
  settlement: WrapperSettlement,
): Promise<void> {
  try {
    await state.opts.persistence.nodeRuns.set({
      nodeRunId: wrapperRunId,
      to: settlement.rowStatus as 'done' | 'failed' | 'canceled' | 'exhausted',
      allowedFrom: ['running', 'awaiting_review', 'awaiting_human'],
      reason: 'wrapper-finalize',
      extra: {
        finishedAt: Date.now(),
        ...(settlement.errorMessage === undefined ? {} : { errorMessage: settlement.errorMessage }),
      },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
  } catch (error) {
    if (!isSupersedableTransitionError(error)) throw error
    const outcome = await supersedingWrapperOutcome(state, wrapperRunId)
    if (outcome === null) throw error
    await clearWrapperReuseDisabled(state, wrapperRunId)
    createLogger('scheduler').info('wrapper finalize superseded by external terminal state', {
      wrapperRunId,
      attempted: settlement.rowStatus,
      outcome: outcome.message,
    })
    throw new WrapperSupersededSignal(outcome)
  }
  await clearWrapperReuseDisabled(state, wrapperRunId)
}

export function createWrapperRunLedger(state: SchedulerState): WrapperRunLedgerPort {
  return {
    async openGeneration<K extends WrapperNodeKind>(
      kind: K,
      request: WrapperExecutionRequest<K>,
    ): Promise<OpenWrapperGeneration<K>> {
      const existing = await state.opts.persistence.wrapperRuns.findResumable({
        taskId: state.taskId,
        nodeId: request.node.id,
        iteration: request.iteration,
      })
      if (existing !== null) {
        const enteredRunning = existing.status !== 'running'
        if (enteredRunning) {
          await state.opts.persistence.nodeRuns.set({
            nodeRunId: existing.id,
            to: 'running',
            allowedFrom: [
              'pending',
              'awaiting_review',
              'awaiting_human',
              'interrupted',
              'canceled',
            ],
            allowTerminal: true,
            reason: kind === 'wrapper-fanout' ? 'wrapper-fanout-resume' : 'wrapper-resume',
            ...(state.opts.executionContext === undefined
              ? {}
              : { executionContext: state.opts.executionContext }),
          })
        }
        return {
          kind,
          runId: existing.id,
          resumed: true,
          enteredRunning,
          previous: existing.previous,
        }
      }

      const consumed =
        kind === 'wrapper-fanout'
          ? undefined
          : await state.opts.persistence.wrapperRuns.resolveConsumed({
              taskId: state.taskId,
              sourceNodeIds: [
                ...wrapperExternalUpstreamSources(request.node.id, state.definition),
              ].sort(),
              iteration: request.iteration,
            })
      const runId = await state.opts.persistence.nodeRuns.mint({
        taskId: state.taskId,
        nodeId: request.node.id,
        status: 'pending',
        cause: 'wrapper-init',
        iteration: request.iteration,
        ...(consumed === undefined
          ? {}
          : { overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) } }),
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      await state.opts.persistence.nodeRuns.transition({
        nodeRunId: runId,
        event: { kind: 'mark-running' },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      return { kind, runId, resumed: false, enteredRunning: true, previous: null }
    },

    async settle<K extends WrapperNodeKind>(
      generation: OpenWrapperGeneration<K>,
      settlement: WrapperSettlement,
    ): Promise<void> {
      if (settlement.rowStatus === 'awaiting_human' || settlement.rowStatus === 'awaiting_review') {
        await state.opts.persistence.nodeRuns.transition({
          nodeRunId: generation.runId,
          event:
            settlement.rowStatus === 'awaiting_human'
              ? { kind: 'park-human' }
              : { kind: 'park-review' },
          ...(state.opts.executionContext === undefined
            ? {}
            : { executionContext: state.opts.executionContext }),
        })
        return
      }
      await settleTerminal(state, generation.runId, settlement)
    },
  }
}

export function createWrapperStatusPublisher(): WrapperStatusPublisherPort {
  return {
    publish(receipt) {
      broadcastNodeStatus(receipt.taskId, receipt.nodeRunId, receipt.nodeId, receipt.status)
    },
  }
}
