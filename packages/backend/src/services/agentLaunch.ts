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
  deriveAgentLaunchForm,
  serializeWorkflowDefinitionStorageV1,
  StartTaskSchema,
  WorkflowDefinitionSchema,
  type AgentInputPort,
  type AgentLaunchForm,
  type LaunchSpaceFields,
  type StartAgentTask,
  type Task,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { canViewResource } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { getAgent } from '@/services/agent'
import {
  cleanupMaterializedSpace,
  materializeSpace,
  startTask,
  type StartTaskDeps,
} from '@/services/task'
import { applyUploadsToWorktree, validateUploadPlan, type UploadLimits } from '@/services/upload'
import {
  attachWorkspaceCleanupToMultipartError,
  bufferUploadParts,
  collectUploadInputDefs,
  type MultipartFilePart,
} from '@/services/launchMultipart'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { workflows } from '@/db/schema'
import { Paths } from '@/util/paths'
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
      definition: serializeWorkflowDefinitionStorageV1({
        $schema_version: 4,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      builtin: true,
    })
    .onConflictDoNothing({ target: workflows.id })
}

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
  agent: { name: string; inputs?: AgentInputPort[] },
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
          agentName: agent.name,
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
    $schema_version: 4,
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

/**
 * Launch a single-agent task. ACL: the launcher must be able to VIEW the
 * agent (missing and invisible are the identical 404, RFC-099 D1); builtin
 * agents are launch-refused (F16, 403 builtin-readonly). The synthesized
 * snapshot is parsed + statically validated BEFORE any side effect (F14) so
 * an agent whose skill/plugin closure is broken fails the launch with the
 * same `workflow-invalid` surface a workflow launch gets.
 *
 * RFC-218 uploads (`path<ext>` ports): `uploads` is present iff the route
 * received multipart. Execution order is fixed (design §5.2 / P1-2): the
 * whole preflight chain — ACL → OCC → reservation → recheck → blockers +
 * shape matrix → F14 → upload-plan validation — runs BEFORE any filesystem
 * side effect; only then is the space materialized and files landed, all
 * inside the launch reservation, so delete/rename 409s for the entire
 * upload+start window and a failing validation never touches disk.
 */
export async function startAgentTask(
  db: DbClient,
  actor: Actor,
  agentName: string,
  input: StartAgentTask,
  deps: StartTaskDeps,
  uploads?: { parts: MultipartFilePart[]; limits: UploadLimits },
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

    // RFC-218: conditional shape matrix against the CURRENT (post-reservation)
    // agent row — description XOR inputs, unknown keys, required ports,
    // blockers, multipart-only upload ports. Zero side effects yet.
    const form = validateAgentLaunchShape(recheck.inputs, input, {
      multipart: uploads !== undefined,
    })

    // Synthesize + validate up front (F14): parse through the SAME schema the
    // engine consumes, then run the launch-gate validator with the full
    // production context (agents + skills + plugins, R3-3).
    const snapshot = buildAgentHostSnapshot(recheck, input.allowClarify)
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

    // Compose the task-inputs map. Zero-port: the RFC-165 description port.
    // Ported: declared text-port values only — client strings for upload-kind
    // keys are DROPPED here (D14: path values are server-written from landed
    // files, never trusted from the wire).
    let taskInputs: Record<string, string>
    if (form === null) {
      taskInputs = { [AGENT_HOST_INPUT_KEY]: input.description! }
    } else {
      taskInputs = {}
      const defByKey = new Map(form.inputs.map((d) => [d.key, d]))
      for (const [key, value] of Object.entries(input.inputs ?? {})) {
        const def = defByKey.get(key)
        if (def === undefined || def.kind === 'upload') continue
        taskInputs[key] = value
      }
    }

    // Compose the full StartTask candidate; space fields via applySpaceFields
    // (the ONE assembly point) and deep-validate through StartTaskSchema so the
    // repo-source cross-field rules stay single-sourced (workgroup precedent).
    const candidate = applySpaceFields(
      {
        workflowId: AGENT_HOST_WORKFLOW_ID,
        name: input.name,
        inputs: taskInputs,
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

    const agentLaunch = {
      agentName,
      agentId: agent.id,
      snapshotJson: JSON.stringify(def),
    }

    // RFC-218 upload flow — mirrors the workflow multipart route step-for-step
    // (validate plan → materialize → land files → hand off), inside the
    // reservation held above.
    const uploadDefs = form !== null ? collectUploadInputDefs(form.inputs) : new Map()
    if (uploads !== undefined && (uploadDefs.size > 0 || uploads.parts.length > 0)) {
      // Membership check BEFORE buffering (impl-gate P2-4), and buffering
      // AFTER the whole preflight chain above (P1-2) — bytes are only copied
      // for a launch that has already passed ACL/OCC/blockers/F14.
      const files = await bufferUploadParts(uploads.parts, uploadDefs)
      validateUploadPlan({ defs: uploadDefs, files, limits: uploads.limits })
      if (Array.isArray(parsed.data.repos) && parsed.data.repos.length > 1) {
        throw new ValidationError(
          'multi-repo-upload-unsupported',
          'multipart upload inputs are not supported in multi-repo tasks (v1)',
          { repoCount: parsed.data.repos.length },
        )
      }
      const appHome = deps.appHome ?? Paths.root
      const space = await materializeSpace(parsed.data, { db }, appHome)
      if (space.earlyError !== null) {
        // Failed task row so the user sees the error; no files were written.
        return await startTask(parsed.data, { ...deps, materializedSpace: space, agentLaunch })
      }
      let inputsOut: Record<string, string>
      try {
        const result = await applyUploadsToWorktree({
          worktreePath: space.worktreePath,
          defs: uploadDefs,
          files,
          limits: uploads.limits,
        })
        inputsOut = { ...parsed.data.inputs }
        for (const [key, paths] of result.packedByKey.entries()) {
          inputsOut[key] = paths.join('\n')
        }
      } catch (err) {
        const cleanup = await cleanupMaterializedSpace(space)
        throw attachWorkspaceCleanupToMultipartError(err, cleanup)
      }
      return await startTask(
        { ...parsed.data, inputs: inputsOut },
        { ...deps, materializedSpace: space, agentLaunch },
      )
    }

    return await startTask(parsed.data, { ...deps, agentLaunch })
  } finally {
    releaseAgentLaunch(agent.id)
  }
}
