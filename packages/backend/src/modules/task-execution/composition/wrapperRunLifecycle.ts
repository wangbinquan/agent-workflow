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
import { loadFrameChain } from '../application/frameChain'
import { resolveSourceFrame } from '../domain/environmentChain'

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
      // RFC-354: a generation is keyed by the FRAME the wrapper node lives in
      // (`request.containerRunId`, null at the top) plus the round inside it —
      // a nested loop re-entered on the outer loop's 2nd round finds no
      // resumable row and mints a fresh generation instead of reusing round 1.
      const existing = await state.opts.persistence.wrapperRuns.findResumable({
        taskId: state.taskId,
        nodeId: request.node.id,
        containerRunId: request.containerRunId,
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

      // RFC-354 — capture the closure: every external source the body reads is
      // bound to the settled row visible in the frame the environment chain
      // resolves it to, from the frame the wrapper node itself lives in. A
      // source the chain cannot see is left out (the body read fails loudly).
      let consumed: Readonly<Record<string, string>> | undefined
      if (kind !== 'wrapper-fanout') {
        const frame = { containerRunId: request.containerRunId, iteration: request.iteration }
        const chain = await loadFrameChain(
          (id: string) => state.opts.persistence.nodeExecution.read(id),
          frame,
        )
        const sources: Array<{ nodeId: string; frame: typeof frame }> = []
        for (const sourceNodeId of [
          ...wrapperExternalUpstreamSources(request.node.id, state.definition),
        ].sort()) {
          const resolved = resolveSourceFrame({
            sourceNodeId,
            targetNodeId: request.node.id,
            parents: state.containerOf,
            frame,
            containerRowById: chain.lookup,
          })
          if (resolved.ok) sources.push({ nodeId: sourceNodeId, frame: resolved.frame })
        }
        consumed = await state.opts.persistence.wrapperRuns.resolveConsumed({
          taskId: state.taskId,
          sources,
        })
      }
      const runId = await state.opts.persistence.nodeRuns.mint({
        taskId: state.taskId,
        nodeId: request.node.id,
        status: 'pending',
        cause: 'wrapper-init',
        containerRunId: request.containerRunId,
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
