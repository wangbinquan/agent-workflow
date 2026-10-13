/** RFC-372: optional metadata on the existing clarify protocol. */
import { z } from 'zod'

export const ClarifyInteractionModeSchema = z.enum(['questions', 'mindmap'])
export type ClarifyInteractionMode = z.infer<typeof ClarifyInteractionModeSchema>
const categoryName = z.string().trim().min(1).max(120)
/** Legacy strings are one category name, including any literal slash. */
export function clarifyCategoryPaths(
  categories: readonly (string | readonly string[])[],
): string[][] {
  return categories.map((category) => (typeof category === 'string' ? [category] : [...category]))
}
export const ClarifyMindmapConfigSchema = z
  .object({
    categories: z
      .array(z.union([categoryName, z.array(categoryName).min(1).max(40)]))
      .max(40)
      .default([]),
    instructions: z.string().max(8000).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodes = new Set<string>()
    for (const path of clarifyCategoryPaths(value.categories))
      for (let i = 1; i <= path.length; i++) nodes.add(JSON.stringify(path.slice(0, i)))
    if (nodes.size > 40)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categories'],
        message: 'Use at most 40 category nodes, including parent categories.',
      })
  })
export type ClarifyMindmapConfig = z.infer<typeof ClarifyMindmapConfigSchema>
export function resolveClarifyInteractionMode(node: {
  interactionMode?: unknown
}): ClarifyInteractionMode {
  return node.interactionMode === 'mindmap' ? 'mindmap' : 'questions'
}
export const ClarifyQuestionMindmapSchema = z.object({
  categoryPath: z.array(z.string().trim().min(1).max(120)).min(1),
  parentQuestionId: z.string().min(1).max(64).optional(),
  // Set by the append operation, so accepted retries recover from the original questions JSON.
  requestId: z.string().max(64).optional(),
  requestBasis: z.string().max(128).optional(),
})
export const ClarifyFollowupSchema = z
  .object({
    requestId: z.string().uuid(),
    parentQuestionId: z.string().min(1).max(64).optional(),
    /** Empty means the root; a nonempty path selects an existing category. */
    categoryPath: z.array(z.string().trim().min(1).max(120)).optional(),
    basis: z.string().min(1).max(128),
    instruction: z.string().trim().max(2000).default(''),
  })
  .refine(
    (value) => (value.parentQuestionId !== undefined) !== (value.categoryPath !== undefined),
    {
      message: 'Choose one follow-up target: parentQuestionId or categoryPath.',
    },
  )
export type ClarifyFollowup = z.infer<typeof ClarifyFollowupSchema>
export type ClarifyFollowupTarget = string | readonly string[]
