// RFC-167 PR-2 — the built-in dynamic-workflow ORCHESTRATOR agent + its prompt
// + the layer-two v1-constraint validator. Pure / side-effect-free so the
// "what the orchestrator is told" and "which generated graphs are legal in v1"
// logic is unit-tested in isolation, mirroring mergeAgent.ts. The engine wiring
// (mint the orchestrator run in a dynamic_workflow workgroup's host snapshot,
// park awaiting_review, swap-and-execute on confirm) lives in the scheduler /
// workgroup runner.
//
// A dynamic_workflow workgroup's AGENT MEMBERS are the orchestratable pool
// (RFC-167 pivot). The orchestrator reads their RFC-166 capability cards + the
// goal (workgroup charter + launch-time goal), and emits a `DwGeneratedWorkflow`
// (agent-single nodes + promptTemplates + edges), which `dwGeneratedToWorkflowDef`
// converts to a standard WorkflowDefinition for `validateWorkflowDef` (layer 1)
// + `validateDynamicWorkflowDef` (layer 2, this file).

import type {
  Agent,
  CapabilitySource,
  WorkflowDefinition,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from '@agent-workflow/shared'
import {
  DW_VALIDATION_CODES,
  perCardInputDescriptionBudget,
  renderRosterCapabilityCards,
} from '@agent-workflow/shared'

/** Name of the framework-internal orchestrator agent (never a user `agents` row). */
export const ORCHESTRATOR_AGENT_NAME = 'aw-workflow-orchestrator'
/** The single output port the orchestrator declares — carries the workflow JSON. */
export const ORCHESTRATOR_WORKFLOW_PORT = 'workflow'
/** Node id of the orchestrator node in the synthesized generation-phase snapshot. */
export const DW_ORCHESTRATOR_NODE_ID = '__dw_orchestrator__'

const ORCHESTRATOR_INPUT_DESCRIPTION_TOTAL_BUDGET = 4_800
const ORCHESTRATOR_CARD_INPUT_DESCRIPTION_MAX = 600

// The phase constants moved to shared (PR-2③ — the frontend maps them to copy
// and the scheduler dispatches on them); re-exported here so existing backend
// imports keep working.
export { DW_PHASES, type DynamicWorkflowPhase } from '@agent-workflow/shared'

/**
 * Synthesize the generation-phase host snapshot: a single agent-single node
 * running the built-in orchestrator (mirrors buildWorkgroupHostSnapshot). It
 * satisfies tasks.workflow_snapshot NOT NULL; the scheduler mints the
 * orchestrator run against this node, then — on human confirm — swaps in the
 * generated DAG (resumeKick extra) and runs it through runScope. Pure.
 */
export function buildDynamicWorkflowGenerateSnapshot(): {
  $schema_version: number
  inputs: unknown[]
  nodes: unknown[]
  edges: unknown[]
} {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: DW_ORCHESTRATOR_NODE_ID, kind: 'agent-single', agentName: ORCHESTRATOR_AGENT_NAME },
    ],
    edges: [],
  }
}

/**
 * The framework's built-in dynamic-workflow orchestrator. Not persisted to the
 * `agents` table — constructed on the fly and handed to `runNode`. It reads a
 * goal + the pool's capability cards (injected at generation time via
 * buildOrchestratorPrompt) and emits ONE workflow-JSON envelope. No skills /
 * deps / mcp / plugins; `model` resolves via resolveInternalAgentRuntime, same
 * as buildMergeAgent.
 */
export function buildOrchestratorAgent(): Agent {
  const now = Date.now()
  return {
    id: '__orchestrator_agent__',
    name: ORCHESTRATOR_AGENT_NAME,
    description: 'Framework built-in: orchestrate an agent pool into a workflow (RFC-167).',
    outputs: [ORCHESTRATOR_WORKFLOW_PORT],
    inputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: [
      'You are a workflow orchestrator. Given a GOAL and a POOL of agents (each',
      'with a capability card describing its inputs, outputs and prompt), design a',
      'workflow that achieves the goal by composing agents from the pool.',
      '',
      'Hard rules (v1):',
      '- Use ONLY agents from the pool. Each agent may be used any number of times',
      '  (as separate nodes with different prompts).',
      '- Every node runs exactly one pool agent. NO loops, fan-outs, git wrappers or',
      '  review nodes — a plain directed acyclic chain/branch of agent nodes only.',
      '- For each node, write a `promptTemplate`: the instruction that node’s agent',
      '  receives. It may reference an upstream node’s output with `{{portName}}`',
      '  (the port must be an output the upstream agent declares).',
      '- Declare each node’s inputs: which upstream node+port feeds each consumed',
      '  port. Source nodes (no upstream) bake the relevant goal detail into their',
      '  promptTemplate directly.',
      '',
      'Reply with EXACTLY one <workflow-output> envelope containing a single',
      `<port name="${ORCHESTRATOR_WORKFLOW_PORT}"> whose text is the workflow JSON:`,
      '{ "nodes": [ { "id", "agentName", "promptTemplate", "inputs": [ { "port",',
      '"from": { "nodeId", "portName" } } ] } ], "edges": [ { "source": { "nodeId",',
      '"portName" }, "target": { "nodeId", "portName" } } ] }.',
    ].join('\n'),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Build the orchestrator's user prompt: the goal (workgroup charter + the
 * launch-time goal, both fed as fixed context) + the pool's capability cards
 * (RFC-166) + optional rejection feedback for a regeneration round. Pure string
 * builder. Prompt-isolation: capability cards never carry a user id (RFC-099).
 */
export function buildOrchestratorPrompt(opts: {
  /** Fixed group charter (workgroup.instructions); '' when unset. */
  charter: string
  /** The per-launch goal the human supplied. */
  goal: string
  /** Pool agents (agent members) — rendered as capability cards. */
  pool: readonly CapabilitySource[]
  /** On a rejected regeneration round, the human's feedback (high priority). */
  rejectionComment?: string | undefined
}): string {
  const lines: string[] = ['## Goal', '']
  if (opts.charter.trim().length > 0) {
    lines.push('Group charter (fixed background):', opts.charter.trim(), '')
  }
  lines.push('This run’s objective:', opts.goal.trim(), '')
  lines.push(
    '## Agent pool',
    '',
    renderRosterCapabilityCards(opts.pool, {
      inputDescriptionBudget: perCardInputDescriptionBudget(
        ORCHESTRATOR_INPUT_DESCRIPTION_TOTAL_BUDGET,
        opts.pool.length,
        ORCHESTRATOR_CARD_INPUT_DESCRIPTION_MAX,
      ),
    }),
    '',
  )
  if (opts.rejectionComment !== undefined && opts.rejectionComment.trim().length > 0) {
    lines.push(
      '## Previous attempt was REJECTED',
      '',
      'A human rejected your previous workflow with this feedback — address it:',
      opts.rejectionComment.trim(),
      '',
    )
  }
  lines.push(
    'Design the workflow now. Reply with exactly one <workflow-output> envelope',
    `containing a single <port name="${ORCHESTRATOR_WORKFLOW_PORT}"> with the workflow JSON.`,
  )
  return lines.join('\n')
}

/** Read a passthrough string field off a workflow node without an `any` cast. */
function readNodeString(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * RFC-167 §4 layer-two validation: the v1 constraints, run AFTER the generic
 * `validateWorkflowDef` (which owns agent-not-found / cycles / port wiring).
 * Returns the same {ok, issues} shape; error-severity issues are merged into the
 * orchestrator's regeneration prompt (like the workgroup malformed-envelope retry).
 */
export function validateDynamicWorkflowDef(
  def: WorkflowDefinition,
  pool: readonly string[],
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []
  const nodes = def.nodes ?? []
  const poolSet = new Set(pool)

  const agentSingleCount = nodes.filter((n) => n.kind === 'agent-single').length
  if (agentSingleCount === 0) {
    issues.push({
      code: DW_VALIDATION_CODES.empty,
      message: 'a dynamic workflow needs at least one agent-single node',
      severity: 'error',
    })
  }

  for (const n of nodes) {
    if (n.kind !== 'agent-single') {
      issues.push({
        code: DW_VALIDATION_CODES.nodeKindForbidden,
        message: `v1 only supports agent-single nodes; node '${n.id}' is '${n.kind}'`,
        pointer: n.id,
        severity: 'error',
      })
      continue
    }
    const agentName = readNodeString(n as unknown as Record<string, unknown>, 'agentName')
    if (agentName !== undefined && !poolSet.has(agentName)) {
      issues.push({
        code: DW_VALIDATION_CODES.agentOutsidePool,
        message: `agent '${agentName}' (node '${n.id}') is not in the workgroup's agent pool`,
        pointer: n.id,
        severity: 'error',
      })
    }
  }

  // Orphan check: with ≥2 nodes, every node must touch at least one edge (a
  // lone island can't participate in the DAG). Single-node workflows are fine.
  if (nodes.length >= 2) {
    const connected = new Set<string>()
    for (const e of def.edges ?? []) {
      connected.add(e.source.nodeId)
      connected.add(e.target.nodeId)
    }
    for (const n of nodes) {
      if (!connected.has(n.id)) {
        issues.push({
          code: DW_VALIDATION_CODES.orphanNode,
          message: `node '${n.id}' is not connected to any other node`,
          pointer: n.id,
          severity: 'error',
        })
      }
    }
  }

  return { ok: !issues.some((i) => (i.severity ?? 'error') === 'error'), issues }
}
