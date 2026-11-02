import { agentResolutionResources, createAgentNodeExecutionPorts } from './agentNodeExecution'
import { createFanoutAttempts } from '../engine/node/agent-single/fanoutAttempts'
// RFC-339 — task-execution-owned loop/git/fanout wrapper mechanics. RFC-413: the wrapper workspace (isolation,
// git entry snapshot, merge-back) lives in engine/wrapper/wrapperWorkspace.ts and engine/kernel/wrapperIsolation.ts;
// this file binds the wrapper ports over the execution state. RFC-420: the closure port read and the prior fan-out
// provenance are application/nodeInputs.ts, the fan-out agent and source-port-kind resolution
// application/fanoutAgentResolution.ts, and the wrapper body's entry engine/wrapper/wrapperBodyScope.ts.

import { copyPortArchive } from '@/platform/content/locations/portArchive'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { fanoutInnerAgentRefKey } from '@/services/ref/runtimeRef'

import {
  consumedMapsEqual,
  parseConsumedJson,
} from '@/modules/task-execution/application/runProvenance'
import { encodeWrapperProgress } from '@/modules/task-execution/domain/wrapperProgress'
import type { Logger } from '@/util/log'
import { workspaceRecord } from '../infrastructure/isolationWorkspaceView'
import type { TaskMechanicsState } from './taskMechanicsState'
import {
  priorFanoutConsumedJson,
  readPortInScope,
  resolveUpstreamInputs,
} from '@/modules/task-execution/application/nodeInputs'
import { resolveFanoutAgent, sourcePortKindOf } from '../application/fanoutAgentResolution'
import { completeFrameMerges } from '../engine/kernel/mergeRecovery'
import { createWrapperWorkspace } from '../engine/wrapper/wrapperWorkspace'
import { createWrapperScopeDriver } from '../engine/wrapper/wrapperBodyScope'
import { createIsolationMechanicsPorts } from './isolationMechanicsBinding'
import type { WrapperDataPort } from '../application/ports/wrapperData'
import type { WrapperScopeDriverPort } from '../application/ports/wrapperScopeDriver'
import type { WrapperWorkspacePort } from '../application/ports/wrapperWorkspace'
import type { FanoutAttemptPort } from '../application/ports/fanoutAttempt'

export interface WrapperMechanicsPorts {
  readonly data: WrapperDataPort
  readonly scopeDriver: WrapperScopeDriverPort
  readonly workspace: WrapperWorkspacePort
  readonly fanoutAttempts: FanoutAttemptPort
}

export function createWrapperMechanicsPorts(
  state: TaskMechanicsState,
  executionLog: Logger,
): WrapperMechanicsPorts {
  // RFC-413: the workspace port and its scene table are the engine's; the scope driver resolves a scene's handle.
  const workspaceScenes = createWrapperWorkspace(
    {
      isolation: createIsolationMechanicsPorts(state),
      scopeOf: (handle) => workspaceRecord(handle).scope,
    },
    executionLog,
  )

  const data: WrapperDataPort = {
    definition: state.definition,
    fanoutMaxShardTotal: state.opts.fanoutMaxShardTotal ?? 256,
    fanoutAgentKey: fanoutInnerAgentKey,
    resolveFanoutAgent: (node) => resolveFanoutAgent(agentResolutionResources(state), node),
    sourcePortKind: (nodeId, portName) =>
      sourcePortKindOf(agentResolutionResources(state), nodeId, portName),
    consumedProvenanceMatches(priorJson, current) {
      return consumedMapsEqual(parseConsumedJson(priorJson), current)
    },
    reportDiagnostic(input) {
      executionLog[input.level](input.message, input.fields)
    },
    persistProgress: async (runId, progress) => {
      await state.opts.persistence.nodeExecution.patch({
        nodeRunId: runId,
        values: {
          runtime: {
            wrapperProgressJson: encodeWrapperProgress(progress),
          },
        },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
    // RFC-354: `frame` is the READER's frame (application/nodeInputs.ts `readPortInScope`).
    readPort: (nodeId, portName, frame) =>
      readPortInScope(
        {
          persistence: state.opts.persistence.nodeExecution,
          taskId: state.taskId,
          definition: state.definition,
          parents: state.containerOf,
        },
        nodeId,
        portName,
        frame,
      ),
    resolveInputs: (nodeId, frame) =>
      resolveUpstreamInputs(
        state.opts.persistence.nodeExecution,
        state.taskId,
        state.definition.edges,
        nodeId,
        frame,
        executionLog,
        state.definition,
        state.containerOf,
      ),
    async recordConsumed(runId, consumed) {
      await state.opts.persistence.nodeExecution.patch({
        nodeRunId: runId,
        values: {
          inputs: {
            ...prepareConsumedInputs({ record: consumed }),
          },
        },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
    priorFanoutConsumed: (nodeId, iteration, excludeRunId) =>
      priorFanoutConsumedJson(
        state.opts.persistence.nodeExecution,
        state.taskId,
        nodeId,
        iteration,
        excludeRunId,
      ),
    async outputOf(runId, portName) {
      const row = (await state.opts.persistence.nodeExecution.listOutputs(runId)).find(
        (output) => output.portName === portName,
      )
      return row === undefined
        ? null
        : {
            content: row.content,
            kind: row.kind,
            archiveJson: copyPortArchive(row.archiveJson),
            active: row.active,
          }
    },
    async upsertOutput(input) {
      await state.opts.persistence.nodeExecution.upsertOutputs({
        nodeRunId: input.runId,
        outputs: [
          {
            portName: input.portName,
            content: input.content,
            kind: input.kind ?? null,
            archiveJson: copyPortArchive(input.archiveJson ?? null),
            active: input.active ?? true,
          },
        ],
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
  }

  // RFC-420: the body's entry (mounts, scope log, merge completion, drive) is the engine's; a body state is the
  // outer state over the body's mounts, driven by the outer state's scope driver.
  const scopeDriver: WrapperScopeDriverPort = createWrapperScopeDriver<TaskMechanicsState>(
    {
      outer: state,
      get outerRepos() {
        return state.repos
      },
      resolve: (scene) => workspaceScenes.resolve(scene),
      enter: (mounts) => ({ ...state, ...mounts }),
      completeMerges: (inner, frame, log) =>
        completeFrameMerges(createIsolationMechanicsPorts(inner), frame, log),
      drive: (inner, args) => state.driveScope(inner, args),
    },
    executionLog,
  )

  // RFC-407: the fan-out lines run in the agent executor on its ports.
  const fanoutAttempts = createFanoutAttempts(createAgentNodeExecutionPorts(state), executionLog)

  return { data, scopeDriver, workspace: workspaceScenes.port, fanoutAttempts }
}

// -----------------------------------------------------------------------------
// RFC-040 — wrapper resume helpers shared by the loop and Git strategies.
//
// Why they exist: before RFC-040, both wrappers silently swallowed
// `awaiting_human` / `awaiting_review` signals from their inner scope (only
// `canceled` / `failed` were matched) and either kept iterating (loop) or
// computed a diff against a half-finished worktree (git). The result was N
// ghost clarify/review rows and, for git, a wrong final diff. The fix is to
// (a) bubble the awaiting signal up unchanged, (b) persist enough state on
// the wrapper's node_run so the dispatcher can resume from the same loop
// iteration / git baseline when the user answers clarify or decides review,
// and (c) reuse the existing wrapper node_run row on resume instead of
// minting a fresh one. See design/RFC-040-wrapper-await-bubble/design.md §4.
// RFC-413: the helpers live in engine/kernel/wrapperIsolation.ts (iso rebuild / merge-back),
// engine/wrapper/wrapperWorkspace.ts (git baseline / preDirty) and engine/wrapper/wrapperRunLedger.ts (row reuse).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// wrapper-fanout (RFC-060) — fan a list<T> shardSource into N parallel inner
// dispatches, optionally aggregated by an inner role='aggregator' agent.
//
// PR-D v1 inner-kind support: agent-single only. agent-multi / wrapper-*
// / review / clarify / clarify-cross-agent / output / input inside a
// wrapper-fanout's inner subgraph are PR-D2 scope and fail at runtime with
// `wrapper-fanout-v1-unsupported-inner-kind` (the user gets a clear error
// rather than silent wrong behavior). The validator emits a static warning
// for the nested wrapper-fanout case; runtime rejection here is the
// secondary safety net.
//
// Lifecycle (RFC-053 compatible — D.T8):
//   pending → running → done | failed
// Shard child rows are minted with parentNodeRunId=wrapperRunId so they
// don't bubble into latestPerNode of the wrapper's parent scope.
// -----------------------------------------------------------------------------

/**
 * RFC-223 (PR-3a impl-gate H2): the CANONICAL dedup / lookup key for a
 * wrapper-fanout inner agent node — its stamped `agentId`. Used by BOTH the
 * inner-agent-map hydration and per-shard dispatch. A name-only node returns
 * null and fails closed.
 */
export function fanoutInnerAgentKey(node: {
  agentId?: unknown
  agentName?: unknown
}): string | null {
  // RFC-271 T6d：判据收到 `services/ref/runtimeRef.ts` 的单一读取点。
  // 语义与返回值逐字不变——name-only 节点仍返回 null 并 fail closed。
  return fanoutInnerAgentRefKey(node)
}

// RFC-060 PR-E: runFanOutNode (the M3 agent-multi fan-out implementation)
// was removed. wrapper-fanout (RFC-060) is now the sole fan-out mechanism;
// see FanoutStrategy for the replacement.
