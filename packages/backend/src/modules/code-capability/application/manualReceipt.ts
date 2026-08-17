// RFC-304 §11.2 T59 — the receipt a person who typed at the platform is owed.
//
// The rule the second design gate added: a reviewer @-mentions the platform, or
// an author types the confirmation keyword, and half an hour later nothing has
// happened. They cannot tell whether it was never received, is queued behind a
// lease, or failed — so they @-mention it AGAIN, producing another round and
// more noise. Silence does not reduce noise on the manual paths; it multiplies
// it.
//
// `mrVoice.answer` implemented the receipt exactly as designed — created once,
// edited in place, so the whole "received → working → done" exchange costs one
// notification — and had no production caller. Nobody has ever received one.
//
// This module is the join, and it is deliberately one function used from both
// ends of the exchange: the ingress (which knows a person asked) and the round
// finalize (which knows how it ended).

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeTriggerDeliveries, webhookEndpoints } from '@/db/schema'
import { answer } from '@/modules/code-capability/application/mrVoice'
import { createCodeHostAdapter } from '@/modules/code-capability/infrastructure/codeHostAdapter'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { ReceiptState } from '@/modules/code-capability/domain/triggerSource'
import { createLogger } from '@/util/log'

const log = createLogger('code-manual-receipt')

export type ReceiptOutcome = { answered: true } | { answered: false; reason: string }

/**
 * Create or update the receipt for one manual instruction.
 *
 * The `operationId` is the delivery's correlation id — the same id the
 * troubleshooting chain is keyed by, so the receipt a person reads and the row
 * an administrator greps for are provably the same event. Inventing a separate
 * id would give the two halves no way to be matched up.
 *
 * Best-effort, like every other thing the platform says: an instruction whose
 * receipt cannot be posted has still been carried out, and failing the work
 * because the acknowledgement failed would be the wrong way round.
 */
export async function answerManualInstruction(input: {
  db: DbClient
  operationId: string
  endpointId: string
  stableProjectId: string | null
  anchorKind: string | null
  anchorId: string | null
  state: ReceiptState
  /** False when only an EXISTING receipt may be updated — see `answer`. */
  createIfMissing?: boolean
  /** Injected by tests only; by parameter, never by a process-wide module mock. */
  codeHost?: CodeHostPort
}): Promise<ReceiptOutcome> {
  const { db } = input

  if (input.stableProjectId === null || input.anchorId === null) {
    return { answered: false, reason: 'the instruction has no thread to answer on' }
  }
  // Merge requests and issues both take comments; a pipeline anchor does not,
  // and a person cannot have typed an instruction at one anyway.
  if (input.anchorKind !== 'mr' && input.anchorKind !== 'issue') {
    return { answered: false, reason: `cannot answer on a ${String(input.anchorKind)} anchor` }
  }

  const [endpoint] = await db
    .select({ provider: webhookEndpoints.provider })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, input.endpointId))
    .limit(1)
  if (endpoint === undefined) {
    return { answered: false, reason: 'the endpoint this arrived on no longer exists' }
  }

  // The anchor decides BOTH the field name and the action. Answering a merge
  // request instruction on an issue thread — or the reverse — is a 404 the
  // person never sees, because the failure is on our side of the wire.
  //
  // The issue actions exist because they had to: `comment.create` and its
  // siblings are merge-request-only (GitLab's binding is
  // `/merge_requests/{mr}/notes`), so the first version of this could not post
  // on a GitLab issue at all and quietly did nothing. That is why AC-34 was
  // unreachable, and why the catalog gained `comment.*-issue`.
  const onIssue = input.anchorKind === 'issue'
  const result = await answer(
    {
      codeHost: input.codeHost ?? createCodeHostAdapter({ db, provider: endpoint.provider }),
      target: {
        project: input.stableProjectId,
        ...(onIssue ? { issue: input.anchorId } : { mr: input.anchorId }),
      },
      actions: onIssue
        ? {
            list: 'comment.list-issue',
            create: 'comment.create-issue',
            update: 'comment.update-issue',
          }
        : undefined,
    },
    input.operationId,
    input.state,
    { createIfMissing: input.createIfMissing ?? true },
  )

  if (!result.ok) {
    log.warn('could not answer a manual instruction', {
      operationId: input.operationId,
      anchorKind: input.anchorKind,
      anchorId: input.anchorId,
    })
    return { answered: false, reason: 'the code host refused the comment' }
  }
  return { answered: true }
}

/**
 * Close the receipt belonging to the round that just ended.
 *
 * The link is `code_trigger_deliveries.round_id`, written when the round
 * started. Without it the finalize path would have to guess which instruction a
 * round answered — by anchor and timestamp proximity, which is wrong exactly
 * when the platform is busy and two instructions are in flight on one merge
 * request.
 *
 * A round nobody asked for (an ordinary webhook) has no manual delivery, so
 * this finds nothing and says so: that is the automatic path staying silent,
 * which is the other half of §11.2.
 */
export async function closeReceiptForRound(input: {
  db: DbClient
  roundId: string
  state: ReceiptState
  codeHost?: CodeHostPort
}): Promise<ReceiptOutcome> {
  const { db } = input

  const rows = await db
    .select()
    .from(codeTriggerDeliveries)
    .where(eq(codeTriggerDeliveries.roundId, input.roundId))
    .limit(1)
  const delivery = rows[0]
  if (delivery === undefined) {
    return { answered: false, reason: 'no delivery is linked to this round' }
  }
  if (delivery.isProbe) {
    return { answered: false, reason: 'a probe delivery has no person waiting' }
  }

  // `createIfMissing: false` is what keeps the automatic path silent, and it
  // needs no extra column to do it: the ingress creates a receipt only for an
  // instruction a person typed, so "does a receipt with this id exist on the
  // thread" IS the question "was anybody waiting". A round nobody asked for
  // finds nothing to edit and says nothing.
  return await answerManualInstruction({
    createIfMissing: false,
    ...(input.codeHost !== undefined ? { codeHost: input.codeHost } : {}),
    db,
    operationId: delivery.correlationId,
    endpointId: delivery.codeHostEndpointId ?? '',
    stableProjectId: delivery.stableProjectId,
    anchorKind: delivery.anchorKind,
    anchorId: delivery.anchorId,
    state: input.state,
  })
}
