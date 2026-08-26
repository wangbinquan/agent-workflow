// RFC-330 D19/D20 —— `employee-case.members.changed` 帧在 /ws/tasks 频道上的投递门。
//
// 案例没有 per-row 可见性缓存：帧只按变更事务冻结的 before ∪ after 受众投递
// （或 tasks:read:all）；没有受众快照、快照指向别的案例 ⇒ 丢帧。与 rfc152 的
// task.members.changed 用例同形（proposal AC-10）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { WS_CHANNELS } from '../src/ws/registry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeActor(role: 'admin' | 'user', id: string): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

describe('RFC-330 —— employee-case.members.changed 帧门', () => {
  const db = createInMemoryDb(MIGRATIONS)
  const gate = WS_CHANNELS['tasks-list'].frameGate!
  const caseId = 'case-audience'
  const visibleUserIds = new Set(['previous-owner', 'next-owner', 'removed-member', 'added-member'])
  const context = {
    kind: 'employee-case.members-changed-audience' as const,
    caseId,
    visibleUserIds,
  }
  const message = { type: 'employee-case.members.changed' as const, caseId }

  test('before ∪ after 受众收到帧；局外人收不到；tasks:read:all 恒收到', async () => {
    for (const userId of visibleUserIds) {
      expect(
        await gate({ db, actor: makeActor('user', userId), cache: new Map() }, message, context),
      ).toBe(true)
    }
    expect(
      await gate({ db, actor: makeActor('user', 'outsider'), cache: new Map() }, message, context),
    ).toBe(false)
    expect(
      await gate({ db, actor: makeActor('admin', 'root'), cache: new Map() }, message, context),
    ).toBe(true)
  })

  test('没有受众快照、或快照指向别的案例 ⇒ 丢帧（不会退回任务可见性判定）', async () => {
    expect(
      await gate(
        { db, actor: makeActor('user', 'next-owner'), cache: new Map() },
        message,
        undefined,
      ),
    ).toBe(false)
    expect(
      await gate({ db, actor: makeActor('user', 'next-owner'), cache: new Map() }, message, {
        ...context,
        caseId: 'another-case',
      }),
    ).toBe(false)
    // 任务帧的受众上下文不能冒充案例帧的受众。
    expect(
      await gate({ db, actor: makeActor('user', 'next-owner'), cache: new Map() }, message, {
        kind: 'task.members-changed-audience',
        taskId: caseId,
        visibleUserIds,
      }),
    ).toBe(false)
  })
})
