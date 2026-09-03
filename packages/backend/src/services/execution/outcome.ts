// RFC-243 T4 — the unified outcome projection (design §1.3). One answer to
// "the task finished — what did it produce?" for all four execution kinds:
//
//   workflow  → the `output` nodes' io-virtual rows (scheduler.ts output
//               branch), row chosen via pickUpstreamSourceRun — the SAME
//               oracle the in-task downstream read-point uses, so a caller of
//               the executor can never observe a different generation than a
//               downstream node would have (multi-generation review/loop/
//               fanout rows included).
//   agent     → the `__agent_main__` host node's ports, same row oracle.
//   code-round→ the `__code_round__` synthesized node's ports (RFC-304), same
//               oracle again — a round is a task whose subject is a capability
//               round rather than a resource the user picked.
//   workgroup → single `result` port. lw/fc read the explicit result anchor
//               (`workgroup_task_state.result_message_id`, RFC-243 PR-4);
//               until that lands / for legacy tasks: lw falls back to
//               gate_summary, fc to '' + warning (design §6.4 — the wg_* port
//               envelope is deliberately never persisted, RFC-184 invariant).
//               dynamic_workflow in phase 'executing' projects like a workflow.
//
// `projectExecutionOutcome` is a pure function over pre-fetched rows (unit
// tested directly); `getExecutionOutcome` is the thin DB assembler.
import type { TaskExecutionOutcomeReadModel } from '@/modules/task-execution/public/types'
import { createSqliteTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels'
import { NotFoundError } from '@/util/errors'
import { pickLatestSettledRun } from '@/services/freshness'
import { AGENT_HOST_AGENT_NODE_ID } from '@/services/agentLaunch'
import { CODE_ROUND_NODE_ID } from '@/services/codeRoundContract'
import {
  isTerminalTaskStatus,
  taskExecutionKind,
  workgroupModeOf,
  type TaskStatus,
} from '@agent-workflow/shared'
import type { ExecutionOutcome } from './types'

export type OutcomeTaskRow = {
  id: string
  status: string
  errorSummary: string | null
  errorMessage: string | null
  failedNodeId: string | null
  workflowSnapshot: string | null
  workgroupId?: string | null
  workgroupConfigJson?: string | null
  sourceAgentName?: string | null
  /**
   * RFC-304. MUST be selected by every caller that builds this row: the
   * discriminator fields of `taskExecutionKind` are all optional, so a caller
   * that forgets one gets a silent misclassification rather than a type error
   * (a code-round task would read as `workflow` and project outputs from a
   * snapshot that has no output nodes). Locked by rfc304-code-round-outcome.
   */
  codeRoundId?: string | null
}

export type OutcomeRunRow = {
  id: string
  nodeId: string
  iteration: number
  parentNodeRunId: string | null
  status: string
}

export type OutcomeOutputRow = {
  nodeRunId: string
  portName: string
  content: string
  kind: string | null
  /** RFC-306 — false ⇒ the port was closed by a branch marker (absent ⇒ active). */
  active?: boolean
  /** RFC-193 archive reference — copied verbatim into a parent call row so
   *  the forced-port roster keeps covering child-produced gitignored files. */
  archiveJson?: string | null
}

/** lw/fc anchors + dw phase, pre-fetched by the assembler (null = not a workgroup task). */
export type WorkgroupOutcomeInput = {
  gateSummary: string | null
  dwPhase: string | null
  /** PR-4: body of the message `workgroup_task_state.result_message_id` points at. */
  resultMessageBody: string | null
}

/**
 * Output nodes of a snapshot, each with the port names it DECLARES.
 *
 * RFC-306 needs the declared names, not just the node ids: a skipped output node
 * owns no `node_run_outputs` rows, so the only way to report "this port exists
 * but carries nothing" — instead of dropping it from the projection entirely —
 * is to read the names off the definition.
 */
function outputNodesOfSnapshot(
  snapshot: string | null,
  warnings: string[],
): Array<{ id: string; portNames: string[] }> {
  if (snapshot === null || snapshot === '') {
    warnings.push('workflow-snapshot-missing')
    return []
  }
  try {
    const parsed: unknown = JSON.parse(snapshot)
    const nodes = (parsed as { nodes?: unknown }).nodes
    if (!Array.isArray(nodes)) {
      warnings.push('workflow-snapshot-unparsable')
      return []
    }
    return nodes
      .filter(
        (n): n is { id: string; kind: string; ports?: unknown } =>
          typeof n === 'object' &&
          n !== null &&
          (n as { kind?: unknown }).kind === 'output' &&
          typeof (n as { id?: unknown }).id === 'string',
      )
      .map((n) => ({
        id: n.id,
        portNames: Array.isArray(n.ports)
          ? (n.ports as unknown[])
              .map((p) =>
                typeof p === 'object' &&
                p !== null &&
                typeof (p as { name?: unknown }).name === 'string'
                  ? (p as { name: string }).name
                  : null,
              )
              .filter((x): x is string => x !== null)
          : [],
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    warnings.push('workflow-snapshot-unparsable')
    return []
  }
}

function projectOutputNodePorts(
  outputNodes: ReadonlyArray<{ id: string; portNames: readonly string[] }>,
  runs: readonly OutcomeRunRow[],
  outputs: readonly OutcomeOutputRow[],
  warnings: string[],
): ExecutionOutcome['outputs'] {
  const result: ExecutionOutcome['outputs'] = {}
  for (const { id: nodeId, portNames } of outputNodes) {
    const rows = runs.filter((r) => r.nodeId === nodeId)
    // RFC-354: a task-boundary projection sits outside every frame of the task —
    // the answer is the node's latest settled row, whatever frame produced it.
    const picked = pickLatestSettledRun(rows)
    if (picked === undefined) {
      // task done ⟹ every output node has a settled row (lifecycle invariant T3);
      // defensive for hand-edited fixtures / historical rows.
      warnings.push(`output-node-without-done-run:${nodeId}`)
      continue
    }
    // RFC-306 D17 — a SKIPPED output node has no port rows at all. Dropping it
    // silently would make a parent `call-workflow` node see the port simply
    // vanish, and "absent" is indistinguishable from "the child does not declare
    // it" — the branch decision would die at the task boundary. Project the
    // declared names explicitly as inactive instead, so the parent can keep
    // propagating the closed branch.
    if (picked.status === 'skipped') {
      for (const portName of portNames) {
        if (Object.hasOwn(result, portName)) warnings.push(`output-port-collision:${portName}`)
        result[portName] = { content: '', kind: null, active: false }
      }
      continue
    }
    for (const o of outputs) {
      if (o.nodeRunId !== picked.id) continue
      if (Object.hasOwn(result, o.portName)) {
        // cross-output-node port collision — node-id order makes "later wins"
        // deterministic; new definitions are steered away at validate/launch
        // (design §5.4), historical snapshots settle here.
        warnings.push(`output-port-collision:${o.portName}`)
      }
      result[o.portName] = {
        content: o.content,
        kind: o.kind,
        ...(o.archiveJson != null ? { archiveJson: o.archiveJson } : {}),
        // RFC-306: an ACTIVE output node can still project an inactive port when
        // only one of its bindings sat on a closed branch (joinMode 'any').
        ...(o.active === false ? { active: false } : {}),
      }
    }
  }
  return result
}

export function projectExecutionOutcome(args: {
  task: OutcomeTaskRow
  runs: readonly OutcomeRunRow[]
  outputs: readonly OutcomeOutputRow[]
  workgroup: WorkgroupOutcomeInput | null
}): ExecutionOutcome {
  const { task } = args
  const status = task.status as TaskStatus
  const terminal = isTerminalTaskStatus(status)
  const warnings: string[] = []
  const hasError =
    task.errorSummary !== null || task.errorMessage !== null || task.failedNodeId !== null

  let outputs: ExecutionOutcome['outputs'] = {}
  if (status === 'done') {
    const kind = taskExecutionKind(task)
    if (kind === 'workflow') {
      outputs = projectOutputNodePorts(
        outputNodesOfSnapshot(task.workflowSnapshot, warnings),
        args.runs,
        args.outputs,
        warnings,
      )
    } else if (kind === 'agent') {
      outputs = projectOutputNodePorts(
        // An agent-host task has one synthetic node and no declared output-node
        // ports; the empty list only matters for the skipped branch above, which
        // a host node never takes.
        [{ id: AGENT_HOST_AGENT_NODE_ID, portNames: [] }],
        args.runs,
        args.outputs,
        warnings,
      )
    } else if (kind === 'code-round') {
      // RFC-304: a round's output hangs off its single synthesized node, the
      // same way an agent host task's hangs off `__agent_main__`.
      //
      // This branch is not optional bookkeeping. Before it existed, a
      // code-round task fell through to the workgroup arm below, where
      // `workgroupModeOf(null)` returns null and the outcome came back
      // `status: 'done'` with `outputs: {}` and a `workgroup-config-unparsable`
      // warning — a successful-looking result, with empty outputs, blamed on a
      // workgroup config the task never had. Note the failure was in the arm
      // NOBODY would think to check, which is why the kind test below is now
      // explicit rather than an `else`.
      outputs = projectOutputNodePorts(
        [{ id: CODE_ROUND_NODE_ID, portNames: [] }],
        args.runs,
        args.outputs,
        warnings,
      )
    } else if (kind === 'workgroup') {
      const mode = workgroupModeOf(task.workgroupConfigJson)
      const wg = args.workgroup
      if (mode === null || wg === null) {
        warnings.push('workgroup-config-unparsable')
      } else if (mode === 'dynamic_workflow') {
        if (wg.dwPhase === 'executing') {
          outputs = projectOutputNodePorts(
            outputNodesOfSnapshot(task.workflowSnapshot, warnings),
            args.runs,
            args.outputs,
            warnings,
          )
        } else {
          warnings.push('workgroup-dw-not-executing')
        }
      } else if (wg.resultMessageBody !== null) {
        outputs = { result: { content: wg.resultMessageBody, kind: 'text' } }
      } else if (mode === 'leader_worker' && wg.gateSummary !== null) {
        outputs = { result: { content: wg.gateSummary, kind: 'text' } }
      } else {
        warnings.push('workgroup-result-anchor-missing')
        outputs = { result: { content: '', kind: 'text' } }
      }
    } else {
      // Compile-time exhaustiveness. RFC-304 learned this the expensive way:
      // when the workgroup arm was the bare `else`, a newly added kind reported
      // `done` with empty outputs and a misattributed warning, and nothing in
      // the type system objected. A fifth kind now fails to build here instead.
      const unhandled: never = kind
      warnings.push(`unhandled-execution-kind:${String(unhandled)}`)
    }
  }

  return {
    taskId: task.id,
    status,
    terminal,
    outputs,
    warnings,
    ...(hasError
      ? {
          error: {
            summary: task.errorSummary,
            message: task.errorMessage,
            failedNodeId: task.failedNodeId,
          },
        }
      : {}),
  }
}

/** Provider-neutral assembler for the pure projection above. */
export async function getExecutionOutcome(
  source: TaskExecutionOutcomeReadModel | Parameters<typeof createSqliteTaskExecutionReadModels>[0],
  taskId: string,
): Promise<ExecutionOutcome> {
  const reader =
    'find' in source ? source : createSqliteTaskExecutionReadModels(source).executionOutcome
  const snapshot = await reader.find(taskId)
  if (snapshot === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  return projectExecutionOutcome(snapshot)
}
