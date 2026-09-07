// RFC-187 §3-3 (audit design/workgroup-e2e-audit.md §3-3; Codex P1-8) — a workgroup
// host turn that fumbles the envelope/wg-json retries in-place (WG_PROTOCOL_RETRIES,
// raised 1→3 by RFC-186), and EACH attempt mints a fresh __wg_leader__/__wg_member__
// run. `countBudgetUsed` counted them all, so one logical round could burn up to 4 of
// max_rounds. Fix: tag attempt>0 rows `wg-protocol-retry` and exclude that cause from
// the round count (both the lw leader branch AND the fc member branch).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RERUN_CAUSES } from '@agent-workflow/shared'
import { isClarifyRerunCause } from '../src/services/nodeRunMint'

describe('RFC-187 §3-3 — wg-protocol-retry cause', () => {
  test('the cause exists and is NOT a clarify rerun (safe enum default)', () => {
    expect(RERUN_CAUSES).toContain('wg-protocol-retry')
    expect(isClarifyRerunCause('wg-protocol-retry')).toBe(false)
  })
})

describe('RFC-187 §3-3 — source locks', () => {
  // RFC-359 W4-D19c-tail：legacy 工作组引擎岛已退役，四个 driver 与骨架合成了一份中立回合驱动。
  // 「协议重跑铸 wg-protocol-retry」这条判据随之从「每个角色各写一遍」收成骨架里的**唯一**一处，
  // 角色只提供各自的主 cause；本锁按新形状分成「唯一决策点」与「四个主 cause 都在」两半。
  const RUNNER = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'resource-catalog',
      'application',
      'workgroups',
      'workgroupTurnsDriver.ts',
    ),
    'utf8',
  )
  // RFC-345 —— provider-neutral 回合账本推导本体。SQLite/PG room adapters
  // 共用 application owner；legacy rounds.ts 只保留 DB read/write mechanics。
  const ROUNDS = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'resource-catalog',
      'application',
      'workgroups',
      'workgroupRoomProjection.ts',
    ),
    'utf8',
  )

  test('重跑一律铸 wg-protocol-retry：骨架里唯一一处决策，角色只给主 cause', () => {
    // 首轮用角色的主 cause，其余（协议重跑与「换进程」的传输重跑）一律 wg-protocol-retry。
    expect(RUNNER).toContain('const isFirstStart = attempt === 0 && !transientRetryPending')
    expect(RUNNER).toMatch(/cause: isFirstStart \? spec\.primaryCause : 'wg-protocol-retry'/)
    // 决策点只有这一个——回潮出第二处就意味着有人绕开骨架自己铸行。
    expect(RUNNER.split('cause: isFirstStart').length - 1).toBe(1)
    // 领队 / 派单（单卡 + 批量）/ 消息回合四处主 cause 都还在。
    expect(RUNNER).toContain("primaryCause: 'wg-leader-round'")
    expect(RUNNER.split("primaryCause: 'wg-assignment'").length - 1).toBe(2)
    expect(RUNNER).toContain("primaryCause: 'wg-message-turn'")
  })

  test('countBudgetUsed excludes wg-protocol-retry in BOTH modes', () => {
    // there must be a rerunCause !== 'wg-protocol-retry' guard for both the lw (leader)
    // and fc (member) counting branches.
    //
    // RFC-345 —— 推导本体搬到 provider-neutral application owner；引擎、
    // SQLite/PG room projection 仍共用一个 exact grammar。
    const occurrences = ROUNDS.split("row.rerunCause !== 'wg-protocol-retry'").length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })
})
