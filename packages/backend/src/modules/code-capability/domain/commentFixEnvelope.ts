// RFC-304 §6.2 — the schema sealing `apply-change`, and why it is so small.
//
// The reviewing agent returns findings, so its envelope carries them. The
// FIXING agent's real output is not in the envelope at all: it is the worktree
// it edited. What comes back through the envelope is only what the platform
// cannot read off the tree — a sentence for the human, and the agent's own
// account of whether it managed the fix.
//
// This asymmetry is deliberate and worth stating, because the obvious design is
// to have the agent return a patch. That would give the platform two sources of
// truth for one change — the tree and the patch text — and they disagree the
// moment the agent edits a second file after emitting the first. The tree wins
// by construction if the tree is the only source.
//
// ## `outcome: 'declined'` is a first-class answer
//
// A reviewer's comment is not always actionable: "this whole approach is
// wrong", "let's discuss in standup", "can you rebase". An agent forced to
// return a change for every thread produces a plausible edit for a comment that
// was not asking for one — the most expensive failure available here, because
// the edit reaches a human wearing the platform's authority. So declining is a
// valid, schema-legal answer with a required reason, and it settles the round
// without touching the code.

import { z } from 'zod'

export const CommentFixEnvelopeSchema = z
  .object({
    /**
     * What the agent did. `changed` claims edits are in the worktree; the
     * platform verifies that separately at `validate-change`, because a claim
     * is not evidence.
     */
    outcome: z.enum(['changed', 'declined']),
    /**
     * The reply posted alongside the change, in the reviewer's thread. Required
     * for both outcomes: a change with no explanation makes the reviewer read
     * the diff to find out what was understood, and a decline with no reason is
     * indistinguishable from the platform being broken.
     */
    message: z.string().min(1),
    /**
     * Files the agent believes it touched. Advisory only — `validate-change`
     * reads the tree — but recorded, because a mismatch between what an agent
     * says it did and what it did is the most useful debugging signal there is.
     */
    touched: z.array(z.string().min(1)).default([]),
  })
  .strict()

export type CommentFixEnvelope = z.infer<typeof CommentFixEnvelopeSchema>

/**
 * Which group-layer agent binding writes the fix.
 *
 * Separate from `reviewer` on purpose: reviewing and editing are different jobs
 * with different prompts, and a team that wants one agent for both can point
 * both slots at it. Merging the slots would take that choice away.
 *
 * Declared once and referenced by the contract, because the slot name is a JOIN
 * key: the contract declares it, `capability_bindings.agent_by_slot_json` is
 * keyed by it, and the resolver looks it up. Two spellings resolve to "no agent
 * bound" for a slot somebody had, in fact, bound.
 */
export const COMMENT_FIX_AGENT_SLOT = 'fixer'
