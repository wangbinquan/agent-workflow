// RFC-304 §6.4 — the schema sealing `fix`, and what it deliberately cannot say.
//
// The agent edits the worktree; the envelope carries only what cannot be read
// off the tree. Same asymmetry as the other capabilities, and here it has an
// extra edge: this agent is under pressure to report success, because its whole
// job is to make something green.
//
// So the envelope has NO field in which the agent says whether the fix worked.
// `validate-fix` runs the repository's own gate and decides. An agent-supplied
// `succeeded: true` would be the single most misleading field in this system —
// it would look authoritative, cost nothing to set, and be wrong precisely when
// it matters.
//
// ## `justification` is for the human, and the code says so
//
// The design is explicit (§6.4): requiring a justification and checking it is
// non-empty hands the decision back to the agent's account of itself. It is
// carried into the merge request so a reviewer can read it, and
// `judgeAntiCheat` has no parameter for it.

import { z } from 'zod'

export const CiFixEnvelopeSchema = z
  .object({
    /**
     * What was changed and why, in the agent's words. Reaches the merge
     * request; never consulted by any decision the platform makes.
     */
    summary: z.string().min(1),
    /**
     * Why touching a test was the right thing, when it touched one.
     *
     * Optional, and optional ON PURPOSE. Making it required would create the
     * illusion of a gate — the agent writes a sentence and passes — while the
     * actual adjudication is `red-before-green-after` on the frozen baseline.
     */
    testChangeJustification: z.string().optional(),
    /** Files the agent believes it touched; advisory, verified against the tree. */
    touched: z.array(z.string().min(1)).default([]),
  })
  .strict()

export type CiFixEnvelope = z.infer<typeof CiFixEnvelopeSchema>

/**
 * Which group-layer agent binding repairs a failing pipeline.
 *
 * Its own slot: reading a stack trace and repairing a build is a different job
 * from reviewing a diff or implementing a specification, and a team may well
 * want a cheaper model for it — this is the capability that runs most often.
 */
export const CI_FIX_AGENT_SLOT = 'ci-fixer'
