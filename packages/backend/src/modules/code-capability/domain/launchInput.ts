// RFC-309 T18 — what "start a round from the platform" needs, per capability.
//
// This exists because RFC-304 promised three entrances for `requirement`
// (issue label / platform UI / platform API) and shipped one. Its own plan says
// so: T46b reads「issue 标签入口已通；`/code` 与 API 入口待做」. Until now the
// ONLY way to start any round was a real webhook delivery — `openRound` has
// three callers and all three trace back to `webhookDispatch`.
//
// ## Why a discriminated union rather than a bag of optional fields
//
// The four launchable capabilities need genuinely different starting points: a
// requirement is text a person wrote, a review needs a merge request that
// exists, a CI fix needs a failed pipeline. A single `{ mrIid?, pipelineId?,
// title? }` would let `{capability: 'mr-review', input: {title: '…'}}` compile
// and fail three stages later with "target could not be resolved" — which is
// the shape of failure this repo keeps finding and calling "both halves correct,
// no join". Here it is a type error.
//
// ## The anchor, and why `requirement` gets a new kind
//
// A work item's identity is (endpoint, project, capability, anchorKind,
// anchorId). Three of the four capabilities have a real code-host anchor to
// name. A platform-started requirement has NONE — there is no issue, that is
// the point of the entrance. It gets `anchorKind: 'platform'` and a freshly
// minted id, which means two manual launches of the same requirement are two
// pieces of work rather than one deduplicated by a shared identity. That
// matches what a person means when they submit the same thing twice, and reusing
// `issue` with a synthetic id would make every query on the anchor index treat
// it as a real issue.

import { z } from 'zod'
import { ulid } from 'ulid'
import { RequirementDocumentSchema } from './requirementInput'

export const LaunchInputSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('requirement'),
      /** The requirement itself — what an issue body would have carried. */
      title: z.string().min(1).max(500),
      body: z.string().max(100_000).default(''),
      documents: z.array(RequirementDocumentSchema).max(50).default([]),
    })
    .strict(),
  z
    .object({
      capability: z.literal('mr-review'),
      /** The merge request to review, by its number on the code host. */
      mrIid: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      capability: z.literal('ci-fix'),
      pipelineId: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      capability: z.literal('mr-comment-fix'),
      mrIid: z.string().min(1).max(64),
      /**
       * The discussion thread the comment lives in.
       *
       * Typed by hand today (RFC Q-B's default). It has to be copied from the
       * code host's UI and is easy to get wrong, so the failure it produces
       * must be legible — `resolve-target` reports the id it could not find
       * rather than an empty thread. Fetching the list for a picker is the
       * obvious follow-up and deliberately not in this RFC.
       */
      discussionId: z.string().min(1).max(200),
    })
    .strict(),
])
export type LaunchInput = z.infer<typeof LaunchInputSchema>

/** The four capabilities a person can start by hand. `mr-monitor` is a loop. */
export const LAUNCHABLE_CAPABILITIES = [
  'requirement',
  'mr-review',
  'ci-fix',
  'mr-comment-fix',
] as const
export type LaunchableCapability = (typeof LAUNCHABLE_CAPABILITIES)[number]

export interface LaunchAnchor {
  anchorKind: 'mr' | 'issue' | 'pipeline' | 'platform'
  anchorId: string
}

/**
 * Where this launch attaches on the code host — or that it does not.
 *
 * `mintId` is injected so a test can pin the identity; production passes
 * nothing and gets a ULID.
 */
export function anchorFor(input: LaunchInput, mintId: () => string = ulid): LaunchAnchor {
  switch (input.capability) {
    case 'requirement':
      // No code-host anchor exists. See the header: a fresh id per launch, so
      // submitting the same requirement twice is two pieces of work.
      return { anchorKind: 'platform', anchorId: mintId() }
    case 'mr-review':
      return { anchorKind: 'mr', anchorId: input.mrIid }
    case 'ci-fix':
      return { anchorKind: 'pipeline', anchorId: input.pipelineId }
    case 'mr-comment-fix':
      // The MR, not the discussion: the work item is about the merge request,
      // and a second comment on the same MR must find the same item rather
      // than opening a rival one holding the same lease.
      return { anchorKind: 'mr', anchorId: input.mrIid }
  }
}

/**
 * Whether this launch came from the platform rather than from the code host.
 *
 * Feeds `ClarifyOrigin` (`domain/clarifyRouting.ts`), whose ruling is "ask
 * where it was asked from". A platform launch has no issue to post a question
 * back to, so its questions belong on the platform's own clarify surface —
 * and the routing must NOT fall back to posting somewhere else, because the
 * person who started it is watching the platform.
 */
export function isPlatformOrigin(input: LaunchInput): boolean {
  return input.capability === 'requirement'
}
