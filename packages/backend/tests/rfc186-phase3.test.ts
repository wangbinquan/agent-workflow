// RFC-186 Phase 3 — batch of P2/P3 correctness fixes from the workgroup audit
// (design/workgroup-e2e-audit.md §3). Small, mechanical hardening on the engine;
// these locks pin the fixes so a future refactor can't silently drop them.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { messageDraft } from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'

// RFC-359 W4-D19c-tail：legacy 工作组引擎岛已退役，这些规则合到了两个 provider 共用的中立
// 回合驱动里；串起来的锁面随之改锚它。
const DRIVER_PATH = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'application',
  'workgroups',
  'workgroupTurnsDriver.ts',
)
const SRC = readFileSync(DRIVER_PATH, 'utf8')

describe('RFC-186 Phase 3 — engine hardening locks', () => {
  // §3-6: `done` co-emitted with new assignments is a protocol violation (the
  // dispatched work would run but never be aggregated).
  test('§3-6: leader `done` + new assignments is rejected as a protocol violation', () => {
    expect(SRC).toContain('wg_decision done cannot be combined with wg_assignments')
    // gated on decision=done AND dispatches non-empty.
    expect(SRC).toMatch(
      /decision\.value\.action === 'done'[\s\S]{0,120}assignments\.value\.length > 0/,
    )
  })

  // §3-4: message ids must be monotonic (room slicing / cursor advance assume
  // lexical ordering; plain ulid() reorders same-ms posts).
  //
  // RFC-359 W4-D19c-tail：合一时这条**丢了**——中立驱动的 `messageDraft` 用的是普通 `ulid()`。
  // 后果是用户可见的：成员游标推进后按 `message.id > cursor` 取「我没看过的」，同毫秒发出的两条
  // 消息之间没有稳定序，游标若先落在字典序较大的那条上，另一条对该成员**永远不再出现**。
  // 这正是 §3-4 当初引入 monotonicFactory 要消除的窗口，两个 provider 现在都中。已补回。
  test('§3-4: 房间消息 id 用单调 ULID 工厂，不是普通 ulid()', () => {
    expect(SRC).toContain('const nextMessageId = monotonicFactory()')
    expect(SRC).toContain('id: nextMessageId()')
  })

  test('§3-4: 同毫秒连发的消息 id 严格递增（游标比较是字典序）', () => {
    const ids = Array.from({ length: 64 }, (_, i) =>
      messageDraft({
        round: 1,
        authorKind: 'member',
        authorMemberId: 'm-1',
        kind: 'chat',
        bodyMd: `body ${i}`,
      }),
    ).map((draft) => draft.id)
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  // §3-5 / F5: an adopted assignment run must pass its TRUE status so a still-
  // `dispatched` row gets its dispatched→running CAS (else the closing running→
  // done CAS misses and the assignment re-runs).
  test('§3-5: 采纳既有 run 时按卡片的**真实**状态做 CAS（不是硬写 running）', () => {
    // RFC-359 W4-D19c-tail：合一后这条住在 `assignmentStartOperations` 里——`from` 取卡片当下的
    // 状态（dispatched / awaiting_human 都可能），而不是假定它已经是 running；否则收尾那次
    // running→done 的 CAS 会落空，卡片被重跑一遍。
    expect(SRC).toMatch(
      /assignment\.status === 'dispatched' \|\| assignment\.status === 'awaiting_human'/,
    )
    expect(SRC).toMatch(/from: assignment\.status,\s*\n\s*to: 'running',/)
    // 硬写 running 的旧形态必须不在。
    expect(SRC).not.toContain("from: 'running' as const,\n        to: 'running'")
  })

  // TRAP-2: the roster renders `- @writer`, so the wg_assignments `member` doc
  // must NOT contradict it with "not @writer" (the @ is tolerated by
  // WgMemberRefSchema). Reconcile the copy so a weak model isn't confused.
  test('TRAP-2: protocol no longer contradicts the roster on the @ prefix', () => {
    const ctx = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'application',
        'workgroups',
        'workgroupTurnContext.ts',
      ),
      'utf8',
    )
    // RFC-359 T7e：协议块渲染器迁到 application/workgroups/workgroupProtocol.ts（两 provider 共用）；
    // roster 渲染仍在 legacy context.ts。
    const protocol = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'application',
        'workgroups',
        'workgroupProtocol.ts',
      ),
      'utf8',
    )
    expect(protocol).toContain('the leading @ shown in the')
    expect(protocol).not.toContain('not "@writer"')
    expect(ctx).not.toContain('not "@writer"')
    // the roster itself still uses the @ display form (unchanged).
    expect(ctx).toContain('const head = `- @${m.displayName}')
  })
})
