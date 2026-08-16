// RFC-304 §6.3 T48 — what a `requirement` round is given to build from.
//
// The user's words were "implement code from **a set of** design documents", and
// this repository's own RFCs are three files (proposal / design / plan), so the
// input contract is a DOCUMENT SET rather than a document. That is not a
// generalisation for its own sake: a platform that took one document would make
// every team paste three into one, and the seams between them — which is where
// "see design §4" lives — would be gone by the time the agent read it.
//
// ## Order is meaningful; `role` is not
//
// Documents enter the agent's context in the order given. `role` ('proposal',
// 'design', 'plan') is a HINT rendered into the prompt, never something the
// platform branches on: document systems differ between companies, and a
// platform that required a 'design' document would reject a perfectly good
// two-file set.
//
// ## Over budget is REPORTED, never truncated
//
// The most expensive failure available here is a silent one. Truncate the set
// and the agent implements the first two thirds of a requirement, produces a
// merge request that looks complete, and the missing third is discovered in
// review — or later. So the size check is explicit, it names every document's
// size, and it stops the round.

import { z } from 'zod'

export const RequirementDocumentSchema = z
  .object({
    /** Shown to the agent and in the activity view; a filename works. */
    name: z.string().min(1),
    /**
     * A hint about what kind of document this is. Free text, not an enum:
     * every company's document system names these differently, and an enum
     * here would reject a set for using the wrong vocabulary.
     */
    role: z.string().optional(),
    /** The document itself. */
    content: z.string(),
  })
  .strict()

export type RequirementDocument = z.infer<typeof RequirementDocumentSchema>

export const RequirementInputSchema = z
  .object({
    title: z.string().min(1),
    /** The requirement's own text, when it came from an issue body. */
    body: z.string().default(''),
    /**
     * The document set, IN ORDER. May be empty when the requirement is just an
     * issue: a bug report is a requirement too, and demanding a design document
     * for "the retry loop drops the last attempt" would make the capability
     * unusable for the case it is most obviously useful for.
     */
    documents: z.array(RequirementDocumentSchema).default([]),
    /**
     * How to write back to wherever this came from — an issue comment, usually.
     * Absent means there is no return channel, which is a fact the clarify
     * routing needs (design D2) rather than something to paper over.
     */
    writebackHandle: z
      .object({
        kind: z.enum(['issue-comment']),
        /** Everything the write-back call needs, as the host action's params. */
        params: z.record(z.string(), z.string()),
      })
      .strict()
      .optional(),
  })
  .strict()

export type RequirementInput = z.infer<typeof RequirementInputSchema>

export interface DocumentBudget {
  /**
   * Characters, summed across the set plus the body.
   *
   * Characters rather than tokens because the platform cannot count tokens
   * without the model's tokenizer, and a budget that is wrong in an unknown
   * direction is worse than a coarse one that is honestly coarse. 400k is
   * roughly a 100k-token context with room for the prompt and the answer.
   */
  maxTotalChars: number
}

export const DEFAULT_DOCUMENT_BUDGET: DocumentBudget = { maxTotalChars: 400_000 }

export interface DocumentSizes {
  totalChars: number
  perDocument: ReadonlyArray<{ name: string; chars: number }>
}

export function measureDocuments(input: RequirementInput): DocumentSizes {
  const perDocument = input.documents.map((doc) => ({ name: doc.name, chars: doc.content.length }))
  const totalChars = input.body.length + perDocument.reduce((sum, entry) => sum + entry.chars, 0)
  return { totalChars, perDocument }
}

export type BudgetVerdict =
  | { fits: true; sizes: DocumentSizes }
  /** `message` reaches the person who submitted the set, verbatim. */
  | { fits: false; sizes: DocumentSizes; message: string }

/**
 * Does the set fit?
 *
 * The refusal lists every document with its size, because the person's next
 * question is "which one do I split?" and answering it with a total tells them
 * nothing. This is the whole reason the check is explicit rather than a
 * truncation: truncating produces a merge request that looks complete and is
 * not, and nobody finds out until review.
 */
export function judgeDocumentBudget(
  input: RequirementInput,
  budget: DocumentBudget = DEFAULT_DOCUMENT_BUDGET,
): BudgetVerdict {
  const sizes = measureDocuments(input)
  if (sizes.totalChars <= budget.maxTotalChars) return { fits: true, sizes }

  const breakdown = sizes.perDocument
    .map((entry) => `  ${entry.name}: ${entry.chars.toLocaleString('en-US')} characters`)
    .join('\n')

  return {
    fits: false,
    sizes,
    message: [
      `This document set is ${sizes.totalChars.toLocaleString('en-US')} characters, past the ${budget.maxTotalChars.toLocaleString('en-US')}-character limit for one round.`,
      '',
      'Nothing was implemented — a truncated set would produce a merge request that',
      'looks complete and silently leaves out whatever did not fit.',
      '',
      'Sizes:',
      breakdown === ''
        ? `  (the issue body alone is ${String(input.body.length)} characters)`
        : breakdown,
      '',
      'Split the requirement, or trim the documents, and label the issue again.',
    ].join('\n'),
  }
}

/**
 * The document set as the implementing agent reads it.
 *
 * Plain text with explicit separators rather than JSON: this goes into a prompt,
 * and a model reads documents better as documents. Cross-references between them
 * ("see design §4") are left for the agent to resolve — the platform makes no
 * attempt to link them, because a wrong link is worse than none.
 */
export function renderRequirementForPrompt(input: RequirementInput): string {
  const parts: string[] = [`# ${input.title}`]
  if (input.body.trim() !== '') parts.push(input.body.trim())

  for (const [index, doc] of input.documents.entries()) {
    const role = doc.role === undefined || doc.role === '' ? '' : ` (${doc.role})`
    parts.push(
      `--- document ${String(index + 1)} of ${String(input.documents.length)}: ${doc.name}${role} ---`,
      doc.content.trim(),
    )
  }

  return parts.join('\n\n')
}
