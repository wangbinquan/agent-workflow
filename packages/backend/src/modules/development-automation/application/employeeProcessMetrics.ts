// RFC-616 §6.3 — what the development employee type declares for process metrics: which of its work items are
// rework, and which review comments on its merge request were written by people. Both are rules over this type's
// own vocabulary and documents; the common employee module asks for them through the type package and never reads
// a merge-request context itself.

import { z } from 'zod'
import type { MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS } from '../domain/mergeRequestLifecycle'

type LifecycleWorkItemRef = (typeof MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS)[number]

/**
 * Rework is the work that repairs something that came back: review findings, a failed pipeline, a merge
 * conflict. Collecting or classifying the problem, handing it to another employee and preparing an approval are
 * first-time work, so they are not listed.
 */
const REWORK_WORK_ITEM_REFS = [
  'repair-feedback',
  'repair-pipeline',
  'repair-conflict',
] as const satisfies readonly LifecycleWorkItemRef[]

/** The work item that resolves review threads; a person's review comment is reported against it. */
const REVIEW_FEEDBACK_WORK_ITEM_REF = 'repair-feedback' satisfies LifecycleWorkItemRef

const MERGE_REQUEST_CONTEXT_TYPE_ID = 'development.merge-request'

const authorClassSchema = z.enum(['human', 'bot', 'self'])

/**
 * The fields of the merge-request context this projection reads. The context is validated in full when it is
 * written (`mergeRequestContextSchema`); naming only these fields here keeps this file out of an import cycle
 * with the type package that delegates to it, and keeps unrelated context fields from mattering.
 */
const reviewFeedbackViewSchema = z.object({
  reviewThreads: z
    .array(
      z.object({
        authorClass: authorClassSchema,
        body: z.string(),
        messages: z
          .array(
            z.object({
              authorClass: authorClassSchema,
              body: z.string(),
              createdAt: z.string().nullable(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
})

interface HumanFeedbackItem {
  readonly text: string
  readonly at: number
  readonly workItemRef: string
}

export function describeProcessMetrics(): { readonly reworkWorkItemRefs: readonly string[] } {
  return { reworkWorkItemRefs: REWORK_WORK_ITEM_REFS }
}

/** 0 is the contract's "no time for this item": the comment still counts, it only cannot be placed in time. */
function writtenAt(createdAt: string | null): number {
  const at = createdAt === null ? Number.NaN : Date.parse(createdAt)
  return Number.isFinite(at) && at > 0 ? at : 0
}

/**
 * One item per review comment a person wrote. The author class is the one recorded on each comment — the class on
 * the thread is that of its latest outside comment, so it would hide a person's comment a bot answered. The
 * platform's own replies (`self`) and bots are left out.
 */
export function projectHumanFeedbackJson(contextTypeId: string, stateJson: string): string {
  if (contextTypeId !== MERGE_REQUEST_CONTEXT_TYPE_ID) return JSON.stringify({ items: [] })
  const state = reviewFeedbackViewSchema.parse(JSON.parse(stateJson) as unknown)
  const items: HumanFeedbackItem[] = []
  for (const thread of state.reviewThreads) {
    // A thread recorded before per-comment history existed holds only its latest outside comment.
    const comments =
      thread.messages.length === 0
        ? [{ authorClass: thread.authorClass, body: thread.body, createdAt: null }]
        : thread.messages
    for (const comment of comments) {
      if (comment.authorClass !== 'human' || comment.body.trim() === '') continue
      items.push({
        text: comment.body,
        at: writtenAt(comment.createdAt),
        workItemRef: REVIEW_FEEDBACK_WORK_ITEM_REF,
      })
    }
  }
  return JSON.stringify({ items })
}
