// RFC-167 PR-2 — the dynamic-workflow generation rules (design §3.1): the pass's
// budgets and causes, the orchestrator payload extraction, the closure-leaf call
// guard and the two-layer evaluation of one generated workflow.
//
// RFC-410: moved from services/dynamicWorkflowRunner.ts. The generation pass itself
// is engine/task/dynamicWorkflowGenerate.ts; the generic (layer-one) validator is
// injected, so this file depends on nothing outside the domain and shared.

import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  DW_VALIDATION_CODES,
  DwGeneratedWorkflowSchema,
  dwGeneratedToWorkflowDef,
  validateDynamicWorkflowDef,
  type DwTokenMap,
  type WorkflowDefinition,
  type WorkflowValidationResult,
} from '@agent-workflow/shared'
import { ORCHESTRATOR_WORKFLOW_PORT } from './dynamicWorkflowOrchestrator'

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

/** The generic (layer-one) workflow validator over the catalog inventory loaded for one pass. */
export type GeneratedWorkflowLayerOneValidator = (
  definition: WorkflowDefinition,
) => WorkflowValidationResult

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
 * the error lines to inject into the retry prompt. Pure given the layer-1
 * validator (RFC-410: the engine loads it through its validation port, over the
 * catalog inventory of this pass).
 */
export function evaluateGeneratedWorkflow(
  rawPort: string | undefined,
  tokenMap: DwTokenMap,
  validateLayerOne: GeneratedWorkflowLayerOneValidator,
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
  const layer1 = validateLayerOne(def)
  const layer2 = validateDynamicWorkflowDef(def, poolAgentIds)
  const errors = [...layer1.issues, ...layer2.issues]
    .filter((i) => (i.severity ?? 'error') === 'error')
    .map((i) => `${i.code}: ${i.message}`)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, def }
}
