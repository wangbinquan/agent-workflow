import { createAgentNodeExecutionPorts, sourcePortKindOf } from './agentNodeExecution'
import { createFanoutAttempts } from '../engine/node/agent-single/fanoutAttempts'
// RFC-339 — task-execution-owned loop/git/fanout wrapper mechanics. RFC-413: the wrapper workspace (isolation,
// git entry snapshot, merge-back) lives in engine/wrapper/wrapperWorkspace.ts and engine/kernel/wrapperIsolation.ts;
// this file binds the wrapper ports over the execution state and builds a wrapper body's nested state.

import { copyPortArchive } from '@/platform/content/locations/portArchive'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { fanoutInnerAgentRefKey } from '@/services/ref/runtimeRef'

import {
  consumedMapsEqual,
  parseConsumedJson,
} from '@/modules/task-execution/application/runProvenance'
import { encodeConsumedEdges } from '../infrastructure/runSelection/consumedCodec'
import { encodeWrapperProgress } from '@/modules/task-execution/domain/wrapperProgress'
import type { Logger } from '@/util/log'
import { workspaceRecord } from '../infrastructure/isolationWorkspaceView'
import type { TaskMechanicsState } from './taskMechanicsState'
import {
  resolveUpstreamInputs,
  readPortRowAtFrame,
} from '@/modules/task-execution/application/nodeInputs'
import { completeFrameMerges } from '../engine/kernel/mergeRecovery'
import { createWrapperWorkspace } from '../engine/wrapper/wrapperWorkspace'
import { createIsolationMechanicsPorts } from './isolationMechanicsBinding'
import type { WrapperDataPort } from '../application/ports/wrapperData'
import { loadFrameChain } from '../application/frameChain'
import { resolveSourceFrameInScope } from '../domain/environmentChain'
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
    async resolveFanoutAgent(node) {
      const agentId = fanoutInnerAgentRefKey(node as Record<string, unknown>)
      if (agentId === null) return { kind: 'missing' }
      const resolution = await state.taskExecutionResources.injection(agentId)
      return resolution.kind === 'ok' ? { kind: 'ok', agent: resolution.spec.agent } : resolution
    },
    sourcePortKind: (nodeId, portName) => sourcePortKindOf(state, nodeId, portName),
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
    // RFC-354: `frame` is the READER's frame — the body frame `(generation,
    // round)` a loop evaluates its exit condition / output bindings in. The
    // producing node is read in the frame the environment chain resolves it
    // to: a body node locally, a node outside the wrapper as a captured free
    // variable (one generation row outward per enclosing wrapper). A source
    // that is not lexically visible fails loudly instead of reading ''.
    readPort: async (nodeId, portName, frame) => {
      const chain = await loadFrameChain(
        (id: string) => state.opts.persistence.nodeExecution.read(id),
        frame,
      )
      const scopeRow =
        frame.containerRunId === null ? undefined : chain.lookup(frame.containerRunId)
      const resolved = resolveSourceFrameInScope({
        sourceNodeId: nodeId,
        scope: scopeRow?.nodeId ?? null,
        parents: state.containerOf,
        frame,
        containerRowById: chain.lookup,
      })
      if (!resolved.ok) {
        throw new Error(
          `closure-binding-unresolved: port '${nodeId}.${portName}' is not visible from frame ` +
            `${frame.containerRunId ?? 'top'}#${frame.iteration} (${resolved.reason}${resolved.scopeId === null ? '' : ` at ${resolved.scopeId}`})`,
        )
      }
      return await readPortRowAtFrame(
        state.opts.persistence.nodeExecution,
        state.taskId,
        nodeId,
        portName,
        resolved.frame,
        state.definition.nodes.find((node) => node.id === nodeId)?.kind,
      )
    },
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
    async priorFanoutConsumed(nodeId, iteration, excludeRunId) {
      return state.opts.persistence.nodeExecution.snapshotRead(async (snapshot) => {
        const rows = await snapshot.list({ taskId: state.taskId, nodeId, iteration })
        const previous = (
          await snapshot.selection.familyHistory(
            state.taskId,
            {
              nodeId,
              iteration,
              runIds: rows.filter((row) => row.id !== excludeRunId).map((row) => row.id),
            },
            { topLevelOnly: true, consumedOnly: true },
          )
        ).at(-1)
        if (previous === undefined) return null
        return encodeConsumedEdges(await snapshot.selection.consumed(previous.id))
      })
    },
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

  const scopeDriver: WrapperScopeDriverPort = {
    drive(input) {
      const { handle, kind } = workspaceScenes.resolve(input.workspace)
      const innerState: TaskMechanicsState = handle.passthrough
        ? state
        : {
            ...state,
            repos: handle.repos.map((repo, index) => ({
              ...state.repos[index]!,
              ordinal: state.repos[index]!.ordinal,
              repoPath: repo.repoPath,
              worktreePath: repo.isoWorktreePath,
              mountPath:
                kind === 'wrapper-loop'
                  ? (state.repos[index]?.mountPath ?? repo.mountPath)
                  : repo.mountPath,
              readonly: kind === 'wrapper-loop' ? (state.repos[index]?.readonly ?? false) : false,
              baseBranch: repo.baseBranch,
              baseCommit: repo.baseSnapshot,
            })),
            scopeRoot: handle.containerPath,
          }
      const label = kind === 'wrapper-loop' ? 'loop' : 'git'
      const scopeLog = executionLog.child(`${label}:${input.scope.wrapperId}`)
      // RFC-370 — a revived body first finishes the merge-backs a crash or a
      // lost execution lease interrupted in it, into this wrapper's worktree.
      return completeFrameMerges(
        createIsolationMechanicsPorts(innerState),
        { containerRunId: input.containerRunId, iteration: input.iteration },
        scopeLog,
      ).then(() =>
        state.driveScope(innerState, {
          scopeId: input.scope.wrapperId,
          scopeIds: new Set(input.scope.directNodeIds),
          containerRunId: input.containerRunId,
          iteration: input.iteration,
          log: scopeLog,
        }),
      )
    },
  }

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
