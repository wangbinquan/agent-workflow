// RFC-304 §6.1 — the schema sealing the `review` stage, and what counts as a
// bad answer worth re-asking for.
//
// Constitution R3: every AI step declares its output shape and the framework
// validates it; R5: nothing downstream ever sees an unvalidated value. The
// schema below is that declaration. What needs care is the line between the two
// kinds of "wrong" an answer can be, because they want opposite handling:
//
//   MALFORMED  — an empty body, a line number of 0, the same finding emitted
//                three times. The model can plausibly do better on a retry, so
//                these are rejected and the round re-asks (R4).
//
//   UNANCHORABLE — a remark about a file this MR does not touch, or a line
//                outside every hunk. Re-asking does NOT help: the model may be
//                making a legitimate point about code it read as context, and a
//                retry just burns the budget and eventually fails the round for
//                having had a thought. These pass validation and degrade at
//                `resolve-positions` instead (AC-4).
//
// Getting that line wrong in either direction is expensive. Treat unanchorable
// as malformed and a reviewer that mentions a caller in a neighbouring file
// costs the whole round; treat malformed as acceptable and the platform
// publishes an empty comment on line 0.

import { z } from 'zod'
import { FINDING_SEVERITIES } from '@/modules/code-capability/domain/findingGate'

export const ReviewFindingSchema = z
  .object({
    /** Repo-relative path, as it appears in the diff. */
    file: z.string().min(1),
    /**
     * 1-based line in the side named by `side`. Integer and positive: git has
     * no line 0, and a float would be silently floored by every host API.
     */
    line: z.number().int().positive(),
    /** Which side of the diff `line` indexes. Most remarks are about the new. */
    side: z.enum(['new', 'old']).default('new'),
    severity: z.enum(FINDING_SEVERITIES),
    /** One line, shown as the comment's first line and used for dedup. */
    title: z.string().min(1).max(200),
    /** The explanation. Empty is a format failure, not a terse review. */
    body: z.string().min(1),
  })
  .strict()

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const ReviewEnvelopeSchema = z
  .object({
    // No `.min(1)`: a review that found nothing is a real and common answer,
    // and rejecting it would make the model invent a finding to satisfy the
    // schema — the single most expensive failure mode this platform has, since
    // an invented finding is indistinguishable from a real one at every later
    // stage.
    findings: z.array(ReviewFindingSchema),
  })
  .strict()

export type ReviewEnvelope = z.infer<typeof ReviewEnvelopeSchema>

/**
 * Identity for dedup within one answer: the same spot, the same point.
 *
 * `JSON.stringify` rather than a joined string, matching how RFC-303 builds its
 * stream key. A delimiter has to be a character that cannot appear in any part,
 * and a review title can contain anything — so the choice is between picking an
 * exotic separator and not needing one. Encoding removes the question.
 */
function findingKey(finding: ReviewFinding): string {
  return JSON.stringify([
    finding.file,
    finding.side,
    finding.line,
    finding.title.trim().toLowerCase(),
  ])
}

/**
 * Semantic problems that a retry can plausibly fix.
 *
 * Returns one message per problem, phrased as an instruction to the model —
 * these go back verbatim as the retry's feedback, so "two findings share the
 * same file, line and title" is useful and "SEMANTIC_ERROR_DUP" is not.
 */
export function checkReviewSemantics(envelope: ReviewEnvelope): string[] {
  const problems: string[] = []

  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const finding of envelope.findings) {
    const key = findingKey(finding)
    if (seen.has(key)) duplicated.add(`${finding.file}:${finding.line} "${finding.title}"`)
    seen.add(key)
  }
  for (const duplicate of duplicated) {
    // Left unfixed this publishes the same comment two or three times on one
    // line, which reads as a malfunction rather than a review.
    problems.push(
      `the same finding appears more than once (${duplicate}) — report each distinct problem exactly once`,
    )
  }

  for (const finding of envelope.findings) {
    if (finding.title.trim() === '') {
      problems.push(`a finding on ${finding.file}:${finding.line} has a title of only whitespace`)
    }
    if (finding.body.trim() === '') {
      problems.push(`a finding on ${finding.file}:${finding.line} has a body of only whitespace`)
    }
    if (finding.file.startsWith('/')) {
      // An absolute path cannot be matched against a diff, which is entirely
      // repo-relative, so every such finding would degrade for a reason that is
      // purely a formatting slip.
      problems.push(
        `the path "${finding.file}" is absolute — report paths relative to the repository root`,
      )
    }
  }

  return problems
}
