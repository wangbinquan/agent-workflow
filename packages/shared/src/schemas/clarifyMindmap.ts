/** RFC-372: optional metadata on the existing clarify protocol. */
import { z } from 'zod'

export const ClarifyInteractionModeSchema = z.enum(['questions', 'mindmap'])
export type ClarifyInteractionMode = z.infer<typeof ClarifyInteractionModeSchema>
export const ClarifyMindmapConfigSchema = z
  .object({
    categories: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
    instructions: z.string().max(8000).default(''),
  })
  .strict()
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
export const ClarifyFollowupSchema = z.object({
  requestId: z.string().uuid(),
  parentQuestionId: z.string().min(1).max(64),
  basis: z.string().min(1).max(128),
  instruction: z.string().trim().max(2000).default(''),
})
export type ClarifyFollowup = z.infer<typeof ClarifyFollowupSchema>
