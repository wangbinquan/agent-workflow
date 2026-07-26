// RFC-229 — authoritative message-turn parent resolution. This locks human
// and agent mentions to the same contract, excludes self-mentions, and proves
// adopted clarify continuations cannot be rebound by messages arriving later.

import { describe, expect, test } from 'bun:test'
import { buildMsgShardKey, type WorkgroupMessage } from '@agent-workflow/shared'
import { resolveMessageTurnTriggerId } from '../src/services/workgroup/context'
import { resolveMessageTurnTrigger } from '../src/services/workgroup/memberTurns'

function message(
  id: string,
  authorMemberId: string | null,
  mentionMemberIds: string[],
): WorkgroupMessage {
  return {
    id,
    taskId: 'task-1',
    round: 1,
    authorKind: authorMemberId === null ? 'human' : 'member',
    authorMemberId,
    authorUserId: authorMemberId === null ? 'user-1' : null,
    kind: 'chat',
    bodyMd: id,
    mentionMemberIds,
    assignmentId: null,
    triggerMessageId: null,
    createdAt: 1,
  }
}

describe('RFC-229 resolveMessageTurnTriggerId', () => {
  const messages = [
    message('01', null, ['member-b']),
    message('02', 'member-a', ['member-b', 'member-c']),
    message('03', 'member-b', ['member-b']),
    message('04', 'member-a', ['member-b']),
  ]

  test('human→agent and agent→agent share the same newest-valid rule', () => {
    expect(resolveMessageTurnTriggerId('member-b', '01', messages)).toBe('01')
    expect(resolveMessageTurnTriggerId('member-b', '02', messages)).toBe('02')
  })

  test('one parent can trigger several agents', () => {
    expect(resolveMessageTurnTriggerId('member-b', '02', messages)).toBe('02')
    expect(resolveMessageTurnTriggerId('member-c', '02', messages)).toBe('02')
  })

  test('self-mention and messages beyond the frozen max never steal the parent', () => {
    expect(resolveMessageTurnTriggerId('member-b', '03', messages)).toBe('02')
    expect(resolveMessageTurnTriggerId('member-b', '04', messages)).toBe('04')
  })

  test('null, empty, zero and no match degrade to null', () => {
    expect(resolveMessageTurnTriggerId('member-b', null, messages)).toBeNull()
    expect(resolveMessageTurnTriggerId('member-b', '', messages)).toBeNull()
    expect(resolveMessageTurnTriggerId('member-b', '0', messages)).toBeNull()
    expect(resolveMessageTurnTriggerId('member-z', '04', messages)).toBeNull()
  })
})

describe('RFC-229 resolveMessageTurnTrigger fresh/adopted boundary', () => {
  const messages = [
    message('01', null, ['member-b']),
    message('02', 'member-a', ['member-b']),
    message('03', 'member-c', ['member-b']),
  ]

  test('fresh turn freezes the current max and resolves within it', () => {
    expect(resolveMessageTurnTrigger({ messages, hostRuns: [] }, 'member-b')).toEqual({
      maxMessageId: '03',
      triggerMessageId: '03',
    })
  })

  test('adopted turn keeps its persisted shard max despite a newer mention', () => {
    expect(
      resolveMessageTurnTrigger(
        {
          messages,
          hostRuns: [
            {
              id: 'run-adopted',
              shardKey: buildMsgShardKey('member-b', '02'),
            },
          ],
        },
        'member-b',
        'run-adopted',
      ),
    ).toEqual({
      maxMessageId: '02',
      triggerMessageId: '02',
    })
  })

  test('missing, malformed or wrong-member adopted shards fail closed', () => {
    expect(
      resolveMessageTurnTrigger(
        { messages, hostRuns: [{ id: 'run', shardKey: 'assignment-1' }] },
        'member-b',
        'run',
      ),
    ).toEqual({ maxMessageId: null, triggerMessageId: null })
    expect(
      resolveMessageTurnTrigger(
        {
          messages,
          hostRuns: [{ id: 'run', shardKey: buildMsgShardKey('member-c', '02') }],
        },
        'member-b',
        'run',
      ),
    ).toEqual({ maxMessageId: null, triggerMessageId: null })
  })
})
