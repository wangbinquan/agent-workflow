// RFC-229 — authoritative message-turn parent resolution. This locks human
// and agent mentions to the same contract, excludes self-mentions, and proves
// adopted clarify continuations cannot be rebound by messages arriving later.

import { describe, expect, test } from 'bun:test'
import { buildMsgShardKey, parseMsgShardKey, type WorkgroupMessage } from '@agent-workflow/shared'
import { resolveMessageTurnTriggerId } from '../src/modules/resource-catalog/application/workgroups/workgroupTurnContext'
// RFC-359 W4-D19c-tail：边界判据改指生产那份。
import { messageTurnBoundary } from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'

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
    expect(messageTurnBoundary({ messages } as never, 'member-b', undefined)).toEqual({
      maxId: '03',
      triggerId: '03',
    })
  })

  test('adopted turn keeps its persisted shard max despite a newer mention', () => {
    expect(
      messageTurnBoundary({ messages } as never, 'member-b', {
        id: 'run-adopted',
        shardKey: buildMsgShardKey('member-b', '02'),
      } as never),
    ).toEqual({ maxId: '02', triggerId: '02' })
  })

  // RFC-359 W4-D19c-tail：合一前这条锁的是「分片键畸形 / 属于别的成员 ⇒ 失败关闭（返回 null）」。
  // 中立驱动里这个入参组合**结构上不可达**——采纳分支把 `memberId` 从同一个分片键里解出来
  // （`parseMsgShardKey(run.shardKey).memberId`），解不出来的 run 根本不会走到消息回合。
  // 所以这条改成锁那个结构性前提：解不出消息分片键的 run 不被当作消息回合采纳。
  test('a run whose shard key is not a message shard is never adopted as a message turn', () => {
    expect(parseMsgShardKey('assignment-1')).toBeNull()
    // 属于别的成员的分片键能解出来，但解出的正是**那个成员**——不会拿去驱动 member-b。
    expect(parseMsgShardKey(buildMsgShardKey('member-c', '02'))?.memberId).toBe('member-c')
  })
})
