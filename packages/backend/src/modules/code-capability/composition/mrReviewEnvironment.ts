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
// With the refusal, a round runs every program stage for real — target,
// worktree, diff, gate, positions, reconcile, publish, settle-stale, ledger are
// all exercised against the live task — and stops at `review`, the one AI
// stage, with a sentence an operator can act on.

import { and, eq } from 'drizzle-orm'
import { buildProtocolBlock } from '@agent-workflow/shared'
import { resolveTarget } from '@/modules/code-capability/domain/resolveTarget'
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
import type { TaskWorkspaceCommitParticipant } from '@/modules/task-execution/public/participants'
import { createSqliteFindingLedger } from '@/modules/code-capability/infrastructure/sqliteFindingLedger'
import { createSqliteAttemptRecorder } from '@/modules/code-capability/infrastructure/sqliteAttemptRecorder'
import type { CodeHostConnectionsService, FetchLike } from '@/services/codeHost/connections'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Defaults chosen to be visibly conservative rather than silently permissive. */
export const DEFAULT_REVIEW_BUDGET: RetryBudget = { sameSession: 2, freshSession: 1 }
export const DEFAULT_REVIEW_GATE: GateConfig = { threshold: 'minor', maxPerRound: 20 }

export interface MrReviewWiringInput {
  db: DbClient
  webhook: WebhookTriggerFields
  repoPath: string
  worktreePath: string
  nonce: string
  /**
   * The work item this round belongs to, and the epoch it belongs to.
   *
   * Absent leaves the publish critical section unclaimed — the shape every
   * round had until now, because the scheduler passed neither and the intent
   * ledger hardcoded `epoch: 1`. With them, a round that a newer revision has
   * already preempted fails the section's CAS instead of publishing a review of
   * code the author has replaced.
   */
  workItemId?: string
  epoch?: number
  /**
   * Supplied by whoever can run an agent. Absent means the `review` stage
   * refuses by name — see the header.
   */
  makeCaller?: (prompt: string, port: string) => AiCaller
  budget?: RetryBudget
  gate?: GateConfig
  /** Overrides endpoint resolution; tests and multi-endpoint callers use it. */
  codeHostEndpointId?: string
  /** The round this wiring belongs to — scopes the AI attempt rows. */
  roundId?: string
  /** Injected connection resolution; production reads the secret key file. */
  codeHostConnections?: CodeHostConnectionsService | null
  /** Replaces only the socket, so the real client still assembles the request. */
  codeHostFetch?: FetchLike
  /**
   * Why no caller could be built, when the caller's owner tried and failed.
   *
   * Threaded through rather than re-derived so the REAL reason reaches the
   * person reading the round's failure: "the agent bound to 'reviewer' no
   * longer exists (id …)" is a repair instruction, and collapsing it to a
   * generic "no agent bound" would send them to look at an empty field that is
   * not empty.
   */
  unresolvedAgentReason?: string
  taskCommit?: TaskWorkspaceCommitParticipant
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
  /**
   * What a resuming round inherits — see
   * `CapabilityWiring.inheritedArtifacts`, which this mirrors so the two
   * builders present one shape to the scheduler. `mr-review` opens no
   * confirming round today, so it is normally the resolved target and nothing
   * else; a crash-resume reads it for the same reason a confirmation does.
   */
  inheritedArtifacts: Readonly<Record<string, unknown>>
  programStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  aiStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  /**
   * The endpoint this round is keyed to, when it could be resolved.
   *
   * Handed back rather than re-derived by the caller: it is a component of both
   * the work-item identity and the MR lease key, and resolving it twice invites
   * the two from drifting apart — which would key a round's lease to a
   * different MR than its ledger.
   */
  codeHostEndpointId: string | null
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
      codeHostEndpointId: null,
      inheritedArtifacts: {},
      programStages: refuseAll(
        [
          'resolve-target',
          'prepare-worktree',
          'fetch-diff',
          'split-diff',
          'validate-findings',
          'gate',
          'resolve-positions',
          'reconcile',
          'publish',
          'settle-stale',
          'ledger',
        ],
        message,
      ),
      aiStages: refuseAll(['review-shard', 'review-global'], message),
    }
  }

  let endpointId = input.codeHostEndpointId
  if (endpointId === undefined) {
    const resolved = await resolveCodeHostEndpointId(input.db, provider)
    if (!resolved.ok) {
      return {
        codeHostEndpointId: null,
        inheritedArtifacts: {},
        programStages: refuseAll(
          [
            'resolve-target',
            'prepare-worktree',
            'fetch-diff',
            'split-diff',
            'validate-findings',
            'gate',
            'resolve-positions',
            'reconcile',
            'publish',
            'settle-stale',
            'ledger',
          ],
          resolved.message,
        ),
        aiStages: refuseAll(['review-shard', 'review-global'], resolved.message),
      }
    }
    endpointId = resolved.id
  }

  const env: MrReviewEnvironment = {
    // One row per AI call, scoped to this round and stage. Built here because
    // the round id is a composition-time fact, not something a stage knows.
    ...(input.roundId !== undefined
      ? {
          attemptRecorder: createSqliteAttemptRecorder(input.db, {
            roundId: input.roundId,
            stageName: 'review',
            shardKey: '',
          }),
        }
      : {}),
    // Cross-round history. Bound to THIS round and capability so a stage cannot
    // write into another round's findings; without it every round republishes
    // its whole review (see `MrReviewEnvironment.ledger`).
    ...(input.roundId !== undefined
      ? {
          ledger: createSqliteFindingLedger(input.db, {
            capability: 'mr-review',
            roundId: input.roundId,
          }),
          // §7.2. The anchor ref is keyed the same way the ledger is — endpoint
          // plus project plus MR — because recovery has to find a batch written
          // by a round that is gone, and only the MR's identity survives that.
          ...(input.workItemId === undefined || input.workItemId === ''
            ? {}
            : {
                publishSection: {
                  db: input.db,
                  workItemId: input.workItemId,
                  epoch: input.epoch ?? 1,
                },
              }),
          publishIntents: {
            db: input.db,
            roundId: input.roundId,
            // 1, not 0: the schema constrains `epoch >= 1` and the work item's
            // own column defaults to 1, so 1 is what "no supersession has
            // happened yet" means here. No work item is wired into this path
            // until PR-6; when one is, its epoch replaces this.
            // The round's own epoch. `1` was a placeholder for "no work item
            // is wired into this path yet"; one is now, and a stale batch is
            // recognised by comparing against the item's current epoch.
            epoch: input.epoch ?? 1,
            anchorRef: `${endpointId}:${input.webhook.project_id ?? ''}:mr:${input.webhook.mr_iid ?? ''}`,
          },
        }
      : {}),
    codeHost: createCodeHostAdapter({
      db: input.db,
      provider,
      ...(input.codeHostConnections !== undefined
        ? { connections: input.codeHostConnections }
        : {}),
      ...(input.codeHostFetch !== undefined ? { fetchImpl: input.codeHostFetch } : {}),
    }),
    git: createGitAdapter(input.taskCommit === undefined ? {} : { taskCommit: input.taskCommit }),
    webhook: input.webhook,
    codeHostEndpointId: endpointId,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    // The protocol block is composed HERE, for the port the stage passes in,
    // rather than handed down ready-made: one argument then drives both the
    // instruction and the reader, which is what `capabilityWiring` does for the
    // other capabilities and what none of them did before.
    makeCaller: (prompt: string, port: string) =>
      (
        input.makeCaller ??
        (() => async () => {
          // Reached only if the stage runs; the refusal below replaces it.
          throw new Error('no agent caller is wired for the review stage')
        })
      )(`${prompt}\n${buildProtocolBlock([port], undefined, input.nonce)}`, port),
    nonce: input.nonce,
    budget: input.budget ?? DEFAULT_REVIEW_BUDGET,
    gate: input.gate ?? DEFAULT_REVIEW_GATE,
  }

  const resolvedTarget = resolveTarget(input.webhook, endpointId)

  return {
    codeHostEndpointId: endpointId,
    inheritedArtifacts: resolvedTarget.ok ? { target: resolvedTarget.target } : {},
    programStages: mrReviewProgramStages(env),
    aiStages:
      input.makeCaller === undefined
        ? refuseAll(
            ['review-shard', 'review-global'],
            input.unresolvedAgentReason ??
              `no agent is bound to the 'reviewer' slot for this repository, so the review stages have nothing to run — bind one in the capability configuration`,
          )
        : mrReviewAiStages(env),
  }
}
