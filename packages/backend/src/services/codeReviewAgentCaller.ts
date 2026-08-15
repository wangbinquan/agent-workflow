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

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { capabilityBindings, repoCapabilityConfig } from '@/db/schema'
import { getAgentById } from '@/services/agent'
import { mintNodeRun, resolveFrozenRuntime } from '@/services/nodeRunMint'
import { runNode, type ResolvedSkill } from '@/services/runner'
import type { Agent } from '@agent-workflow/shared'

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
  db: DbClient,
  input: { repoId: string; capability: string; slot: string },
): Promise<ReviewerResolution> {
  const [cell] = await db
    .select({ bindingId: repoCapabilityConfig.bindingId })
    .from(repoCapabilityConfig)
    .where(eq(repoCapabilityConfig.repoId, input.repoId))
    .limit(1)

  if (cell === undefined) {
    return {
      ok: false,
      message: `no capability configuration exists for this repository, so '${input.capability}' has no agent to run its ${input.slot} stage`,
    }
  }
  if (cell.bindingId === null) {
    return {
      ok: false,
      message: `the '${input.capability}' cell for this repository has no binding selected, so no agent is mapped to the '${input.slot}' slot`,
    }
  }

  const [binding] = await db
    .select({ agentBySlotJson: capabilityBindings.agentBySlotJson })
    .from(capabilityBindings)
    .where(eq(capabilityBindings.id, cell.bindingId))
    .limit(1)

  if (binding === undefined) {
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

  const agent = await getAgentById(db, agentId)
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
  db: DbClient
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
  skills: ResolvedSkill[]
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
      const nodeRunId = await mintNodeRun(deps.db, {
        taskId: deps.taskId,
        nodeId: deps.nodeId,
        status: 'pending',
        cause: 'process-retry',
        // The guard's own numbering, so a row can be traced to the attempt that
        // produced it rather than to a position in an opaque sequence.
        retryIndex: call.attemptSeq,
      })

      const frozen = await resolveFrozenRuntime(
        deps.db,
        nodeRunId,
        deps.agent.runtime,
        deps.defaultRuntime ?? null,
      )

      const result = await runNode({
        db: deps.db,
        appHome: deps.appHome,
        skills: deps.skills,
        taskId: deps.taskId,
        nodeRunId,
        nodeId: deps.nodeId,
        agent: deps.agent,
        triggerContext: null,
        runtime: frozen.protocol,
        runtimeBinary: frozen.binary,
        runtimeParams: frozen.params,
        runtimeConfigDir: frozen.configDir,
        inputs: {},
        worktreePath: deps.worktreePath,
        templateMeta: {
          repoPath: deps.repoPath,
          baseBranch: deps.baseBranch,
          taskId: deps.taskId,
          nodeId: deps.nodeId,
        },
        // The prompt is already complete: the review stage composed the diff,
        // the instructions and the protocol block. Expanding it again would
        // treat a diff's literal `{{...}}` text as a template token.
        promptTemplate: prompt,
        expandPromptTemplate: false,
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
