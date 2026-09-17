// RFC-165 §4 — single-agent launch: run ONE agent as a task without the user
// authoring a workflow. The agent's task prompt is the launch `description`;
// the framework synthesizes a minimal host snapshot (input → agent-single,
// plus an OPTIONAL clarify channel) that runs through the NORMAL runScope
// engine — zero engine branches, unlike the workgroup host.
//
// The builtin `__agent_host__` workflow row is a lazily-seeded FK anchor
// (fusion / workgroup precedent): its stored definition is an empty stub —
// every agent task freezes its own synthesized snapshot at launch. Launch
// enters at the SERVICE layer; `assertWorkflowLaunchable` would 403 the
// builtin host via /api/tasks by design (RFC-104), which keeps the generic
// endpoint unable to target it.

import {
  buildClarifyEdges,
  deriveAgentLaunchForm,
  WORKFLOW_SCHEMA_VERSION,
  type AgentInputPort,
  type AgentLaunchForm,
  type StartAgentTask,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

export const AGENT_HOST_WORKFLOW_ID = '00000000000000AGENTHOST00'
export const AGENT_HOST_WORKFLOW_NAME = '__agent_host__'

export const AGENT_HOST_INPUT_NODE_ID = '__agent_input__'
export const AGENT_HOST_AGENT_NODE_ID = '__agent_main__'
export const AGENT_HOST_CLARIFY_NODE_ID = '__agent_clarify__'
/** The single workflow input key; the launch `description` rides this port. */
export const AGENT_HOST_INPUT_KEY = 'description'

/**
 * Synthesize the frozen workflow snapshot for a single-agent task, plus —
 * when the launcher allows clarify — an OPTIONAL clarify channel
 * (`sessionMode:'isolated'`, `clarifyMode:'optional'`, F12). Values are
 * injected through input PORTS, so a literal `{{...}}` inside user text is
 * never re-expanded by the template engine.
 *
 * Two shapes (RFC-218):
 *  - ZERO-PORT agent → the RFC-165 legacy shape, byte-for-byte: one
 *    `description` input riding node `__agent_input__` into promptTemplate
 *    `{{description}}`. Structurally unchanged — this branch is the AC-2
 *    byte-compat guarantee.
 *  - PORT-DECLARING agent → one input node per declared port
 *    (`__agent_input_{i}__`, declaration order), one edge per port, and the
 *    uniform XML port-envelope promptTemplate from the shared derivation
 *    layer (agentLaunchForm.ts — the frontend renders the SAME derived defs).
 */
export function buildAgentHostSnapshot(
  // RFC-223 (PR-3a): `id` freezes the CANONICAL agent reference onto the synthetic
  // agent-single node so resume/retry dispatches by id (rename/ABA-safe), never
  // re-resolving the mutable name. `sourceAgentId` on the task mirrors it.
  agent: { id: string; name: string; inputs?: AgentInputPort[] },
  allowClarify: boolean,
): {
  $schema_version: number
  inputs: unknown[]
  nodes: unknown[]
  edges: unknown[]
} {
  const form = deriveAgentLaunchForm(agent.inputs)
  if (form === null) {
    return {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [
        {
          kind: 'text',
          key: AGENT_HOST_INPUT_KEY,
          label: 'Task description',
          required: true,
          multiline: true,
        },
      ],
      nodes: [
        { id: AGENT_HOST_INPUT_NODE_ID, kind: 'input', inputKey: AGENT_HOST_INPUT_KEY },
        {
          id: AGENT_HOST_AGENT_NODE_ID,
          kind: 'agent-single',
          agentName: agent.name,
          agentId: agent.id,
          promptTemplate: `{{${AGENT_HOST_INPUT_KEY}}}`,
        },
        ...(allowClarify
          ? [
              {
                id: AGENT_HOST_CLARIFY_NODE_ID,
                kind: 'clarify',
                sessionMode: 'isolated',
                clarifyMode: 'optional',
              },
            ]
          : []),
      ],
      edges: [
        {
          id: 'e_input_agent',
          source: { nodeId: AGENT_HOST_INPUT_NODE_ID, portName: AGENT_HOST_INPUT_KEY },
          target: { nodeId: AGENT_HOST_AGENT_NODE_ID, portName: AGENT_HOST_INPUT_KEY },
        },
        ...(allowClarify
          ? buildClarifyEdges(AGENT_HOST_AGENT_NODE_ID, AGENT_HOST_CLARIFY_NODE_ID)
          : []),
      ],
    }
  }

  // Ported shape. Input node ids are index-based (`__agent_input_0__`) — the
  // index form is also the relaunch discriminator (design P1-1: the legacy id
  // `__agent_input__` shares the prefix, so detection matches /_\d+__$/).
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: form.inputs,
    nodes: [
      ...form.inputs.map((def, i) => ({
        id: `__agent_input_${i}__`,
        kind: 'input',
        inputKey: def.key,
      })),
      {
        id: AGENT_HOST_AGENT_NODE_ID,
        kind: 'agent-single',
        agentName: agent.name,
        agentId: agent.id,
        promptTemplate: form.promptTemplate,
      },
      ...(allowClarify
        ? [
            {
              id: AGENT_HOST_CLARIFY_NODE_ID,
              kind: 'clarify',
              sessionMode: 'isolated',
              clarifyMode: 'optional',
            },
          ]
        : []),
    ],
    edges: [
      ...form.inputs.map((def, i) => ({
        id: `e_input_${i}`,
        source: { nodeId: `__agent_input_${i}__`, portName: def.key },
        target: { nodeId: AGENT_HOST_AGENT_NODE_ID, portName: def.key },
      })),
      ...(allowClarify
        ? buildClarifyEdges(AGENT_HOST_AGENT_NODE_ID, AGENT_HOST_CLARIFY_NODE_ID)
        : []),
    ],
  }
}

/**
 * RFC-218 — the conditional launch-shape matrix (design §5.1), shared by the
 * immediate launch path (`startAgentTask`) and scheduled create/update
 * (`scheduledTasks.ts`) so a schedule that must fail every fire cannot be
 * saved. Throws `agent-launch-invalid`; returns the derived form (null for a
 * zero-port agent).
 *
 * `multipart` says whether this launch can bind upload files. Upload-kind
 * (path<ext>) ports are multipart-only: their port values are SERVER-written
 * from landed files; client-provided strings are never trusted (D14).
 */
export function validateAgentLaunchShape(
  agentInputs: AgentInputPort[] | undefined,
  payload: Pick<StartAgentTask, 'description' | 'inputs'>,
  opts: { multipart: boolean },
): AgentLaunchForm | null {
  const form = deriveAgentLaunchForm(agentInputs)
  if (form === null) {
    if (payload.inputs !== undefined) {
      throw new ValidationError(
        'agent-launch-invalid',
        "this agent declares no input ports — launch with 'description', not 'inputs'",
      )
    }
    if (payload.description === undefined) {
      throw new ValidationError(
        'agent-launch-invalid',
        "'description' is required for an agent with no declared input ports",
      )
    }
    return null
  }

  if (form.blockers.length > 0) {
    throw new ValidationError(
      'agent-launch-invalid',
      'this agent cannot be launched manually (blocked input ports)',
      {
        issues: form.blockers.map((b) =>
          b.kind === 'signal-port'
            ? {
                message: `port '${b.port}' has a signal kind — signal ports cannot be filled by hand`,
              }
            : { message: `port '${b.port}' cannot be a template token (${b.reason})` },
        ),
      },
    )
  }
  if (payload.description !== undefined) {
    throw new ValidationError(
      'agent-launch-invalid',
      "this agent declares input ports — launch with 'inputs', not 'description'",
    )
  }
  if (payload.inputs === undefined) {
    throw new ValidationError(
      'agent-launch-invalid',
      "'inputs' is required for an agent with declared input ports",
    )
  }

  const defs = new Map(form.inputs.map((d) => [d.key, d]))
  const unknown = Object.keys(payload.inputs).filter((k) => !defs.has(k))
  if (unknown.length > 0) {
    throw new ValidationError('agent-launch-invalid', 'inputs contain undeclared port keys', {
      issues: unknown.map((k) => ({ message: `unknown input port '${k}'` })),
    })
  }

  const uploadKeys = form.inputs.filter((d) => d.kind === 'upload').map((d) => d.key)
  if (uploadKeys.length > 0 && !opts.multipart) {
    throw new ValidationError(
      'agent-launch-invalid',
      'this agent declares path-kind input ports — files must be bound via a multipart launch (path values are server-written)',
      { issues: uploadKeys.map((k) => ({ message: `port '${k}' requires file upload` })) },
    )
  }

  // Own-property reads only (impl-gate P2-2 defense-in-depth): the blocker
  // set already rejects Object.prototype names, but a plain-object lookup on
  // an inherited key must never leak a function into `.trim()`.
  const ownValue = (key: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(payload.inputs, key) ? payload.inputs![key] : undefined
  const missing = form.inputs.filter(
    (d) =>
      d.kind !== 'upload' &&
      d.required === true &&
      (ownValue(d.key) === undefined || ownValue(d.key)!.trim() === ''),
  )
  if (missing.length > 0) {
    throw new ValidationError('agent-launch-invalid', 'required input ports are missing', {
      issues: missing.map((d) => ({ message: `port '${d.key}' is required` })),
    })
  }
  return form
}

// RFC-359 AC-1（plan §5hn 批次二 ⑧）：`startAgentTask` 整份删除——它是 legacy 启动路的单代理
// 入口，门面（`services/execution/executor.ts`）退役后生产零消费者。单代理启动现在只有一条：
// 启动参与者的单代理臂 → 根启动内核（两个引擎共用）。本文件剩下的是**合成宿主快照**与
// **启动表单校验**（`validateAgentLaunchShape`），启动路与测试都还在用。
