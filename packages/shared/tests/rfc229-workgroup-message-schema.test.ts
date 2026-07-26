// RFC-229 — message reply provenance is additive and legacy-safe.

import { describe, expect, test } from 'bun:test'
import { WorkgroupMessageSchema } from '../src/schemas/workgroupRuntime'

const base = {
  id: 'message-child',
  taskId: 'task-1',
  round: 1,
  authorKind: 'member' as const,
  authorMemberId: 'member-b',
  authorUserId: null,
  kind: 'chat' as const,
  bodyMd: 'reply',
  mentionMemberIds: [],
  assignmentId: null,
  createdAt: 1,
}

describe('RFC-229 WorkgroupMessageSchema triggerMessageId', () => {
  test('legacy payload omission and explicit null both normalize to null', () => {
    expect(WorkgroupMessageSchema.parse(base).triggerMessageId).toBeNull()
    expect(
      WorkgroupMessageSchema.parse({ ...base, triggerMessageId: null }).triggerMessageId,
    ).toBeNull()
  })

  test('preserves an explicit direct-parent id', () => {
    expect(
      WorkgroupMessageSchema.parse({
        ...base,
        triggerMessageId: 'message-parent',
      }).triggerMessageId,
    ).toBe('message-parent')
  })
})
