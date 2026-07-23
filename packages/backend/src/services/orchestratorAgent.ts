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
  DwTokenBinding,
  WorkflowDefinition,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from '@agent-workflow/shared'
import {
  DW_VALIDATION_CODES,
  dwMemberToken,
  envelopeOpenTag,
  fenceUntrusted,
  perCardInputDescriptionBudget,
  renderAgentCapabilityCard,
} from '@agent-workflow/shared'

/** Name of the framework-internal orchestrator agent (never a user `agents` row). */
export const ORCHESTRATOR_AGENT_NAME = 'aw-workflow-orchestrator'
/** Stable canonical id for the framework-internal orchestrator agent. */
export const ORCHESTRATOR_AGENT_ID = '__orchestrator_agent__'
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
      {
        id: DW_ORCHESTRATOR_NODE_ID,
        kind: 'agent-single',
        agentId: ORCHESTRATOR_AGENT_ID,
        agentName: ORCHESTRATOR_AGENT_NAME,
      },
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
    id: ORCHESTRATOR_AGENT_ID,
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
      '- Use ONLY agents from the pool, and refer to each one by its exact token',
      '  (the `member#N` heading of its capability card) — that token is the ONLY',
      '  way to name a pool agent. Each agent may be used any number of times (as',
      '  separate nodes with different prompts).',
      '- Every node runs exactly one pool agent. NO loops, fan-outs, git wrappers or',
      '  review nodes — a plain directed acyclic chain/branch of agent nodes only.',
      '- For each node, write a `promptTemplate`: the instruction that node’s agent',
      '  receives. It may reference an upstream node’s output with `{{portName}}`',
      '  (the port must be an output the upstream agent declares).',
      '- Declare each node’s inputs: which upstream node+port feeds each consumed',
      '  port. Source nodes (no upstream) bake the relevant goal detail into their',
      '  promptTemplate directly.',
      '',
      'Reply with EXACTLY one workflow-output envelope, using the exact opening',
      'tag (including its required nonce) supplied by the user prompt protocol,',
      'and containing a single',
      `<port name="${ORCHESTRATOR_WORKFLOW_PORT}"> whose text is the workflow JSON:`,
      '{ "nodes": [ { "id", "agentToken", "promptTemplate", "inputs": [ { "port",',
      '"from": { "nodeId", "portName" } } ] } ], "edges": [ { "source": { "nodeId",',
      '"portName" }, "target": { "nodeId", "portName" } } ] }.',
      'The `agentToken` of each node MUST be one of the `member#N` tokens from the',
      'pool above — never invent a name.',
    ].join('\n'),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * RFC-223 (PR-3b) — one candidate pool member as the orchestrator sees it: an
 * opaque `token` (the ONLY member identity the LLM ever sees/emits) bound to the
 * frozen canonical `agentId` + display `agentName`, plus the `card` source for
 * rendering the (free-text) capability description. `agentName` NEVER reaches
 * the LLM as a machine-readable identity — only inside the free-text card body.
 */
export interface DwPoolMember {
  token: string
  agentId: string
  agentName: string
  card: CapabilitySource
}

/**
 * Assign each distinct pool agent its opaque `member#N` token in the frozen pool
 * order (deterministic from `config.members` → rename/ABA-safe, crash-recoverable
 * without persisting the map). The resolved pool the caller passes is already
 * distinct + id-resolved (see `resolvePool`).
 */
export function buildDwPoolMembers(pool: readonly Agent[]): DwPoolMember[] {
  return pool.map((a, i) => ({
    token: dwMemberToken(i),
    agentId: a.id,
    agentName: a.name,
    card: a,
  }))
}

/** token → frozen agent binding, for the single token→agentId conversion point. */
export function dwPoolTokenMap(members: readonly DwPoolMember[]): Map<string, DwTokenBinding> {
  return new Map(members.map((m) => [m.token, { agentId: m.agentId, agentName: m.agentName }]))
}

/**
 * Build the orchestrator's user prompt: the goal (workgroup charter + the
 * launch-time goal, both fed as fixed context) + the pool's capability cards
 * (RFC-166) + optional rejection feedback for a regeneration round. Pure string
 * builder. Prompt-isolation: capability cards never carry a user id (RFC-099).
 * RFC-223 (PR-3b): each card's heading (the machine-readable identity slot) is
 * the member's opaque `token`, so the LLM never sees a real agent name as a
 * framework identity field; the card BODY (description / prompt summary) is
 * free text that may still mention names (R4-2 — not scrubbed).
 */
export function buildOrchestratorPrompt(opts: {
  /** Fixed group charter (workgroup.instructions); '' when unset. */
  charter: string
  /** The per-launch goal the human supplied. */
  goal: string
  /** Pool members (token + card) — rendered as token-headed capability cards. */
  pool: readonly DwPoolMember[]
  /** On a rejected regeneration round, the human's feedback (high priority). */
  rejectionComment?: string | undefined
  /** Per-run envelope nonce; empty keeps legacy prompt bytes. */
  envelopeNonce?: string | undefined
}): string {
  const nonce = opts.envelopeNonce ?? ''
  const lines: string[] = ['## Goal', '']
  if (opts.charter.trim().length > 0) {
    lines.push(
      'Group charter (fixed background):',
      fenceUntrusted('dynamic-workflow-charter', opts.charter.trim(), nonce),
      '',
    )
  }
  lines.push(
    'This run’s objective:',
    fenceUntrusted('dynamic-workflow-goal', opts.goal.trim(), nonce),
    '',
  )
  const inputDescriptionBudget = perCardInputDescriptionBudget(
    ORCHESTRATOR_INPUT_DESCRIPTION_TOTAL_BUDGET,
    opts.pool.length,
    ORCHESTRATOR_CARD_INPUT_DESCRIPTION_MAX,
  )
  const poolCards = opts.pool
    .map((m) => renderAgentCapabilityCard(m.card, { inputDescriptionBudget, machineRef: m.token }))
    .join('\n\n')
  lines.push(
    '## Agent pool',
    '',
    fenceUntrusted('dynamic-workflow-agent-pool', poolCards, nonce),
    '',
  )
  if (opts.rejectionComment !== undefined && opts.rejectionComment.trim().length > 0) {
    lines.push(
      '## Previous attempt was REJECTED',
      '',
      'A human rejected your previous workflow with this feedback — address it:',
      fenceUntrusted('dynamic-workflow-rejection', opts.rejectionComment.trim(), nonce),
      '',
    )
  }
  lines.push(
    `Design the workflow now. Reply with exactly one ${envelopeOpenTag(nonce)} envelope`,
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
 *
 * RFC-223 (PR-3b): pool membership is decided BY the frozen canonical `agentId`
 * (`poolAgentIds`), not the display name — the generated def is already
 * id-canonical (single conversion point), so this same check re-validates a
 * stored proposal against the CURRENT pool at approve time (a member removed
 * mid-run → `dw-agent-outside-pool`). A node with no `agentId` (an unknown
 * token that slipped past the conversion) also trips it — never a name compare.
 */
export function validateDynamicWorkflowDef(
  def: WorkflowDefinition,
  poolAgentIds: readonly string[],
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []
  const nodes = def.nodes ?? []
  const poolSet = new Set(poolAgentIds)

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
    const agentId = readNodeString(n as unknown as Record<string, unknown>, 'agentId')
    if (agentId === undefined || !poolSet.has(agentId)) {
      issues.push({
        code: DW_VALIDATION_CODES.agentOutsidePool,
        message: `node '${n.id}' does not resolve to an agent in the workgroup's pool`,
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
