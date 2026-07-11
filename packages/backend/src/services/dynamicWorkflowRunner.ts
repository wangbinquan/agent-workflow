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
// task.workflow_snapshot atomically inside resumeKick's ownership CAS and
// flips dw.phase='executing'; the resumed runTask then runs the REAL DAG via
// runScope — this engine never executes the generated graph itself.
//
// Mechanics reuse: all process-level work (frozen runtime, iso worktree,
// runNode, merge-back) rides the SAME WorkgroupEngineHooks the round engine
// uses (buildWorkgroupHooks in scheduler.ts) — this module never imports
// scheduler.ts (module-cycle ban) and tests drive it with fake hooks.

import {
  DwGeneratedWorkflowSchema,
  dwGeneratedToWorkflowDef,
  parseDwState,
  WorkgroupRuntimeConfigSchema,
  type Agent,
  type DwState,
  type WorkflowDefinition,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'
import { getAgent } from '@/services/agent'
import { setNodeRunStatus } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import {
  buildOrchestratorAgent,
  buildOrchestratorPrompt,
  DW_ORCHESTRATOR_NODE_ID,
  ORCHESTRATOR_WORKFLOW_PORT,
  validateDynamicWorkflowDef,
} from '@/services/orchestratorAgent'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import type { WorkgroupEngineHooks, WorkgroupEngineResult } from '@/services/workgroupRunner'
import type { Logger } from '@/util/log'

/** Total generation attempts per pass (bad JSON / schema / validation all count). */
export const DW_MAX_GENERATE_ATTEMPTS = 3
/** Hard cap on human reject→regenerate rounds (design §8 — no infinite loop). */
export const DW_MAX_REJECT_ROUNDS = 10
/** node_runs.rerun_cause of orchestrator generation runs. */
export const DW_GENERATE_CAUSE = 'dw-generate'
/** node_runs.rerun_cause of the confirm-gate holder run (lifecycle invariant:
 *  task awaiting_review ⟹ ∃ awaiting_review node_run; wg-gate precedent). */
export const DW_GATE_CAUSE = 'dw-gate'

export interface DynamicWorkflowEngineArgs {
  db: DbClient
  taskId: string
  log: Logger
  signal?: AbortSignal
  hooks: WorkgroupEngineHooks
}

interface DwDbState {
  config: WorkgroupRuntimeConfig
  dw: DwState
}

async function loadDwDbState(db: DbClient, taskId: string): Promise<DwDbState | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (row === undefined || row.workgroupConfigJson === null) return null
  let rawConfig: Record<string, unknown>
  try {
    rawConfig = JSON.parse(row.workgroupConfigJson) as Record<string, unknown>
  } catch {
    return null
  }
  const config = WorkgroupRuntimeConfigSchema.safeParse(rawConfig)
  if (!config.success) return null
  const dw = parseDwState(rawConfig.dw)
  if (dw === null) return null
  return { config: config.data, dw }
}

/**
 * Persist the dw slot WITHOUT touching the rest of the config (Codex
 * impl-gate P2, re-review): a generation run can take minutes, and the
 * mid-run config endpoint (PUT /api/workgroup-tasks/:id/config) may have
 * legitimately edited members / switches since this pass loaded its snapshot
 * — a stale full-column spread would silently roll those edits back. A
 * single-statement `json_set` keeps the write atomic at the SQLite level (no
 * read→write window at all, unlike a fresh-read + full-column update). The
 * dw slot itself has a single writer while the task runs (the engine —
 * dw-confirm only writes while the task is parked awaiting_review).
 */
async function persistDwState(db: DbClient, taskId: string, dw: DwState): Promise<void> {
  await db
    .update(tasks)
    .set({
      workgroupConfigJson: sql`json_set(${tasks.workgroupConfigJson}, '$.dw', json(${JSON.stringify(dw)}))`,
    })
    .where(and(eq(tasks.id, taskId), isNotNull(tasks.workgroupConfigJson)))
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
 * Parse + convert + two-layer-validate one orchestrator `workflow` port
 * payload. Returns the validated definition or the error lines to inject into
 * the retry prompt. Pure except for the layer-1 context (caller supplies it).
 */
export function evaluateGeneratedWorkflow(
  rawPort: string | undefined,
  poolNames: readonly string[],
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
  const def = dwGeneratedToWorkflowDef(gen.data)
  const layer1 = validateWorkflowDef(def, layer1Ctx)
  const layer2 = validateDynamicWorkflowDef(def, poolNames)
  const errors = [...layer1.issues, ...layer2.issues]
    .filter((i) => (i.severity ?? 'error') === 'error')
    .map((i) => `${i.code}: ${i.message}`)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, def }
}

/** Resolve the orchestratable pool: the group's agent members, deduped by
 *  agentName; dangling references (agent deleted after launch) are skipped. */
async function resolvePool(db: DbClient, config: WorkgroupRuntimeConfig): Promise<Agent[]> {
  const seen = new Set<string>()
  const pool: Agent[] = []
  for (const m of config.members) {
    if (m.memberType !== 'agent' || m.agentName === null || seen.has(m.agentName)) continue
    seen.add(m.agentName)
    const agent = await getAgent(db, m.agentName)
    if (agent !== null) pool.push(agent)
  }
  return pool
}

/** Mint the confirm-gate holder run (task awaiting_review lifecycle invariant). */
async function openDwGate(db: DbClient, taskId: string): Promise<void> {
  const gateRunId = await mintNodeRun(db, {
    taskId,
    nodeId: DW_ORCHESTRATOR_NODE_ID,
    status: 'pending',
    cause: DW_GATE_CAUSE,
  })
  await setNodeRunStatus({
    db,
    nodeRunId: gateRunId,
    to: 'awaiting_review',
    allowedFrom: ['pending'],
    reason: 'dw-gate-open',
  })
}

const AWAITING_CONFIRM_RESULT: WorkgroupEngineResult = {
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
): Promise<WorkgroupEngineResult> {
  const { db, taskId, log, hooks } = args

  const state = await loadDwDbState(db, taskId)
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
    const holders = await db
      .select({ id: nodeRuns.id, status: nodeRuns.status })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.rerunCause, DW_GATE_CAUSE)))
    if (!holders.some((h) => h.status === 'awaiting_review')) {
      await openDwGate(db, taskId)
    }
    return AWAITING_CONFIRM_RESULT
  }

  const pool = await resolvePool(db, config)
  if (pool.length === 0) {
    return {
      kind: 'failed',
      detail: {
        summary: 'dynamic workflow agent pool is empty',
        message: 'no agent member resolves to an existing agent (deleted after launch?)',
      },
    }
  }
  const poolNames = pool.map((a) => a.name)
  const layer1Ctx = await buildWorkflowValidationContext(db)
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
    await persistDwState(db, taskId, dw)
  }

  let errorNotice: string | null = null
  while (dw.generateAttempts < DW_MAX_GENERATE_ATTEMPTS) {
    if (args.signal?.aborted === true) return { kind: 'canceled' }

    const priorRuns = await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DW_ORCHESTRATOR_NODE_ID)))
    const runId = await mintNodeRun(db, {
      taskId,
      nodeId: DW_ORCHESTRATOR_NODE_ID,
      status: 'pending',
      cause: DW_GENERATE_CAUSE,
      retryIndex: priorRuns.length,
      overrides: { agentOverrideName: orchestrator.name },
    })

    const prompt =
      buildOrchestratorPrompt({
        charter: config.instructions,
        goal: config.goal,
        pool,
        ...(dw.rejectionComment !== undefined ? { rejectionComment: dw.rejectionComment } : {}),
      }) +
      (errorNotice !== null
        ? `\n\n## Validation errors in your previous workflow\n\n${errorNotice}\n\nRe-emit a CORRECTED <workflow-output> envelope with the FULL workflow JSON.`
        : '')

    const result = await hooks.runHostNode({
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
    if (result.status === 'canceled') return { kind: 'canceled' }

    // 'awaiting' is unreachable by construction (the generation snapshot wires
    // no clarify node, so runHostNode fails a voluntary ask-back with
    // clarify-no-channel before reporting 'awaiting') — fold it into the
    // failure accounting anyway rather than wedging the pass.
    const failure =
      result.status !== 'done'
        ? [(result.errorMessage ?? `orchestrator run ${result.status}`).slice(0, 4000)]
        : null
    const evaluated = failure
      ? null
      : evaluateGeneratedWorkflow(result.outputs[ORCHESTRATOR_WORKFLOW_PORT], poolNames, layer1Ctx)

    if (evaluated !== null && evaluated.ok) {
      const { rejectionComment: _consumed, ...rest } = dw
      dw = { ...rest, phase: 'awaiting_confirm', generatedDef: evaluated.def }
      await persistDwState(db, taskId, dw)
      await openDwGate(db, taskId)
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
    await persistDwState(db, taskId, dw)
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
