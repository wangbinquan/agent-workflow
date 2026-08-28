import { and, desc, eq } from 'drizzle-orm'
import { nodeRuns } from '@/db/schema'
import type { WrapperRunLedgerPort } from '../application/ports/wrapperRunLedger'
import type { WrapperStatusPublisherPort } from '../application/ports/wrapperStatusPublisher'
import {
  WrapperSupersededSignal,
  type OpenWrapperGeneration,
  type WrapperExecutionRequest,
  type WrapperNodeKind,
  type WrapperRunSnapshot,
  type WrapperSettlement,
} from '../domain/wrapperExecution'
import { wrapperExternalUpstreamSources } from '@/services/dispatchFrontier'
import { pickUpstreamSourceRun } from '@/services/freshness'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import { withCurrentTaskExecutionMutation } from '@/services/taskExecutionParticipants'
import { decodeWrapperProgress, encodeWrapperProgress } from '../domain/wrapperProgress'
import { createLogger } from '@/util/log'
import { broadcastNodeStatus, type SchedulerState } from './nodeMechanics'

function snapshot(row: typeof nodeRuns.$inferSelect): WrapperRunSnapshot {
  return {
    id: row.id,
    status: row.status,
    wrapperProgressJson: row.wrapperProgressJson,
    consumedUpstreamRunsJson: row.consumedUpstreamRunsJson,
    mergeState: row.mergeState,
    isoBaseSnapshot: row.isoBaseSnapshot,
    isoBaseSnapshotReposJson: row.isoBaseSnapshotReposJson,
    isoSubmodulesJson: row.isoSubmodulesJson,
    isoSubmodulesReposJson: row.isoSubmodulesReposJson,
  }
}

async function findResumableWrapperRun(
  state: SchedulerState,
  nodeId: string,
  iteration: number,
): Promise<typeof nodeRuns.$inferSelect | null> {
  const rows = await state.db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, state.taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(desc(nodeRuns.id))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return row.status === 'done' || row.status === 'failed' || row.status === 'exhausted' ? null : row
}

async function computeWrapperConsumed(
  state: SchedulerState,
  wrapperId: string,
  iteration: number,
): Promise<Record<string, string>> {
  const consumed: Record<string, string> = {}
  const sources = [...wrapperExternalUpstreamSources(wrapperId, state.definition)].sort()
  for (const sourceNodeId of sources) {
    const rows = await state.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, state.taskId), eq(nodeRuns.nodeId, sourceNodeId)))
    const run = pickUpstreamSourceRun(rows, iteration)
    if (run !== undefined) consumed[sourceNodeId] = run.id
  }
  return consumed
}

function isSupersedableTransitionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'illegal-node-run-transition' || code === 'concurrent-node-run-transition'
}

async function supersedingWrapperOutcome(state: SchedulerState, wrapperRunId: string) {
  const [current] = await state.db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, wrapperRunId))
  if (current?.status === 'canceled') {
    return {
      kind: 'canceled' as const,
      summary: 'wrapper canceled while finalizing',
      message: 'wrapper-superseded-canceled',
    }
  }
  if (current?.status === 'interrupted') {
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
  const [row] = await state.db
    .select({ wrapperProgressJson: nodeRuns.wrapperProgressJson })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, wrapperRunId))
  const progress = decodeWrapperProgress(row?.wrapperProgressJson, () => {})
  if (progress === null || progress.reuseDisabled !== true) return
  const { reuseDisabled: _cleared, ...rest } = progress
  withCurrentTaskExecutionMutation({
    db: state.db,
    run: (tx) =>
      tx
        .update(nodeRuns)
        .set({ wrapperProgressJson: encodeWrapperProgress(rest) })
        .where(eq(nodeRuns.id, wrapperRunId))
        .run(),
  })
}

async function settleTerminal(
  state: SchedulerState,
  wrapperRunId: string,
  settlement: WrapperSettlement,
): Promise<void> {
  try {
    await setNodeRunStatus({
      db: state.db,
      nodeRunId: wrapperRunId,
      to: settlement.rowStatus as 'done' | 'failed' | 'canceled' | 'exhausted',
      allowedFrom: ['running', 'awaiting_review', 'awaiting_human'],
      reason: 'wrapper-finalize',
      extra: {
        finishedAt: Date.now(),
        ...(settlement.errorMessage === undefined ? {} : { errorMessage: settlement.errorMessage }),
      },
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
      const existing = await findResumableWrapperRun(state, request.node.id, request.iteration)
      if (existing !== null) {
        const enteredRunning = existing.status !== 'running'
        if (enteredRunning) {
          await setNodeRunStatus({
            db: state.db,
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
          })
        }
        return {
          kind,
          runId: existing.id,
          resumed: true,
          enteredRunning,
          previous: snapshot(existing),
        }
      }

      const consumed =
        kind === 'wrapper-fanout'
          ? undefined
          : await computeWrapperConsumed(state, request.node.id, request.iteration)
      const runId = await mintNodeRun(state.db, {
        taskId: state.taskId,
        nodeId: request.node.id,
        status: 'pending',
        cause: 'wrapper-init',
        iteration: request.iteration,
        ...(consumed === undefined
          ? {}
          : { overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) } }),
      })
      await transitionNodeRunStatus({
        db: state.db,
        nodeRunId: runId,
        event: { kind: 'mark-running' },
      })
      return { kind, runId, resumed: false, enteredRunning: true, previous: null }
    },

    async settle<K extends WrapperNodeKind>(
      generation: OpenWrapperGeneration<K>,
      settlement: WrapperSettlement,
    ): Promise<void> {
      if (settlement.rowStatus === 'awaiting_human' || settlement.rowStatus === 'awaiting_review') {
        await transitionNodeRunStatus({
          db: state.db,
          nodeRunId: generation.runId,
          event:
            settlement.rowStatus === 'awaiting_human'
              ? { kind: 'park-human' }
              : { kind: 'park-review' },
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
