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
  applySpaceFields,
  buildClarifyEdges,
  StartTaskSchema,
  WorkflowDefinitionSchema,
  type LaunchSpaceFields,
  type StartAgentTask,
  type Task,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { canViewResource } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { getAgent } from '@/services/agent'
import { startTask, type StartTaskDeps } from '@/services/task'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { workflows } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { acquireAgentLaunch, releaseAgentLaunch } from '@/services/agentLaunchReservation'

export const AGENT_HOST_WORKFLOW_ID = '00000000000000AGENTHOST00'
export const AGENT_HOST_WORKFLOW_NAME = '__agent_host__'

export const AGENT_HOST_INPUT_NODE_ID = '__agent_input__'
export const AGENT_HOST_AGENT_NODE_ID = '__agent_main__'
export const AGENT_HOST_CLARIFY_NODE_ID = '__agent_clarify__'
/** The single workflow input key; the launch `description` rides this port. */
export const AGENT_HOST_INPUT_KEY = 'description'

/**
 * Lazily seed the builtin host workflow row (FK anchor for single-agent
 * tasks). NOT a migration seed — a migration-seeded row would surface in
 * every fresh DB and break empty-fixture expectations; idempotent via
 * onConflictDoNothing (mirrors ensureWorkgroupHostWorkflow).
 */
export async function ensureAgentHostWorkflow(db: DbClient): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: AGENT_HOST_WORKFLOW_ID,
      name: AGENT_HOST_WORKFLOW_NAME,
      description: 'RFC-165 single-agent host anchor — do not launch directly',
      definition: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
      builtin: true,
    })
    .onConflictDoNothing({ target: workflows.id })
}

/**
 * Synthesize the frozen workflow snapshot for a single-agent task:
 * input(description) → agent-single(promptTemplate `{{description}}`), plus —
 * when the launcher allows clarify — an OPTIONAL clarify channel
 * (`sessionMode:'isolated'`, `clarifyMode:'optional'`, F12). The description
 * is injected through the input PORT, so a literal `{{...}}` inside the
 * user's text is never re-expanded by the template engine.
 */
export function buildAgentHostSnapshot(
  agentName: string,
  allowClarify: boolean,
): {
  $schema_version: number
  inputs: unknown[]
  nodes: unknown[]
  edges: unknown[]
} {
  return {
    $schema_version: 4,
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
        agentName,
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

/**
 * Launch a single-agent task. ACL: the launcher must be able to VIEW the
 * agent (missing and invisible are the identical 404, RFC-099 D1); builtin
 * agents are launch-refused (F16, 403 builtin-readonly). The synthesized
 * snapshot is parsed + statically validated BEFORE any side effect (F14) so
 * an agent whose skill/plugin closure is broken fails the launch with the
 * same `workflow-invalid` surface a workflow launch gets.
 */
export async function startAgentTask(
  db: DbClient,
  actor: Actor,
  agentName: string,
  input: StartAgentTask,
  deps: StartTaskDeps,
): Promise<Task> {
  const agent = await getAgent(db, agentName)
  if (agent === null || !(await canViewResource(db, actor, 'agent', agent))) {
    throw new NotFoundError('agent-not-found', `agent '${agentName}' not found`)
  }
  assertNotBuiltin('agent', agent)

  // RFC-175 (§2e): early identity check — reject BEFORE any side effect if the
  // relaunch's expected agent id doesn't match the current same-named agent (a
  // delete+recreate-same-name replacement that completed before launch begins).
  // After the ACL-404 gate; immediate-launch only (never persisted — §2d).
  if (input.expectedAgentId !== undefined && agent.id !== input.expectedAgentId) {
    throw new ConflictError(
      'agent-id-mismatch',
      `agent '${agentName}' is not the expected agent (it may have been replaced)`,
    )
  }

  // RFC-175 (§2e): hold an in-process launch reservation on the agent id for the
  // WHOLE launch (materialize + INSERT) so deleteAgent/renameAgent refuse
  // (agent-launching 409) and the agent cannot be replaced mid-launch. Released
  // in finally on every path (validation / materialize / INSERT throw included).
  acquireAgentLaunch(agent.id)
  try {
    // Post-acquire re-verify: catch a replacement that completed in the tiny
    // resolve→acquire window (before the reservation was held), in the
    // zero-filesystem-side-effect phase.
    const recheck = await getAgent(db, agentName)
    if (recheck === null || recheck.id !== agent.id) {
      throw new ConflictError(
        'agent-id-mismatch',
        `agent '${agentName}' was replaced during launch`,
      )
    }

    await ensureAgentHostWorkflow(db)

    // Synthesize + validate up front (F14): parse through the SAME schema the
    // engine consumes, then run the launch-gate validator with the full
    // production context (agents + skills + plugins, R3-3).
    const snapshot = buildAgentHostSnapshot(agentName, input.allowClarify)
    let def: WorkflowDefinition
    try {
      def = WorkflowDefinitionSchema.parse(snapshot)
    } catch (err) {
      throw new ValidationError('workflow-invalid', 'synthesized agent host snapshot is invalid', {
        issues: err instanceof Error ? [{ message: err.message }] : [],
      })
    }
    const validation = validateWorkflowDef(def, await buildWorkflowValidationContext(db))
    if (!validation.ok) {
      const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
      if (errors.length > 0) {
        throw new ValidationError(
          'workflow-invalid',
          `agent '${agentName}' cannot launch (${errors.length} error${errors.length === 1 ? '' : 's'} in its host snapshot)`,
          { issues: validation.issues },
        )
      }
    }

    // Compose the full StartTask candidate; space fields via applySpaceFields
    // (the ONE assembly point) and deep-validate through StartTaskSchema so the
    // repo-source cross-field rules stay single-sourced (workgroup precedent).
    const candidate = applySpaceFields(
      {
        workflowId: AGENT_HOST_WORKFLOW_ID,
        name: input.name,
        inputs: { [AGENT_HOST_INPUT_KEY]: input.description },
        ...(input.collaboratorUserIds !== undefined && input.collaboratorUserIds.length > 0
          ? { collaboratorUserIds: input.collaboratorUserIds }
          : {}),
        ...(input.gitUserName !== undefined ? { gitUserName: input.gitUserName } : {}),
        ...(input.gitUserEmail !== undefined ? { gitUserEmail: input.gitUserEmail } : {}),
        ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
        ...(input.autoCommitPush !== undefined ? { autoCommitPush: input.autoCommitPush } : {}),
        ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
        ...(input.maxTotalTokens !== undefined ? { maxTotalTokens: input.maxTotalTokens } : {}),
      },
      input as LaunchSpaceFields,
    )
    const parsed = StartTaskSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new ValidationError('agent-launch-invalid', 'invalid agent launch payload', {
        issues: parsed.error.issues,
      })
    }

    return await startTask(parsed.data, {
      ...deps,
      agentLaunch: {
        agentName,
        agentId: agent.id,
        snapshotJson: JSON.stringify(def),
      },
    })
  } finally {
    releaseAgentLaunch(agent.id)
  }
}
