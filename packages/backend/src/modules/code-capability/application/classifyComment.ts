// RFC-304 §6.2 — deciding whether a comment is a CONFIRMATION.
//
// `judgeConfirmation` and `parseConfirmation` were built with the rest of the
// patch-confirmation design and had ZERO production callers: the stages import
// only the marker helpers from that module. So the platform posted a diff
// saying "reply `/aw apply` to push this", a person replied, and nothing
// happened — Guard 3 of the transition table says an ordinary `note` never
// wakes an `awaiting` item, and an unclassified reply is exactly an ordinary
// note.
//
// That is the worst failure shape this feature has, and the domain module says
// so itself: a confirmation that quietly does nothing means the person believes
// they approved the change, waits, and then stops trusting the mechanism.
//
// ## What this adds, and what it deliberately leaves alone
//
// Only the classification. The transition table still decides whether the
// confirmation is actionable (Guard 2 compares generations, and a stale one is
// answered rather than applied), and the stages still verify the baseline and
// the asker's authority before anything is pushed. This turns a reply into the
// right EVENT; every existing guard downstream keeps its say.

import { findPendingArtifact } from '@/modules/code-capability/application/artifactStore'
import {
  judgeConfirmation,
  type ConfirmationVerdict,
} from '@/modules/code-capability/domain/patchConfirmation'
import { codeWorkItems } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'

export interface ClassifyCommentArgs {
  db: DbClient
  workItemId: string
  /** The comment body as delivered. */
  body: string
  /** The merge request's head right now, for the "branch moved" refusal. */
  currentHeadSha: string
}

export type CommentClassification =
  /** A confirmation the platform should act on; resume at `resumeFromStage`. */
  | { kind: 'confirmation'; generation: number; artifactDigest: string }
  /** A confirmation that cannot be honoured; `message` is posted verbatim. */
  | { kind: 'refused'; message: string }
  /** An ordinary comment. */
  | { kind: 'ordinary' }

/**
 * What a comment on a work item's thread means.
 *
 * Reads the pending artifact and the item's generation, then defers to the
 * domain judge. Returning `ordinary` for anything that is not a command is what
 * keeps the ~150 ordinary comments a day from being treated as instructions.
 */
export async function classifyComment(args: ClassifyCommentArgs): Promise<CommentClassification> {
  const [item] = await args.db
    .select({ generation: codeWorkItems.epoch })
    .from(codeWorkItems)
    .where(eq(codeWorkItems.id, args.workItemId))
    .limit(1)
  if (item === undefined) return { kind: 'ordinary' }

  const pending = await findPendingArtifact(args.db, args.workItemId)

  const verdict: ConfirmationVerdict = judgeConfirmation(args.body, {
    pending:
      pending === null
        ? null
        : {
            digest: pending.digest,
            baseSha: pending.baseSha,
            generation: pending.generation,
          },
    currentGeneration: item.generation,
    currentHeadSha: args.currentHeadSha,
  })

  if (verdict.decision === 'ignore') return { kind: 'ordinary' }
  if (verdict.decision === 'refuse') return { kind: 'refused', message: verdict.message }
  return {
    kind: 'confirmation',
    // The generation the transition table's Guard 2 compares against. Taken
    // from the ARTIFACT rather than from the item: they are equal exactly when
    // the confirmation is still current, and the guard exists to notice when
    // they are not.
    generation: pending?.generation ?? item.generation,
    artifactDigest: verdict.artifactDigest,
  }
}
