// RFC-304 §7.2 — the RESTART half of publish-intent recovery.
//
// The design states the mechanism plainly: 「重启恢复时，对处于『意图已写、结果未写』
// 的批次按 `batchId` 核对远端…已存在则补齐 id，不存在才重发」. What shipped does that
// per ANCHOR, immediately before each publish (`recoverPublishIntents`, called from
// `mr-review`), which is where the named harm lives — the next round would otherwise
// treat an already-posted batch as new and post every finding a second time.
//
// So the duplicate-comment failure was already prevented, and this is not that.
// What was missing is the merge request that never gets another round: its intent
// row stays `pending` for good, and on GitLab the orphan drafts of the interrupted
// batch wait for a `cleanup-previous` that never comes. Nobody is reviewing it, so
// nothing notices.
//
// ## Why this is bounded rather than exhaustive
//
// Reconciling an intent means READING the merge request, so an unbounded sweep is
// one code-host round trip per interrupted batch at every boot — on a busy instance
// that is a slow start and a burst of API traffic aimed at the host, both at the
// least convenient moment. The sweep therefore takes the oldest N anchors and says
// how many it left, rather than quietly doing a subset: a cap nobody can see is
// indistinguishable from a bug (repo rule: no silent caps).
//
// Anything it leaves behind is still recovered the ordinary way the moment another
// round runs on that merge request. This closes the case where none ever does.

import { asc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codePublishIntents, webhookEndpoints } from '@/db/schema'
import { recoverPublishIntents } from '@/modules/code-capability/application/recoverPublishIntents'
import { createCodeHostAdapter } from '@/modules/code-capability/infrastructure/codeHostAdapter'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { RoundTarget } from '@/modules/code-capability/domain/resolveTarget'
import { createLogger } from '@/util/log'

const log = createLogger('code-publish-recovery')

/**
 * Anchors reconciled per boot.
 *
 * Small on purpose. The common case after a clean shutdown is zero; a crash mid
 * publish leaves one or two. A number this size being exceeded means something
 * else is wrong, and the log line saying so is more useful than the sweep
 * grinding through it.
 */
export const BOOT_RECOVERY_ANCHOR_LIMIT = 25

export interface BootRecoveryResult {
  /** Anchors this sweep looked at. */
  anchors: number
  /** Batches settled or re-planned. */
  recovered: number
  /** Anchors left for the ordinary per-round path — stated, never silent. */
  deferred: number
}

/** `<endpointId>:<projectId>:mr:<iid>` — written by the review environment. */
function parseAnchorRef(
  anchorRef: string,
): { endpointId: string; projectId: string; anchorId: string } | null {
  const parts = anchorRef.split(':')
  if (parts.length !== 4) return null
  const [endpointId, projectId, kind, anchorId] = parts
  // Merge requests only: the intent rows are written by the review publish path,
  // and an issue has no draft batch to reconcile.
  if (kind !== 'mr') return null
  if (endpointId === undefined || endpointId === '') return null
  if (projectId === undefined || projectId === '') return null
  if (anchorId === undefined || anchorId === '') return null
  return { endpointId, projectId, anchorId }
}

/**
 * Reconcile interrupted publish batches left by a previous daemon.
 *
 * Best-effort throughout: this runs at boot, and a code host that is down must
 * delay nothing. Every batch it cannot settle stays `pending`, which is the
 * state the ordinary per-round recovery already knows how to handle.
 */
export async function recoverPublishIntentsOnBoot(input: {
  db: DbClient
  /** Injected by tests; production builds an adapter per provider. */
  codeHostFor?: (provider: 'gitlab' | 'github') => CodeHostPort
  limit?: number
  now?: number
}): Promise<BootRecoveryResult> {
  const { db } = input
  const limit = Math.max(1, input.limit ?? BOOT_RECOVERY_ANCHOR_LIMIT)

  const pending = await db
    .select({ anchorRef: codePublishIntents.anchorRef })
    .from(codePublishIntents)
    .where(eq(codePublishIntents.state, 'pending'))
    // Oldest first: the ones least likely to be recovered by a round of their
    // own, because nothing has run on them for the longest.
    .orderBy(asc(codePublishIntents.createdAt))

  const anchors = [...new Set(pending.map((row) => row.anchorRef))]
  const take = anchors.slice(0, limit)
  const deferred = anchors.length - take.length

  let recovered = 0
  for (const anchorRef of take) {
    const parsed = parseAnchorRef(anchorRef)
    if (parsed === null) {
      log.warn('skipping an interrupted publish batch with an unreadable anchor', { anchorRef })
      continue
    }

    const [endpoint] = await db
      .select({ provider: webhookEndpoints.provider })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, parsed.endpointId))
      .limit(1)
    if (endpoint === undefined) {
      // The endpoint was deleted. Nothing can address that merge request any
      // more, so the row is left as the record that it happened.
      log.warn('an interrupted publish batch names an endpoint that no longer exists', {
        anchorRef,
      })
      continue
    }

    const target: RoundTarget = {
      provider: endpoint.provider,
      codeHostEndpointId: parsed.endpointId,
      stableProjectId: parsed.projectId,
      anchorKind: 'mr',
      anchorId: parsed.anchorId,
      // Recovery reads comments and compares fingerprints; it never reasons
      // about the diff, so the revision fields are not part of this question.
      headSha: '',
      targetBranch: null,
      meta: { title: null, url: null, repoPath: null },
    }

    const result = await recoverPublishIntents({
      db,
      codeHost: (input.codeHostFor ?? ((p) => createCodeHostAdapter({ db, provider: p })))(
        endpoint.provider,
      ),
      target,
      anchorRef,
      ...(input.now !== undefined ? { now: input.now } : {}),
    }).catch((err: unknown) => {
      log.warn('recovering an interrupted publish batch threw', {
        anchorRef,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    })

    if (result === null) continue
    if (result.problem !== null) {
      // Left pending deliberately — see `recoverPublishIntents`: settling on a
      // failed read would mark a batch recovered with nobody having looked.
      log.info('an interrupted publish batch stays pending', {
        anchorRef,
        problem: result.problem,
      })
      continue
    }
    recovered += result.batches.length
  }

  if (deferred > 0) {
    // Never silent. A sweep that quietly did 25 of 400 reads as "recovery ran".
    log.warn('more interrupted publish batches than this boot reconciles', {
      anchors: anchors.length,
      reconciled: take.length,
      deferred,
      note: 'the rest recover when a round next runs on those merge requests',
    })
  }
  return { anchors: take.length, recovered, deferred }
}
