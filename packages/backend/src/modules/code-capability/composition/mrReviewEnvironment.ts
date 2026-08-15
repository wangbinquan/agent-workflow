// RFC-304 §6.1 — assembling one round's environment from what the scheduler
// knows, so `mr-review`'s stages can actually run against a real task.
//
// The scheduler holds the task, its worktree and the frozen trigger context;
// this module holds the stages. This is the join, and it lives here so the
// scheduler never learns what a stage or a port is — it hands over primitives
// and gets back the two name→implementation maps the runner registers.
//
// ## The one seam that is NOT closed here
//
// `makeCaller` — how the `review` stage reaches a model — is a parameter with
// no default that works. Running an agent means resolving the contract's
// `agentSlot` to an actual agent binding for this repo, which is group-layer
// configuration (§5) and is not wired yet. Rather than guess a binding, the
// fallback FAILS with a message naming the slot and the repo.
//
// That is deliberate. The alternative shapes are both worse:
//
//   - picking "some agent" so the round completes: it would publish a review
//     written by whatever agent happened to sort first, and nothing in the
//     output would say the binding was invented;
//   - leaving the stage unregistered: the round dies at stage one with "no
//     registered implementation", which says nothing about what to configure.
//
// With the refusal, a round runs seven of its eight stages for real — target,
// worktree, diff, gate, positions, publish, ledger are all exercised against
// the live task — and stops at `review` with a sentence an operator can act on.

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { webhookEndpoints } from '@/db/schema'
import type { AiCaller, RetryBudget } from '@/modules/code-capability/application/determinismGuard'
import type { GateConfig } from '@/modules/code-capability/domain/findingGate'
import type {
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import {
  mrReviewAiStages,
  mrReviewProgramStages,
  type MrReviewEnvironment,
} from '@/modules/code-capability/composition/mrReviewStages'
import { createCodeHostAdapter } from '@/modules/code-capability/infrastructure/codeHostAdapter'
import { createGitAdapter } from '@/modules/code-capability/infrastructure/gitAdapter'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Defaults chosen to be visibly conservative rather than silently permissive. */
export const DEFAULT_REVIEW_BUDGET: RetryBudget = { sameSession: 2, freshSession: 1 }
export const DEFAULT_REVIEW_GATE: GateConfig = { threshold: 'minor', maxPerRound: 20 }

export interface MrReviewWiringInput {
  db: DbClient
  webhook: WebhookTriggerFields
  repoPath: string
  worktreePath: string
  protocolBlock: string
  nonce: string
  /**
   * Supplied by whoever can run an agent. Absent means the `review` stage
   * refuses by name — see the header.
   */
  makeCaller?: (prompt: string) => AiCaller
  budget?: RetryBudget
  gate?: GateConfig
  /** Overrides endpoint resolution; tests and multi-endpoint callers use it. */
  codeHostEndpointId?: string
}

/**
 * Which webhook endpoint this round's identity is keyed to.
 *
 * The task row does not carry it (the launch path predates the work item), and
 * the schema comment records that this table is expected to hold ONE row. So
 * the single enabled endpoint for the provider is resolved here — and, when
 * that assumption stops holding, this refuses rather than picking one.
 *
 * Picking arbitrarily would be the worst outcome available: the endpoint is a
 * component of the work item's identity key, so a round keyed to the wrong one
 * gets its own parallel ledger, invisible to the one the previous rounds wrote.
 */
export async function resolveCodeHostEndpointId(
  db: DbClient,
  provider: 'gitlab' | 'github',
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const rows = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.provider, provider), eq(webhookEndpoints.enabled, true)))

  if (rows.length === 1) return { ok: true, id: rows[0]!.id }
  if (rows.length === 0) {
    return {
      ok: false,
      message: `no enabled ${provider} webhook endpoint is configured, so this round has no identity to key its findings to`,
    }
  }
  return {
    ok: false,
    message: `${rows.length} enabled ${provider} webhook endpoints exist and the task does not record which one delivered this event — pick one explicitly rather than letting the round key its ledger to an arbitrary endpoint`,
  }
}

/** A stage map whose every entry refuses with the same explanation. */
function refuseAll(
  names: readonly string[],
  message: string,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  const out: Record<string, (ctx: StageRunContext) => Promise<StageResult>> = {}
  for (const name of names) {
    out[name] = async () => ({ status: 'failed', error: message })
  }
  return out
}

export interface MrReviewWiring {
  programStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  aiStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
}

/**
 * Build the stage maps for one round.
 *
 * Returns maps in every case, including the failure ones: a round whose wiring
 * is incomplete must still reach the engine and settle its rows with a named
 * reason. Returning nothing, or throwing, would leave the work item waiting on
 * a task that never reports.
 */
export async function buildMrReviewWiring(input: MrReviewWiringInput): Promise<MrReviewWiring> {
  const provider = input.webhook.provider
  if (provider !== 'gitlab' && provider !== 'github') {
    const message = `the trigger context names provider '${String(provider)}', which this platform does not drive`
    return {
      programStages: refuseAll(
        [
          'resolve-target',
          'prepare-worktree',
          'fetch-diff',
          'gate',
          'resolve-positions',
          'publish',
          'ledger',
        ],
        message,
      ),
      aiStages: refuseAll(['review'], message),
    }
  }

  let endpointId = input.codeHostEndpointId
  if (endpointId === undefined) {
    const resolved = await resolveCodeHostEndpointId(input.db, provider)
    if (!resolved.ok) {
      return {
        programStages: refuseAll(
          [
            'resolve-target',
            'prepare-worktree',
            'fetch-diff',
            'gate',
            'resolve-positions',
            'publish',
            'ledger',
          ],
          resolved.message,
        ),
        aiStages: refuseAll(['review'], resolved.message),
      }
    }
    endpointId = resolved.id
  }

  const env: MrReviewEnvironment = {
    codeHost: createCodeHostAdapter({ db: input.db, provider }),
    git: createGitAdapter(),
    webhook: input.webhook,
    codeHostEndpointId: endpointId,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    makeCaller:
      input.makeCaller ??
      (() => async () => {
        // Reached only if the stage runs; the refusal below replaces it.
        throw new Error('no agent caller is wired for the review stage')
      }),
    protocolBlock: input.protocolBlock,
    nonce: input.nonce,
    budget: input.budget ?? DEFAULT_REVIEW_BUDGET,
    gate: input.gate ?? DEFAULT_REVIEW_GATE,
  }

  return {
    programStages: mrReviewProgramStages(env),
    aiStages:
      input.makeCaller === undefined
        ? refuseAll(
            ['review'],
            `no agent is bound to the 'reviewer' slot for this repository, so the review stage has nothing to run — bind one in the capability configuration`,
          )
        : mrReviewAiStages(env),
  }
}
