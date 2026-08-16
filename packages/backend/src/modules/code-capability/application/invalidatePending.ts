// RFC-304 T45 — a push invalidates whatever was waiting for confirmation.
//
// A change is posted as a diff and waits. The author, meanwhile, pushes — maybe
// they fixed it themselves, maybe they rewrote the whole file. Either way the
// frozen change was computed against code that no longer exists.
//
// `verify-baseline` already refuses to push a stale artifact, so nothing WRONG
// happens if this never runs. What happens instead is worse in a quieter way:
// the diff sits on the thread looking live, the author replies `/aw apply` days
// later, and only then learns it expired. They were never told, and the thing
// they were told to do turned out not to work.
//
// So the invalidation is PROACTIVE and it SPEAKS: the artifact is released the
// moment the branch moves, and the thread gets one line saying so.

import {
  releaseArtifact,
  findPendingArtifact,
} from '@/modules/code-capability/application/artifactStore'
import { shortDigest } from '@/modules/code-capability/domain/patchConfirmation'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import type { DbClient } from '@/db/client'

export interface InvalidatePendingArgs {
  db: DbClient
  git: GitPort
  workItemId: string
  /** The branch's new head. An artifact built on it is still valid. */
  newHeadSha: string
  /** Absent ⇒ the artifact is released quietly; nothing is posted. */
  notify?: {
    codeHost: CodeHostPort
    /** Params addressing the thread the diff was posted to. */
    threadParams: Readonly<Record<string, string>>
  }
}

export type InvalidateResult =
  | { invalidated: false; reason: 'nothing-pending' | 'still-current' }
  | { invalidated: true; artifactId: string; notified: boolean }

/**
 * Release the pending change if the branch has moved past it.
 *
 * Idempotent by construction: once released, `findPendingArtifact` returns
 * nothing and a second call reports `nothing-pending`. That matters because the
 * same push arrives as several events (`mr_updated`, a pipeline start, a
 * comment from CI) and each of them wakes the monitor.
 */
export async function invalidatePendingOnPush(
  args: InvalidatePendingArgs,
): Promise<InvalidateResult> {
  const pending = await findPendingArtifact(args.db, args.workItemId)
  if (pending === null) return { invalidated: false, reason: 'nothing-pending' }

  // The artifact is built ON the head it was computed against. A push that
  // lands exactly there is this platform's own push, or a no-op re-report of
  // the same revision — either way the change still applies.
  if (pending.baseSha === args.newHeadSha) {
    return { invalidated: false, reason: 'still-current' }
  }

  await releaseArtifact(args.db, args.git, pending.id, 'superseded')

  let notified = false
  if (args.notify !== undefined) {
    const posted = await args.notify.codeHost.call({
      action: 'comment.reply-thread',
      params: {
        ...args.notify.threadParams,
        body: invalidationNotice(pending.digest, args.newHeadSha),
      },
    })
    notified = posted.ok
  }

  return { invalidated: true, artifactId: pending.id, notified }
}

/**
 * The one line the thread gets.
 *
 * Short on purpose. This fires on every push to a merge request with something
 * pending, which on an active branch is several times a day — a paragraph would
 * be the noise §11.1 warns about. It says the change expired, why, and that
 * nothing was lost.
 */
export function invalidationNotice(digest: string, newHeadSha: string): string {
  return `The change above (\`${shortDigest(digest)}\`) no longer applies — the branch moved to \`${newHeadSha.slice(0, 12)}\`. It was discarded rather than applied; the next round will look again.`
}
