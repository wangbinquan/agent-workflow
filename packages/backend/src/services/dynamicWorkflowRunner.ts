// RFC-167 PR-2 — the dynamic-workflow GENERATE engine (design §3.1).
//
// runTask dispatches here for workgroup tasks whose mode is 'dynamic_workflow'
// while dw.phase is anything but 'executing' (deriveWorkgroupDispatch, shared).
// One pass = drive the built-in orchestrator agent to emit a workflow JSON,
// convert + validate it (layer 1 generic validateWorkflowDef, layer 2 v1
// constraints), then park the task behind the human confirm gate:
//
//   generating/rejected ──(orchestrator run + two-layer validation)──▶
//     awaiting_confirm + gate holder run (awaiting_review)
//   validation failure ──▶ bounded retry with the error list injected
//     (DW_MAX_GENERATE_ATTEMPTS total per pass) ──▶ exhausted = failed
//
// The confirm REST (routes/workgroupTasks.ts) swaps the generated DAG into
// task.workflow_snapshot atomically inside resumeKick's admission CAS and
// flips dw.phase='executing'; the resumed runTask then runs the REAL DAG via
// runScope — this engine never executes the generated graph itself.
//
// Mechanics reuse: all process-level work (frozen runtime, iso worktree,
// runNode, merge-back) rides the SAME WorkgroupEngineHooks the round engine
// uses (buildWorkgroupHooks in scheduler.ts) — this module never imports
// scheduler.ts (module-cycle ban) and tests drive it with fake hooks.

import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  DW_VALIDATION_CODES,
  DwGeneratedWorkflowSchema,
  DwStateSchema,
  dwGeneratedToWorkflowDef,
  fenceUntrusted,
  parseTriggerContextJson,
  triggerContextContract,
  WorkgroupRuntimeConfigSchema,
  type Agent,
  type DwState,
  type DwTokenMap,
  type WorkflowDefinition,
  type WorkgroupRuntimeConfig,
  type ParsedTriggerContext,
} from '@agent-workflow/shared'
import type { DynamicWorkflowPersistence } from '@/modules/task-execution/application/ports/dynamicWorkflowPersistence'
import type { NodeRunLifecyclePersistence } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import type { WorkgroupTurnHostOperations } from '@/modules/task-execution/application/ports/workgroupTurnsOperations'
import type { TaskScopeOutcome } from '@/modules/task-execution/domain/taskEngine'
import {
  buildDwPoolMembers,
  buildOrchestratorAgent,
  buildOrchestratorPrompt,
  DW_ORCHESTRATOR_NODE_ID,
  dwPoolTokenMap,
  ORCHESTRATOR_WORKFLOW_PORT,
  validateDynamicWorkflowDef,
} from '@/services/orchestratorAgent'
import { validateWorkflowDef } from '@/services/workflow.validator'
import { triggerPreflightIssue } from '@/services/execution/triggerPreflight'
import type { Logger } from '@/util/log'

/** Total generation attempts per pass (bad JSON / schema / validation all count).
 *  Rides the cross-engine DEFAULT_PROTOCOL_RETRY_BUDGET (here read as TOTAL
 *  attempts, not retries-after-first). */
export const DW_MAX_GENERATE_ATTEMPTS = DEFAULT_PROTOCOL_RETRY_BUDGET
/** Hard cap on human reject→regenerate rounds (design §8 — no infinite loop). */
export const DW_MAX_REJECT_ROUNDS = 10
/** node_runs.rerun_cause of orchestrator generation runs. */
export const DW_GENERATE_CAUSE = 'dw-generate'
/** node_runs.rerun_cause of the confirm-gate holder run (lifecycle invariant:
 *  task awaiting_review ⟹ ∃ awaiting_review node_run; wg-gate precedent). */
export const DW_GATE_CAUSE = 'dw-gate'

export interface DynamicWorkflowEngineArgs {
  persistence: DynamicWorkflowPersistence
  nodeRuns: NodeRunLifecyclePersistence
  validationContext: DynamicWorkflowValidationContextSource
  taskId: string
  log: Logger
  signal?: AbortSignal
  hooks: WorkgroupTurnHostOperations
}

/** Resource Catalog owns the provider-specific inventory projection. */
export interface DynamicWorkflowValidationContextSource {
  load(): Promise<Parameters<typeof validateWorkflowDef>[1]>
}

interface DwDbState {
  config: WorkgroupRuntimeConfig
  dw: DwState
  triggerSource: ParsedTriggerContext
}

async function loadDwDbState(
  persistence: DynamicWorkflowPersistence,
  taskId: string,
): Promise<DwDbState | null> {
  const row = await persistence.loadTask(taskId)
  if (row === null || row.workgroupConfigJson === null || row.dwStateJson === null) return null
  let rawConfig: Record<string, unknown>
  try {
    rawConfig = JSON.parse(row.workgroupConfigJson) as Record<string, unknown>
  } catch {
    return null
  }
  const config = WorkgroupRuntimeConfigSchema.safeParse(rawConfig)
  if (!config.success) return null
  // RFC-217 T2 — the dw checkpoint lives in workgroup_task_state (complete
  // DwState, zod-validated, single writer while the task runs).
  let dw: DwState
  try {
    const parsed = DwStateSchema.safeParse(JSON.parse(row.dwStateJson))
    if (!parsed.success) return null
    dw = parsed.data
  } catch {
    return null
  }
  return { config: config.data, dw, triggerSource: parseTriggerContextJson(row.triggerContextJson) }
}

/**
 * Strip an optional markdown code fence around the orchestrator's JSON payload.
 * LLMs routinely wrap JSON in ```json fences even when told not to; the
 * envelope port text is otherwise verbatim. Pure.
 */
export function extractJsonPayload(text: string): string {
  const trimmed = text.trim()
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return fence?.[1] ?? trimmed
}

/**
 * RFC-243 §5.4(7): a workgroup is a closure LEAF — a generated definition may
 * never contain call nodes (either kind), or execution would bypass the launch-time
 * frozen reference closure and the cross-definition cycle gate. Today's token
 * schema cannot even express one (`dwGeneratedToWorkflowDef` stamps every node
 * `agent-single`), so this is a belt-and-braces admission guard that survives
 * any future loosening of the generated-node schema or of layer-2's kind
 * allowlist. Pure; exported for the RFC-243 regression lock.
 */
export function dwCallNodeRejections(def: WorkflowDefinition): string[] {
  return def.nodes
    .filter((n) => n.kind === 'call-workflow' || n.kind === 'call-workgroup')
    .map(
      (n) =>
        `${DW_VALIDATION_CODES.nodeKindForbidden}: node '${n.id}' is a call node — a generated workflow cannot call other workflows or workgroups; use only the member#N agents listed in the pool`,
    )
}

/**
 * Parse + convert + two-layer-validate one orchestrator `workflow` port
 * payload. RFC-223 (PR-3b): the payload references pool members by opaque
 * `member#N` TOKENS; `dwGeneratedToWorkflowDef` is the single conversion point
 * that resolves each token to its frozen canonical `agentId` (via `tokenMap`).
 * An unknown token is surfaced as a `dw-agent-outside-pool` error referencing
 * the TOKEN (never a name/id). Returns the id-canonical validated definition or
 * the error lines to inject into the retry prompt. Pure except for the layer-1
 * context (caller supplies it).
 */
export function evaluateGeneratedWorkflow(
  rawPort: string | undefined,
  tokenMap: DwTokenMap,
  layer1Ctx: Parameters<typeof validateWorkflowDef>[1],
): { ok: true; def: WorkflowDefinition } | { ok: false; errors: string[] } {
  if (rawPort === undefined || rawPort.trim().length === 0) {
    return { ok: false, errors: [`missing required port '${ORCHESTRATOR_WORKFLOW_PORT}'`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonPayload(rawPort))
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] }
  }
  const gen = DwGeneratedWorkflowSchema.safeParse(parsed)
  if (!gen.success) {
    return {
      ok: false,
      errors: gen.error.issues.map((i) => `schema: ${i.path.join('.')} — ${i.message}`),
    }
  }
  const { def, unknownTokens } = dwGeneratedToWorkflowDef(gen.data, tokenMap)
  // Unknown token = the LLM referenced a member outside the pool. Report the
  // TOKEN (opaque) so the retry prompt speaks the same language the LLM does,
  // and never leak a real name/id (R4-2). Short-circuit: an id-less node would
  // otherwise also raise a confusing layer-1 agent-not-found.
  if (unknownTokens.length > 0) {
    return {
      ok: false,
      errors: unknownTokens.map(
        (t) =>
          `${DW_VALIDATION_CODES.agentOutsidePool}: unknown member '${t}' — reference only the member#N tokens listed in the pool`,
      ),
    }
  }
  // RFC-243 §5.4(7): reject call nodes ahead of the generic layers so the
  // closure-leaf rule cannot be lost to a future kind-allowlist loosening.
  const callNodeErrors = dwCallNodeRejections(def)
  if (callNodeErrors.length > 0) {
    return { ok: false, errors: callNodeErrors }
  }
  const poolAgentIds = [...new Set([...tokenMap.values()].map((b) => b.agentId))]
  const layer1 = validateWorkflowDef(def, layer1Ctx)
  const layer2 = validateDynamicWorkflowDef(def, poolAgentIds)
  const errors = [...layer1.issues, ...layer2.issues]
    .filter((i) => (i.severity ?? 'error') === 'error')
    .map((i) => `${i.code}: ${i.message}`)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, def }
}

/**
 * Resolve the orchestratable pool: the group's agent members, resolved BY the
 * frozen canonical `agentId` (RFC-223 PR-3b — rename/ABA-safe; NO name lookup),
 * deduped by id. A member with no frozen id (pre-RFC-223 / the R4-1 quarantine
 * sentinel) or a dangling id (agent deleted after launch) resolves to nothing
 * and is skipped — a fully unresolvable pool fails closed upstream. The pool
 * order here defines the deterministic `member#N` token assignment.
 */
async function resolvePool(
  persistence: DynamicWorkflowPersistence,
  config: WorkgroupRuntimeConfig,
): Promise<Agent[]> {
  const seen = new Set<string>()
  const pool: Agent[] = []
  for (const m of config.members) {
    if (m.memberType !== 'agent') continue
    const agentId = typeof m.agentId === 'string' && m.agentId.length > 0 ? m.agentId : null
    if (agentId === null || seen.has(agentId)) continue
    seen.add(agentId)
    const agent = await persistence.loadAgent(agentId)
    if (agent !== null) pool.push(agent)
  }
  return pool
}

/** Mint the confirm-gate holder run (task awaiting_review lifecycle invariant). */
async function openDwGate(nodeRuns: NodeRunLifecyclePersistence, taskId: string): Promise<void> {
  const gateRunId = await nodeRuns.mint({
    taskId,
    nodeId: DW_ORCHESTRATOR_NODE_ID,
    status: 'pending',
    cause: DW_GATE_CAUSE,
  })
  await nodeRuns.set({
    nodeRunId: gateRunId,
    to: 'awaiting_review',
    allowedFrom: ['pending'],
    reason: 'dw-gate-open',
  })
}

const AWAITING_CONFIRM_RESULT: TaskScopeOutcome = {
  kind: 'awaiting_review',
  detail: { summary: 'dynamic workflow awaiting confirmation', message: 'dw-gate' },
}

/**
 * One generation pass (design §3.1). Persisted `(dw.phase, dw.generateAttempts,
 * dw.generatedDef)` is the idempotent checkpoint: re-entry after a crash or a
 * bare resume re-reads it and continues (attempts never reset mid-pass).
 */
export async function runDynamicWorkflowGenerate(
  args: DynamicWorkflowEngineArgs,
): Promise<TaskScopeOutcome> {
  const { persistence, nodeRuns, taskId, log, hooks } = args

  const state = await loadDwDbState(persistence, taskId)
  if (state === null) {
    return {
      kind: 'failed',
      detail: {
        summary: 'dynamic workflow config missing or invalid',
        message: 'workgroup_config_json unreadable or dw state missing',
      },
    }
  }
  const { config } = state
  let dw = state.dw

  if (state.triggerSource.kind === 'invalid') {
    return {
      kind: 'failed',
      detail: {
        summary: 'trigger-context-invalid',
        message: 'the frozen task trigger context is invalid',
      },
    }
  }

  // Defensive: the dispatch oracle never routes 'executing' here; if a future
  // caller does, refuse loudly rather than re-running generation over a task
  // whose snapshot is already the real DAG.
  if (dw.phase === 'executing') {
    return {
      kind: 'failed',
      detail: {
        summary: 'dw-phase-invariant',
        message: `generate engine invoked with phase='executing' (task ${taskId})`,
      },
    }
  }

  // Idempotent re-entry while parked: a bare resume (no confirm decision) must
  // re-park, not regenerate. The holder run usually survives; re-mint if a
  // crash lost it (the awaiting_review lifecycle invariant needs one).
  if (dw.phase === 'awaiting_confirm') {
    if (!(await persistence.hasAwaitingConfirmationRun(taskId, DW_GATE_CAUSE))) {
      await openDwGate(nodeRuns, taskId)
    }
    return AWAITING_CONFIRM_RESULT
  }

  const pool = await resolvePool(persistence, config)
  if (pool.length === 0) {
    return {
      kind: 'failed',
      detail: {
        summary: 'dynamic workflow agent pool is empty',
        message: 'no agent member resolves to an existing agent (deleted after launch?)',
      },
    }
  }
  // RFC-223 (PR-3b): assign each pool agent its opaque `member#N` token; the
  // LLM only ever sees / emits tokens. The map is the single point where a
  // returned token is converted back to a canonical agentId.
  const members = buildDwPoolMembers(pool)
  const tokenMap = dwPoolTokenMap(members)
  const layer1Ctx = await args.validationContext.load()
  const orchestrator = buildOrchestratorAgent()

  // Codex impl-gate P2 (re-review): a task that failed 'dw-generate-exhausted'
  // persists generateAttempts === MAX. Reaching this point again means a HUMAN
  // resumed the failed task — that is an explicit "try again" and grants a
  // fresh attempt budget; without the reset the loop below would run zero
  // times and instantly re-fail with no new information. This never
  // self-loops: exhaustion fails the task, and only a manual resume (boot
  // auto-resume targets interrupted-only) re-enters with attempts at MAX.
  if (dw.generateAttempts >= DW_MAX_GENERATE_ATTEMPTS) {
    log.info('dynamic workflow resume grants a fresh generation budget', {
      taskId,
      priorAttempts: dw.generateAttempts,
    })
    dw = { ...dw, generateAttempts: 0 }
    await persistence.saveState(taskId, dw)
  }

  let errorNotice: string | null = null
  while (dw.generateAttempts < DW_MAX_GENERATE_ATTEMPTS) {
    if (args.signal?.aborted === true) return { kind: 'canceled' }

    const priorRunCount = await persistence.countNodeRuns(taskId, DW_ORCHESTRATOR_NODE_ID)
    const runId = await nodeRuns.mint({
      taskId,
      nodeId: DW_ORCHESTRATOR_NODE_ID,
      status: 'pending',
      cause: DW_GENERATE_CAUSE,
      retryIndex: priorRunCount,
      overrides: {
        agentOverrideName: orchestrator.name,
        agentOverrideId: orchestrator.id,
      },
    })
    const envelopeNonce = await nodeRuns.loadEnvelopeNonce(runId)

    const prompt =
      buildOrchestratorPrompt({
        charter: config.instructions,
        goal: config.goal,
        pool: members,
        ...(dw.rejectionComment !== undefined ? { rejectionComment: dw.rejectionComment } : {}),
        triggerContext: (() => {
          if (state.triggerSource.kind !== 'ok') return null
          const contract = triggerContextContract(state.triggerSource.value)
          return contract === null
            ? null
            : {
                namespace: contract.namespace,
                definitionId: contract.definitionRef.id,
                availableFields: contract.availableFields,
              }
        })(),
        envelopeNonce,
      }) +
      (errorNotice !== null
        ? `\n\n## Validation errors in your previous workflow\n\n${fenceUntrusted(
            'dynamic-workflow-validation-errors',
            errorNotice,
            envelopeNonce,
          )}\n\nRe-emit a CORRECTED workflow-output envelope with the FULL workflow JSON and the exact required nonce.`
        : '')

    const result = await hooks.runHost({
      nodeRunId: runId,
      nodeId: DW_ORCHESTRATOR_NODE_ID,
      agent: orchestrator,
      promptTemplate: prompt,
      // No workgroupProtocolBlock: the orchestrator uses the STANDARD
      // <workflow-output> protocol for its declared `workflow` port.
      // Generation only produces an envelope — its worktree writes are
      // discarded (never merged back): the graph it proposes has not passed
      // validation or the human confirm gate yet (Codex impl-gate P1).
      discardWrites: true,
    })
    if (result.processUnreaped === true) {
      // The old orchestrator may still be writing this task's worktree. This
      // is a process-admission barrier, not a model validation failure: a new
      // attempt could use another native id and bypass the old id's lease.
      return {
        kind: 'failed',
        detail: {
          summary: 'dw-runtime-child-unreaped',
          message:
            result.errorMessage ??
            'dynamic workflow orchestrator child could not be reaped; refusing replacement',
        },
      }
    }
    if (result.status === 'canceled') return { kind: 'canceled' }

    // 'awaiting' is unreachable by construction (the generation snapshot wires
    // no clarify node, so runHostNode fails a voluntary ask-back with
    // clarify-no-channel before reporting 'awaiting') — fold it into the
    // failure accounting anyway rather than wedging the pass.
    const failure =
      result.status !== 'done'
        ? [(result.errorMessage ?? `orchestrator run ${result.status}`).slice(0, 4000)]
        : null
    let evaluated = failure
      ? null
      : evaluateGeneratedWorkflow(result.outputs[ORCHESTRATOR_WORKFLOW_PORT], tokenMap, layer1Ctx)

    if (evaluated !== null && evaluated.ok) {
      const triggerIssue = triggerPreflightIssue({
        root: evaluated.def,
        closureJson: null,
        source: state.triggerSource,
      })
      if (triggerIssue !== null) {
        const detail =
          triggerIssue.code === 'trigger-context-invalid'
            ? triggerIssue.code
            : `${triggerIssue.code}: ${triggerIssue.dependency.pointer}`
        evaluated = { ok: false, errors: [detail] }
      }
    }

    if (evaluated !== null && evaluated.ok) {
      const { rejectionComment: _consumed, ...rest } = dw
      dw = { ...rest, phase: 'awaiting_confirm', generatedDef: evaluated.def }
      await persistence.saveState(taskId, dw)
      await openDwGate(nodeRuns, taskId)
      log.info('dynamic workflow generated — awaiting confirmation', {
        taskId,
        attempts: dw.generateAttempts,
        nodes: evaluated.def.nodes.length,
      })
      return AWAITING_CONFIRM_RESULT
    }

    const errors = failure ?? (evaluated as { ok: false; errors: string[] }).errors
    errorNotice = errors.map((e) => `- ${e}`).join('\n')
    dw = { ...dw, generateAttempts: dw.generateAttempts + 1 }
    await persistence.saveState(taskId, dw)
    log.warn('dynamic workflow generation attempt failed', {
      taskId,
      attempt: dw.generateAttempts,
      errors: errors.slice(0, 5),
    })
  }

  return {
    kind: 'failed',
    detail: {
      summary: 'dw-generate-exhausted',
      message: `workflow generation failed ${DW_MAX_GENERATE_ATTEMPTS} attempt(s); last errors:\n${errorNotice ?? '(none recorded)'}`,
    },
  }
}
