// RFC-217 T3 — the ONE mint→retry→run→parse skeleton behind every workgroup
// turn (design §1.3). Before this module the shape lived four times
// (driveLeaderTurn / driveAssignmentTurn / driveBatchTurn + the dw generate
// pass), with the `## Protocol errors…` reprompt, the clarify-forbidden
// nudge and the FOLLOWUP_POLICY consult copied verbatim into each — G6 locks
// the reprompt text to THIS file.
//
// Behavior invariants carried over verbatim (rfc186/187 suites lock them):
//   - retries mint `wg-protocol-retry` rows that never count into the round
//     budget (RFC-187 §2.1);
//   - clarify-forbidden is a RETRYABLE nudge with its own notice; exhaustion
//     is role-specific (leader drops-and-continues, members surface failed)
//     so the skeleton reports it and the caller settles;
//   - an unstructured failure (no failureCode in FOLLOWUP_POLICY) is fatal for
//     the leader and card-settling for members — again reported, not decided
//     here;
//   - message turns are SINGLE-SHOT (maxAttempts=1) — the retry budget is a
//     spec input, not a constant (design-gate P2).

import type { Agent, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {
  FOLLOWUP_POLICY,
  fenceUntrusted,
  type EnvelopeFollowupReason,
  type FailureCode,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { broadcastPendingMint } from '@/services/workgroup/messages'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { loadRunEnvelopeNonce, mintNodeRun } from '@/services/nodeRunMint'
import type { RerunCause } from '@agent-workflow/shared'
import { resolveWgClarifyAllowed } from '@/services/workgroup/lifecycle'
import {
  renderWgProtocolBlock,
  wgHostRolePorts,
  type WorkgroupProtocolRole,
} from '@/services/workgroup/context'
import type { WorkgroupEngineHooks, WorkgroupHostRunResult } from '@/services/workgroup/hooks'

/**
 * RFC-186 §2.2 — unify the workgroup turn's retry-vs-fatal decision on the SAME
 * `FOLLOWUP_POLICY` table normal nodes use (`decideEnvelopeFollowup`), replacing
 * the order-sensitive `errorMessage.startsWith(...)` chain + the per-code
 * `failureCode === 'envelope-missing'` special-case (audit §2 P1-5). A failure
 * with a structured `FailureCode` in the table is retryable; an unstructured
 * failure (`failureCode` undefined — iso-setup / injection / subprocess crash /
 * merge-back conflict) is genuinely fatal. `clarify-forbidden` is handled by its
 * OWN branch BEFORE this (workgroup autonomous soft-reject semantics, RFC-181/183)
 * — never routed here as a normal envelope-missing retry.
 */
export function followupForFailure(
  failureCode: FailureCode | undefined,
): { retry: true; reason: EnvelopeFollowupReason } | { retry: false } {
  if (failureCode === undefined) return { retry: false }
  const policy = FOLLOWUP_POLICY[failureCode] as { reason: EnvelopeFollowupReason } | undefined
  return policy ? { retry: true, reason: policy.reason } : { retry: false }
}

/**
 * RFC-186 §2.3 — reason-tailored re-prompt for a workgroup turn. Unlike the
 * normal node, we do NOT reuse `renderEnvelopeFollowupPrompt` verbatim: that
 * renderer REPLACES the whole prompt, which would drop the `workgroupProtocolBlock`
 * (where the wg_* port contract lives) on the fresh retry subprocess. Instead we
 * return a concise `errorNotice` appended to the FULL turn prompt (which still
 * carries the wg protocol block via runHostNode), reason-mapped from the same
 * 6-value `EnvelopeFollowupReason` domain.
 */
export function wgFollowupNotice(reason: EnvelopeFollowupReason): string {
  switch (reason) {
    case 'envelope-missing':
      return (
        '- Your previous reply had NO <workflow-output> envelope. Re-read the\n' +
        '  Workgroup output protocol above and re-emit your FULL reply as ONE\n' +
        '  <workflow-output> envelope with <port name="..."> children (literal\n' +
        '  tag names — never invent your own tags).'
      )
    case 'both-present':
      return (
        '- You emitted BOTH <workflow-output> and <workflow-clarify>. Emit exactly\n' +
        '  ONE — the <workflow-output> envelope with your wg_* ports.'
      )
    case 'clarify-malformed':
      return (
        '- Your <workflow-clarify> reply was malformed. Re-emit a VALID\n' +
        '  <workflow-clarify> envelope (see the clarify format above) OR, if nothing\n' +
        '  needs a human, proceed with a <workflow-output> envelope.'
      )
    case 'envelope-port-malformed':
      return (
        '- A <port> tag in your envelope was unclosed or corrupted. Re-emit ONE\n' +
        '  clean <workflow-output> with each port properly closed by </port>.'
      )
    case 'port-validation':
      return (
        '- A port in your envelope failed validation. Re-emit a <workflow-output>\n' +
        '  whose port bodies are valid JSON matching the protocol above.'
      )
    case 'clarify-required':
      return (
        '- This turn requires a <workflow-clarify> envelope. Re-emit your reply as\n' +
        '  a single valid <workflow-clarify> envelope.'
      )
  }
}

/** G6 single definition point — the protocol-error reprompt block. */
export function composeProtocolErrorReprompt(envelopeNonce: string, errorNotice: string): string {
  return `\n\n## Protocol errors in your previous reply\n\n${fenceUntrusted(
    'protocol-error',
    errorNotice,
    envelopeNonce,
  )}\n\nRe-emit a CORRECT envelope.`
}

export interface TurnMintRow {
  cause: RerunCause
  retryIndex: number
  overrides?: Record<string, unknown>
}

export interface TurnSpec<T> {
  nodeId: string
  agent: Agent
  role: WorkgroupProtocolRole
  config: WorkgroupRuntimeConfig
  /** asker shard for the RFC-207 clarify gate (null = leader / node-level). */
  clarifyShardKey: string | null
  /** total attempts INCLUDING the first (message turn: 1 — single-shot). */
  maxAttempts: number
  /** role-tailored clarify-forbidden nudge (leader vs member wording). */
  clarifyForbiddenNotice: string
  /** batch runs parametrize the protocol block + port set (RFC-215 count). */
  protocolOpts?: { count: number }
  /** row spec for a fresh mint at `attempt` (cause/shard/overrides per role). */
  mintRow(attempt: number, retryBase: number): TurnMintRow
  /** per-attempt durable side-effects after the run row exists (card flips). */
  onAttemptStart?(runId: string, attempt: number): Promise<void>
  /** base prompt for this attempt — reprompt block is appended by the skeleton. */
  composePrompt(envelopeNonce: string): string
  /** port parsing + cross-validation; errors re-enter the retry loop. */
  parse(
    outputs: Record<string, string | undefined>,
    ctx: { runId: string; envelopeNonce: string },
  ): { ok: true; value: T } | { ok: false; errors: string[] }
}

export type TurnOutcome<T> =
  | { kind: 'done'; value: T; runId: string; envelopeNonce: string }
  | { kind: 'canceled'; runId: string }
  | { kind: 'awaiting'; runId: string }
  /** clarify hard-suppressed and the retry budget is gone — caller settles per role. */
  | { kind: 'clarify-forbidden-exhausted'; runId: string; errorMessage: string }
  /** run failed: `retryable` says the FOLLOWUP table matched but budget ran out. */
  | { kind: 'failed'; runId: string; errorMessage: string; retryable: boolean }
  /** the model kept emitting an invalid envelope until the budget ran out. */
  | { kind: 'protocol-exhausted'; runId: string; errors: string[] }

export interface TurnArgs {
  db: DbClient
  taskId: string
  hooks: WorkgroupEngineHooks
  /** engine bookkeeping — mirror of the drivers' registerMint. */
  registerMint?: (runId: string) => void
  /** adopt an existing pending/awaiting row for attempt 0 (resume paths). */
  adoptedRunId?: string
  retryBase?: number
}

export async function executeTurn<T>(args: TurnArgs, spec: TurnSpec<T>): Promise<TurnOutcome<T>> {
  const { db, taskId, hooks } = args
  let adoptedRunId = args.adoptedRunId
  const retryBase = args.retryBase ?? 0
  let errorNotice: string | null = null
  let runId = ''
  for (let attempt = 0; attempt < spec.maxAttempts; attempt++) {
    if (adoptedRunId !== undefined && attempt === 0) {
      runId = adoptedRunId
    } else {
      const row = spec.mintRow(attempt, retryBase)
      runId = await mintNodeRun(db, {
        taskId,
        nodeId: spec.nodeId,
        status: 'pending',
        cause: row.cause,
        retryIndex: row.retryIndex,
        ...(row.overrides !== undefined ? { overrides: row.overrides } : {}),
      })
      args.registerMint?.(runId)
      broadcastPendingMint(taskId, runId, spec.nodeId)
    }
    adoptedRunId = undefined
    const envelopeNonce = await loadRunEnvelopeNonce(db, runId)
    await spec.onAttemptStart?.(runId, attempt)

    const prompt =
      spec.composePrompt(envelopeNonce) +
      (errorNotice !== null ? composeProtocolErrorReprompt(envelopeNonce, errorNotice) : '')

    // RFC-207 §3.7.2 — resolve ONCE per attempt and feed BOTH the protocol
    // block (whether to invite an ask-back) and clarifyEnabled (whether to
    // accept one); split derivations invite questions the gate then rejects.
    const clarifyAllowed = await resolveWgClarifyAllowed(
      db,
      taskId,
      spec.config.members,
      spec.config.clarifyBudget,
      spec.nodeId,
      spec.clarifyShardKey,
    )
    const result: WorkgroupHostRunResult = await hooks.runHostNode({
      nodeRunId: runId,
      nodeId: spec.nodeId,
      agent: spec.agent,
      promptTemplate: prompt,
      workgroupProtocolBlock: renderWgProtocolBlock(
        spec.role,
        spec.config,
        envelopeNonce,
        clarifyAllowed,
        spec.protocolOpts ?? null,
      ),
      hostOutputPorts: wgHostRolePorts(spec.role, spec.protocolOpts ?? null),
      clarifyEnabled: clarifyAllowed,
    })
    if (result.status === 'canceled') return { kind: 'canceled', runId }
    if (result.status === 'awaiting') return { kind: 'awaiting', runId }
    if (result.status === 'failed') {
      const msg = result.errorMessage ?? 'run failed'
      // RFC-181 C — hard-suppressed ask-back is a retryable protocol nudge
      // with role wording; exhaustion is settled by the caller (leader:
      // drop-and-continue; member: card floats failed).
      if (result.failureCode === 'clarify-forbidden') {
        if (attempt < spec.maxAttempts - 1) {
          errorNotice = spec.clarifyForbiddenNotice
          continue
        }
        return { kind: 'clarify-forbidden-exhausted', runId, errorMessage: msg }
      }
      // RFC-186 §2.2 — every other failure routes through the SAME
      // FOLLOWUP_POLICY table normal nodes use: a listed code is a retryable
      // model slip (fresh turn + reason-tailored notice); anything else is
      // structural and reported non-retryable.
      const fu = followupForFailure(result.failureCode)
      if (fu.retry && attempt < spec.maxAttempts - 1) {
        errorNotice = wgFollowupNotice(fu.reason)
        continue
      }
      return { kind: 'failed', runId, errorMessage: msg, retryable: fu.retry }
    }

    const parsed = spec.parse(result.outputs, { runId, envelopeNonce })
    if (!parsed.ok) {
      errorNotice = parsed.errors.map((e) => `- ${e}`).join('\n')
      if (attempt === spec.maxAttempts - 1) {
        return { kind: 'protocol-exhausted', runId, errors: parsed.errors }
      }
      continue
    }
    return { kind: 'done', value: parsed.value, runId, envelopeNonce }
  }
  // unreachable: every loop path returns or continues within budget
  return { kind: 'failed', runId, errorMessage: 'turn budget exhausted', retryable: false }
}

/** Per-turn protocol-violation retries (RFC-186 §2.4 — the shared normal-node budget). */
export const WG_PROTOCOL_RETRIES = DEFAULT_PROTOCOL_RETRY_BUDGET
