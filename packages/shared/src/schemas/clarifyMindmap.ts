/** RFC-372: optional metadata on the existing clarify protocol. */
import { z } from 'zod'
import { utf16MaxLength } from './utf16Length'

export const ClarifyInteractionModeSchema = z.enum(['questions', 'mindmap'])
export type ClarifyInteractionMode = z.infer<typeof ClarifyInteractionModeSchema>
const categoryName = z.string().trim().min(1).check(utf16MaxLength(120))
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
    instructions: z.string().check(utf16MaxLength(8000)).default(''),
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
  categoryPath: z.array(z.string().trim().min(1).check(utf16MaxLength(120))).min(1),
  parentQuestionId: z.string().min(1).check(utf16MaxLength(64)).optional(),
  // Set by the append operation, so accepted retries recover from the original questions JSON.
  requestId: z.string().check(utf16MaxLength(64)).optional(),
  requestBasis: z.string().check(utf16MaxLength(128)).optional(),
})
export const ClarifyFollowupSchema = z
  .object({
    requestId: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
    parentQuestionId: z.string().min(1).check(utf16MaxLength(64)).optional(),
    /** Empty means the root; a nonempty path selects an existing category. */
    categoryPath: z.array(z.string().trim().min(1).check(utf16MaxLength(120))).optional(),
    basis: z.string().min(1).check(utf16MaxLength(128)),
    instruction: z.string().trim().check(utf16MaxLength(2000)).default(''),
  })
  .refine(
    (value) => (value.parentQuestionId !== undefined) !== (value.categoryPath !== undefined),
    {
      message: 'Choose one follow-up target: parentQuestionId or categoryPath.',
    },
  )
export type ClarifyFollowup = z.infer<typeof ClarifyFollowupSchema>
export type ClarifyFollowupTarget = string | readonly string[]
/** RFC-372 O8: an accepted request generates in the background; a replayed one is done. */
export const ClarifyFollowupStartSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }),
  z.object({ state: z.literal('done'), questionIds: z.array(z.string()) }),
])
export type ClarifyFollowupStart = z.infer<typeof ClarifyFollowupStartSchema>
/** RFC-372 O8: the round's running follow-up, or its last failure until another starts. */
export const ClarifyFollowupStatusSchema = z.object({
  requestId: z.string(),
  state: z.enum(['running', 'failed']),
  /** The selected question id, or the selected category path (empty = root). */
  target: z.union([z.string(), z.array(z.string())]),
  startedAt: z.number().int(),
  /** Original request, for a faithful retry after refresh. Absent in legacy status. */
  instruction: z.string().check(utf16MaxLength(2000)).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
export type ClarifyFollowupStatus = z.infer<typeof ClarifyFollowupStatusSchema>
