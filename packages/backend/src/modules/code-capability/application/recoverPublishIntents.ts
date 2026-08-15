// RFC-304 §7.2 — recovering a publish that was interrupted.
//
// The window is small and the damage is not. `publish` posts comments, then
// `ledger` records them. A crash, a cancel or a preemption between those two
// leaves the comments ON the MR with nothing in the ledger that knows it — so
// the next round reconciles against an empty history, decides every finding is
// new, and posts the whole review a second time. The duplicate-comment bug the
// ledger exists to prevent, reintroduced by a crash rather than by a bug.
//
// The fix is an intent written BEFORE the outbound call: a durable record of
// what this batch is about to say. On the next round, any batch still `pending`
// is a batch whose outcome nobody observed, and this pass observes it — by
// reading the MR and looking for the fingerprint markers the comments carry.
//
// ## Why it reads the remote instead of assuming
//
// Both assumptions are wrong in the same proportion of cases. Assume the batch
// landed and it did not, and those findings are suppressed forever — recorded
// as published, never said. Assume it did not land and it did, and the author
// gets everything twice. Only the MR knows, so the MR is asked.
//
// ## Why a failed read leaves the intent pending
//
// A pending intent is recoverable next round; a wrongly-settled one is not.
// When the host cannot be read, doing nothing is the only action that keeps the
// question open.

import type { DbClient } from '@/db/client'
import {
  observeBatch,
  normalizeRemoteComments,
} from '@/modules/code-capability/domain/publishReconcileRemote'
import { planPublishRecovery } from '@/modules/code-capability/domain/publishIntent'
import {
  readPendingIntentsForAnchor,
  settleIntent,
} from '@/modules/code-capability/infrastructure/sqlitePublishIntentStore'
import { apiProjectAddress, type RoundTarget } from '@/modules/code-capability/domain/resolveTarget'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'

/** What one interrupted batch turned out to be. */
export interface RecoveredBatch {
  batchId: string
  /** Fingerprints found on the MR, mapped to the thread that carries them. */
  adopted: Readonly<Record<string, string>>
  /** In the batch, absent from the MR — this round should publish them. */
  unpublished: readonly string[]
  outcome: 'adopt' | 'resend' | 'complete' | 'none'
}

export interface RecoverPublishIntentsResult {
  batches: readonly RecoveredBatch[]
  /**
   * Every fingerprint confirmed present on the MR, across all batches.
   *
   * The caller folds these into the ledger before reconciling, which is what
   * stops the re-post: a fingerprint the ledger knows about is `keep`, not
   * `publish`.
   */
  adopted: Readonly<Record<string, string>>
  /** Null when nothing needed recovering, or when it completed. */
  problem: string | null
}

const NOTHING: RecoverPublishIntentsResult = { batches: [], adopted: {}, problem: null }

export async function recoverPublishIntents(input: {
  db: DbClient
  codeHost: CodeHostPort
  target: RoundTarget
  /** How this MR is named in the intent rows. */
  anchorRef: string
  now?: number
}): Promise<RecoverPublishIntentsResult> {
  const pending = await readPendingIntentsForAnchor(input.db, input.anchorRef)
  if (pending.length === 0) return NOTHING

  const project = apiProjectAddress(input.target)
  if (!project.ok) {
    return { batches: [], adopted: {}, problem: project.message }
  }

  const listed = await input.codeHost.call({
    action: 'comment.list',
    params: { project: project.value, mr: input.target.anchorId, per_page: '100' },
  })
  if (!listed.ok) {
    // Left pending on purpose. Settling on a failed read would mark a batch
    // recovered without anyone having looked at the MR.
    return {
      batches: [],
      adopted: {},
      problem: `could not read this merge request's existing comments (${listed.code}: ${listed.message}), so ${pending.length} interrupted publish batch(es) stay pending`,
    }
  }

  const comments = normalizeRemoteComments(input.target.provider, listed.body)
  const batches: RecoveredBatch[] = []
  const adopted: Record<string, string> = {}

  for (const intent of pending) {
    const observed = observeBatch(intent.fingerprints, comments)
    const plan = planPublishRecovery(intent, observed)

    switch (plan.action) {
      case 'adopt':
        // Everything landed. Settle it, and hand the ids up so the ledger can
        // record what the dead round never got to.
        await settleIntent(input.db, intent.batchId, plan.externalIds, input.now ?? Date.now())
        Object.assign(adopted, plan.externalIds)
        batches.push({
          batchId: intent.batchId,
          adopted: plan.externalIds,
          unpublished: [],
          outcome: 'adopt',
        })
        break

      case 'resend':
        // None of it landed. Left pending: this round will publish these
        // findings normally (they are absent from the ledger), and settling now
        // would claim a batch was recovered when nothing was.
        batches.push({
          batchId: intent.batchId,
          adopted: {},
          unpublished: plan.fingerprints,
          outcome: 'resend',
        })
        break

      case 'complete': {
        // The partial case, and the one a naive implementation gets wrong: it
        // is tempting to resend the whole batch and let the host dedupe. It
        // will not — the author would see the landed half twice.
        await settleIntent(input.db, intent.batchId, plan.adopt, input.now ?? Date.now())
        Object.assign(adopted, plan.adopt)
        batches.push({
          batchId: intent.batchId,
          adopted: plan.adopt,
          unpublished: plan.resend,
          outcome: 'complete',
        })
        break
      }

      case 'none':
        batches.push({ batchId: intent.batchId, adopted: {}, unpublished: [], outcome: 'none' })
        break
    }
  }

  return { batches, adopted, problem: null }
}
