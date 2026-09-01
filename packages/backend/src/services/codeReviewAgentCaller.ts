// RFC-304 §5/§6.1 — how the `review` stage reaches a model.
//
// Two halves, deliberately separate:
//
//   1. WHICH agent — resolve the contract's `agentSlot` against this repo's
//      capability binding (`capability_bindings.agent_by_slot_json`). That
//      mapping is the group layer: a team points the reviewer at its own agent
//      without forking the platform's stage sequence.
//   2. RUNNING it — mint a node_run, freeze the runtime, call `runNode`.
//
// ## Why this lives in services/ and not in the module
//
// `modules/code-capability/` must not dispatch agents — that is AC-10, enforced
// by a source scan, and it is what makes "program stages are provably
// model-free" a fact rather than a habit. So the module declares the seam
// (`makeCaller`) and this file fills it. The scheduler owns both.
//
// ## Mapping a run back to what the determinism guard expects
//
// The guard wants raw stdout so it can find the envelope. `runNode` has already
// parsed the envelope and resolved declared ports, so the port VALUE is what
// comes back. Re-wrapping that value in the canonical envelope gives the guard
// exactly the input it is written against, and the one distinction that could
// be lost is preserved deliberately: when the port is empty the run produced no
// usable envelope, so this returns empty stdout and the guard reports
// `envelope-missing` — the same verdict it would have reached itself.

import type { Agent } from '@agent-workflow/shared'
import type { ReviewerResolutionRead } from '@/modules/code-capability/application/ports/reviewerResolutionRead'
import type {
  ReviewAgentAttemptOperations,
  ReviewAgentSkill,
} from '@/modules/task-execution/application/ports/reviewAgentAttemptOperations'

/**
 * The call shape the review stage's determinism guard drives.
 *
 * Declared HERE rather than imported from the module: RFC-294's public-surface
 * check rejects a bare function type on a module contract, and it is right to —
 * a function is an unbounded capability, and putting one on the public surface
 * says "hand me anything". The module constrains this structurally instead,
 * through `MrReviewWiringInput.makeCaller`, at the single call site that wires
 * the two together.
 */
interface ReviewCallInput {
  sessionId: string | null
  feedback: string | null
  rerunSeq: number
  attemptSeq: number
}
interface ReviewCallResult {
  stdout: string
  sessionId: string
}
type ReviewCaller = (input: ReviewCallInput) => Promise<ReviewCallResult>

export type ReviewerResolution = { ok: true; agent: Agent } | { ok: false; message: string }

/**
 * Resolve a stage's `agentSlot` to a concrete agent for this repo.
 *
 * Every failure is named rather than folded into "not configured", because the
 * four ways this goes wrong need four different fixes: no cell, no binding on
 * the cell, no agent mapped to the slot, or a mapped agent that has since been
 * deleted. A single message would send someone to the wrong screen.
 */
export async function resolveReviewerAgent(
  read: ReviewerResolutionRead,
  input: { repoId: string; capability: string; slot: string },
): Promise<ReviewerResolution> {
  // BOTH keys are part of the provider port request. Filtering on repository
  // alone once selected the first capability cell and ran the wrong agent.
  const cell = await read.loadRepositoryCapability({
    repositoryId: input.repoId,
    capability: input.capability,
  })

  if (cell === null) {
    return {
      ok: false,
      message: `no capability configuration exists for this repository, so '${input.capability}' has no agent to run its ${input.slot} stage`,
    }
  }
  if (cell.templateId === null) {
    return {
      ok: false,
      message: `the '${input.capability}' cell for this repository has no binding selected, so no agent is mapped to the '${input.slot}' slot`,
    }
  }

  return await resolveAgentForBinding(read, {
    templateId: cell.templateId,
    slot: input.slot,
  })
}

/**
 * Resolve a slot against a SPECIFIC binding, rather than the one a cell stores.
 *
 * Split out for readiness (T31b): when a capability is being enabled, the
 * binding that matters is the one in the request, not the one currently saved —
 * which on a first save is nothing at all. Reading the stored cell there made
 * every new repository report `agent-not-visible` on its first save and
 * resolve only on the second, i.e. "press save twice", with no explanation.
 */
export async function resolveAgentForBinding(
  read: ReviewerResolutionRead,
  input: { templateId: string; slot: string },
): Promise<ReviewerResolution> {
  const binding = await read.loadTemplate(input.templateId)

  if (binding === null) {
    return {
      ok: false,
      message: `the binding selected for this repository no longer exists, so the '${input.slot}' slot cannot be resolved`,
    }
  }

  let bySlot: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(binding.agentBySlotJson)
    bySlot =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {
      ok: false,
      message: `the binding's agent-by-slot mapping is not readable, so the '${input.slot}' slot cannot be resolved`,
    }
  }

  const agentId = bySlot[input.slot]
  if (typeof agentId !== 'string' || agentId === '') {
    return {
      ok: false,
      message: `no agent is bound to the '${input.slot}' slot for this repository — bind one in the capability configuration`,
    }
  }

  const agent = await read.loadAgent(agentId)
  if (agent === null) {
    // Distinct from "none bound": something WAS chosen and has since been
    // deleted, which is a dangling reference to repair rather than a blank to
    // fill in.
    return {
      ok: false,
      message: `the agent bound to the '${input.slot}' slot no longer exists (id ${agentId}) — rebind it in the capability configuration`,
    }
  }
  return { ok: true, agent }
}

export interface ReviewAgentCallerDeps {
  attempts: ReviewAgentAttemptOperations
  taskId: string
  nodeId: string
  agent: Agent
  worktreePath: string
  repoPath: string
  baseBranch: string
  /** The port the findings envelope is carried in. */
  portName: string
  /** The run's envelope nonce — scopes the envelope this caller reconstructs. */
  nonce: string
  /** Resolved skills for this agent, as the scheduler resolves them. */
  skills: ReviewAgentSkill[]
  appHome: string
  defaultRuntime?: string | null
  timeoutMs?: number
}

/**
 * Build the `makeCaller` the review stage needs.
 *
 * One node_run per attempt: the determinism guard may call this several times
 * (same-session retries, then fresh-session re-runs), and each is a real
 * dispatch that has to be individually visible. Sharing one row across attempts
 * would make a run that was retried three times look like one that succeeded
 * first try.
 */
export function createReviewAgentCaller(
  deps: ReviewAgentCallerDeps,
): (prompt: string) => ReviewCaller {
  return (prompt: string): ReviewCaller => {
    return async (call) => {
      const result = await deps.attempts.run({
        taskId: deps.taskId,
        nodeId: deps.nodeId,
        // The guard's own numbering, so a row can be traced to the attempt that
        // produced it rather than to a position in an opaque sequence.
        retryIndex: call.attemptSeq,
        agent: deps.agent,
        prompt,
        worktreePath: deps.worktreePath,
        repoPath: deps.repoPath,
        baseBranch: deps.baseBranch,
        skills: deps.skills,
        appHome: deps.appHome,
        defaultRuntime: deps.defaultRuntime ?? null,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      })

      const port = result.outputs[deps.portName] ?? ''
      return {
        // Empty port ⇒ no usable envelope came back. Returning empty stdout
        // lets the guard reach `envelope-missing` on its own rather than being
        // handed a synthesized envelope wrapping nothing.
        stdout:
          port === ''
            ? ''
            : `<workflow-output nonce="${deps.nonce}"><port name="${deps.portName}">${port}</port></workflow-output>`,
        sessionId: result.sessionId ?? '',
      }
    }
  }
}
