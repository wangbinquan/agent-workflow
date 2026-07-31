// RFC-242 T4 — the unified outcome projection (design §1.3). One answer to
// "the task finished — what did it produce?" for all three execution kinds:
//
//   workflow  → the `output` nodes' io-virtual rows (scheduler.ts output
//               branch), row chosen via pickUpstreamSourceRun — the SAME
//               oracle the in-task downstream read-point uses, so a caller of
//               the executor can never observe a different generation than a
//               downstream node would have (multi-generation review/loop/
//               fanout rows included).
//   agent     → the `__agent_main__` host node's ports, same row oracle.
//   workgroup → single `result` port. lw/fc read the explicit result anchor
//               (`workgroup_task_state.result_message_id`, RFC-242 PR-4);
//               until that lands / for legacy tasks: lw falls back to
//               gate_summary, fc to '' + warning (design §6.4 — the wg_* port
//               envelope is deliberately never persisted, RFC-184 invariant).
//               dynamic_workflow in phase 'executing' projects like a workflow.
//
// `projectExecutionOutcome` is a pure function over pre-fetched rows (unit
// tested directly); `getExecutionOutcome` is the thin DB assembler.
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workgroupMessages } from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import { pickUpstreamSourceRun } from '@/services/freshness'
import { AGENT_HOST_AGENT_NODE_ID } from '@/services/agentLaunch'
import { loadWorkgroupTaskState } from '@/services/workgroup/state'
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

function outputNodeIdsOfSnapshot(snapshot: string | null, warnings: string[]): string[] {
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
        (n): n is { id: string; kind: string } =>
          typeof n === 'object' &&
          n !== null &&
          (n as { kind?: unknown }).kind === 'output' &&
          typeof (n as { id?: unknown }).id === 'string',
      )
      .map((n) => n.id)
      .sort()
  } catch {
    warnings.push('workflow-snapshot-unparsable')
    return []
  }
}

function projectOutputNodePorts(
  outputNodeIds: readonly string[],
  runs: readonly OutcomeRunRow[],
  outputs: readonly OutcomeOutputRow[],
  warnings: string[],
): ExecutionOutcome['outputs'] {
  const result: ExecutionOutcome['outputs'] = {}
  for (const nodeId of outputNodeIds) {
    const rows = runs.filter((r) => r.nodeId === nodeId)
    const picked = pickUpstreamSourceRun(rows, Number.POSITIVE_INFINITY)
    if (picked === undefined) {
      // task done ⟹ every output node has a done row (lifecycle invariant T3);
      // defensive for hand-edited fixtures / historical rows.
      warnings.push(`output-node-without-done-run:${nodeId}`)
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
        outputNodeIdsOfSnapshot(task.workflowSnapshot, warnings),
        args.runs,
        args.outputs,
        warnings,
      )
    } else if (kind === 'agent') {
      outputs = projectOutputNodePorts(
        [AGENT_HOST_AGENT_NODE_ID],
        args.runs,
        args.outputs,
        warnings,
      )
    } else {
      const mode = workgroupModeOf(task.workgroupConfigJson)
      const wg = args.workgroup
      if (mode === null || wg === null) {
        warnings.push('workgroup-config-unparsable')
      } else if (mode === 'dynamic_workflow') {
        if (wg.dwPhase === 'executing') {
          outputs = projectOutputNodePorts(
            outputNodeIdsOfSnapshot(task.workflowSnapshot, warnings),
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

/** DB assembler for the pure projection above. Throws NotFoundError for a missing row. */
export async function getExecutionOutcome(db: DbClient, taskId: string): Promise<ExecutionOutcome> {
  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      errorSummary: tasks.errorSummary,
      errorMessage: tasks.errorMessage,
      failedNodeId: tasks.failedNodeId,
      workflowSnapshot: tasks.workflowSnapshot,
      workgroupId: tasks.workgroupId,
      workgroupConfigJson: tasks.workgroupConfigJson,
      sourceAgentName: tasks.sourceAgentName,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const task = rows[0]
  if (task === undefined) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)

  let workgroup: WorkgroupOutcomeInput | null = null
  if (taskExecutionKind(task) === 'workgroup') {
    const state = await loadWorkgroupTaskState(db, taskId)
    let resultMessageBody: string | null = null
    if (state.resultMessageId !== null) {
      const msg = await db
        .select({ bodyMd: workgroupMessages.bodyMd })
        .from(workgroupMessages)
        .where(eq(workgroupMessages.id, state.resultMessageId))
        .limit(1)
      resultMessageBody = msg[0]?.bodyMd ?? null
    }
    workgroup = {
      gateSummary: state.gateSummary,
      dwPhase: state.dwState?.phase ?? null,
      resultMessageBody,
    }
  }

  // Row loads are done-only: non-done tasks project empty outputs by contract.
  let runs: OutcomeRunRow[] = []
  let outputs: OutcomeOutputRow[] = []
  if (task.status === 'done') {
    runs = await db
      .select({
        id: nodeRuns.id,
        nodeId: nodeRuns.nodeId,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        status: nodeRuns.status,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    outputs = await db
      .select({
        nodeRunId: nodeRunOutputs.nodeRunId,
        portName: nodeRunOutputs.portName,
        content: nodeRunOutputs.content,
        kind: nodeRunOutputs.kind,
        archiveJson: nodeRunOutputs.archiveJson,
      })
      .from(nodeRunOutputs)
      .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
      .where(eq(nodeRuns.taskId, taskId))
  }

  return projectExecutionOutcome({ task, runs, outputs, workgroup })
}
