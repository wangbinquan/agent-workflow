import { describe, expect, test } from 'bun:test'
import {
  ReplaceReviewNodeReviewersBodySchema,
  ReviewAuthorRoleSchema,
  ReviewCapabilitiesSchema,
  ReviewNodeReviewerConfigSchema,
  TaskCollaboratorRoleSchema,
} from '../src/index'

describe('RFC-340 review-node reviewer contracts', () => {
  test('accepts full-replace node sets, including clear-all', () => {
    expect(ReplaceReviewNodeReviewersBodySchema.parse({ nodes: [] })).toEqual({ nodes: [] })
    expect(
      ReplaceReviewNodeReviewersBodySchema.parse({
        nodes: [
          { reviewNodeId: 'review-a', reviewerUserIds: ['alice', 'bob'] },
          { reviewNodeId: 'review-b', reviewerUserIds: [] },
        ],
      }),
    ).toBeDefined()
  })

  test('keeps reviewer out of task collaboration while accepting review attribution', () => {
    expect(ReviewAuthorRoleSchema.parse('reviewer')).toBe('reviewer')
    expect(TaskCollaboratorRoleSchema.safeParse('reviewer').success).toBe(false)
  })

  test('requires the explicit opinion-only capability projection', () => {
    expect(
      ReviewCapabilitiesSchema.parse({
        scope: 'review-node',
        canAddComment: true,
        canEditOwnComments: true,
        canDeleteOwnComments: false,
        canManageAnyComments: false,
        canSelectDocuments: false,
        canDecide: false,
      }),
    ).toEqual({
      scope: 'review-node',
      canAddComment: true,
      canEditOwnComments: true,
      canDeleteOwnComments: false,
      canManageAnyComments: false,
      canSelectDocuments: false,
      canDecide: false,
    })
  })

  test('round-trips disabled historical assignees in config reads', () => {
    expect(
      ReviewNodeReviewerConfigSchema.parse({
        taskId: 'task-1',
        canManage: true,
        nodes: [
          {
            reviewNodeId: 'review-a',
            title: 'Review A',
            description: '',
            reviewers: [
              {
                id: 'alice',
                username: 'alice',
                displayName: 'Alice',
                role: 'user',
                status: 'disabled',
              },
            ],
          },
        ],
      }),
    ).toBeDefined()
  })
})
