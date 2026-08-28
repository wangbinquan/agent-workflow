// RFC-340 — review-node-scoped, opinion-only reviewers.
//
// This is deliberately separate from taskCollab.ts: a reviewer assignment
// grants access to one frozen review node and does not make the user a task
// collaborator or observer.

import { z } from 'zod'
import { UserPublicSchema } from './user'

export const ReviewAccessScopeSchema = z.enum(['task', 'review-node'])
export type ReviewAccessScope = z.infer<typeof ReviewAccessScopeSchema>

export const ReviewCapabilitiesSchema = z.object({
  scope: ReviewAccessScopeSchema,
  canAddComment: z.boolean(),
  canEditOwnComments: z.boolean(),
  canDeleteOwnComments: z.boolean(),
  canManageAnyComments: z.boolean(),
  canSelectDocuments: z.boolean(),
  canDecide: z.boolean(),
})
export type ReviewCapabilities = z.infer<typeof ReviewCapabilitiesSchema>

export const ReviewNodeReviewerSelectionSchema = z.object({
  reviewNodeId: z.string().min(1),
  reviewerUserIds: z.array(z.string().min(1)).max(256),
})
export type ReviewNodeReviewerSelection = z.infer<typeof ReviewNodeReviewerSelectionSchema>

export const ReplaceReviewNodeReviewersBodySchema = z.object({
  nodes: z.array(ReviewNodeReviewerSelectionSchema).max(256),
})
export type ReplaceReviewNodeReviewersBody = z.infer<typeof ReplaceReviewNodeReviewersBodySchema>

export const ReviewNodeReviewerConfigNodeSchema = z.object({
  reviewNodeId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  reviewers: z.array(UserPublicSchema),
})
export type ReviewNodeReviewerConfigNode = z.infer<typeof ReviewNodeReviewerConfigNodeSchema>

export const ReviewNodeReviewerConfigSchema = z.object({
  taskId: z.string().min(1),
  canManage: z.boolean(),
  nodes: z.array(ReviewNodeReviewerConfigNodeSchema),
})
export type ReviewNodeReviewerConfig = z.infer<typeof ReviewNodeReviewerConfigSchema>
