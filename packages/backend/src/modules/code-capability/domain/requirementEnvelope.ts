// RFC-304 §6.3 — the two schemas sealing `requirement`'s model stages.
//
// `comprehend` decides whether the requirement can be built at all; `implement`
// builds it. They are separate stages with separate envelopes because the
// question between them is the one a human answers, and a single "read it and
// build it" stage would have nowhere to stop and ask.

import { z } from 'zod'

/**
 * `comprehend` — does this requirement say enough to build?
 *
 * The interesting arm is `needs-clarification`. An agent that must always
 * proceed will proceed: it fills the gap with the most plausible reading and
 * produces a merge request implementing a requirement nobody wrote. That
 * failure is expensive precisely because the result looks right — it compiles,
 * it has tests, and it solves the wrong problem.
 *
 * So asking is a legal, schema-level answer, and the questions are structured
 * rather than free prose: they are posted as a numbered list and the reply is
 * matched back to the round, which needs them to be separable.
 */
export const ComprehendEnvelopeSchema = z
  .object({
    outcome: z.enum(['ready', 'needs-clarification']),
    /**
     * The agent's reading of what is being asked, in its own words. Recorded
     * for both outcomes: on `ready` it is what the implementation was built
     * from, and a wrong implementation is usually a wrong reading that nobody
     * saw. Shown in the activity view.
     */
    understanding: z.string().min(1),
    /**
     * Required — and only meaningful — when asking. Empty questions with
     * `needs-clarification` would stall the requirement with nothing to answer.
     */
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .refine((value) => value.outcome !== 'needs-clarification' || value.questions.length > 0, {
    message: 'needs-clarification requires at least one question',
    path: ['questions'],
  })

export type ComprehendEnvelope = z.infer<typeof ComprehendEnvelopeSchema>

/**
 * `implement` — the code is in the worktree; this is what to say about it.
 *
 * Same asymmetry as `mr-comment-fix`: the real output is the tree, and the
 * envelope carries only what cannot be read off it. A patch in the envelope
 * would give the platform two sources of truth for one change, and they diverge
 * the moment the agent edits another file after emitting the first.
 */
export const ImplementEnvelopeSchema = z
  .object({
    /** The merge request's title. One line; the platform does not invent one. */
    title: z.string().min(1).max(200),
    /** The merge request's description — what was built and why. */
    summary: z.string().min(1),
    /**
     * Anything the agent chose NOT to do, and why.
     *
     * Present as a first-class field rather than left to the summary's prose,
     * because it is the part a reviewer most needs and the part most easily
     * lost in a wall of text. An empty list is a claim too: "I built all of it".
     */
    deferred: z.array(z.string().min(1)).default([]),
  })
  .strict()

export type ImplementEnvelope = z.infer<typeof ImplementEnvelopeSchema>

/**
 * Which group-layer agent bindings run the two stages.
 *
 * Separate slots because reading a specification and writing a system are
 * different jobs, and a team may well want a stronger model for one of them. A
 * team that wants one agent for both points both slots at it.
 */
export const COMPREHEND_AGENT_SLOT = 'analyst'
export const IMPLEMENT_AGENT_SLOT = 'implementer'
