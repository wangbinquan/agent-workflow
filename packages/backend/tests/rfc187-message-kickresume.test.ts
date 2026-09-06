// RFC-187 F2 (audit design/workgroup-e2e-audit.md §5 F2) — sending a room message (or a
// delivery / config-patch) to a LIVE `interrupted` workgroup task inserted a dispatched
// assignment but only kicked the engine when the task was `awaiting_human` — so an
// interrupted task (reaped mid-run by orphan-reaping WITHOUT a daemon restart) became a
// black hole: the work sat undriven until the next restart. Fix: kick on any resumable
// state (awaiting_human OR interrupted); resumeTask handles both (RFC-186 P0-B) and no-ops
// on running/terminal states.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isWorkgroupKickResumable } from '../src/routes/workgroupTasks'

describe('RFC-187 F2 — isWorkgroupKickResumable', () => {
  test('awaiting_human and interrupted are resumable (message/delivery/patch re-drive)', () => {
    expect(isWorkgroupKickResumable('awaiting_human')).toBe(true)
    expect(isWorkgroupKickResumable('interrupted')).toBe(true)
  })

  test('running and terminal states are NOT kicked (no double-drive / no revive of a dead task)', () => {
    for (const s of ['running', 'pending', 'done', 'failed', 'canceled', 'awaiting_review']) {
      expect(isWorkgroupKickResumable(s)).toBe(false)
    }
    expect(isWorkgroupKickResumable(undefined)).toBe(false)
  })
})

describe('RFC-187 F2 — source lock (all gated kick sites use the resumable gate)', () => {
  // RFC-217 T4 把写端点（连同它们的 kick 点）从 routes/workgroupTasks.ts 挪进了 Resource Catalog；
  // RFC-359 W4-D19b 又把两个 provider 的房间合成一份中立实现，kick 点随之落在它的命令面里。
  const SRC = ['routes/workgroupTasks.ts']
    .concat([
      'modules/resource-catalog/infrastructure/workgroupTaskRoom.ts',
      'modules/resource-catalog/infrastructure/workgroupTaskRoomCommands.ts',
    ])
    .map((p) => readFileSync(resolve(import.meta.dir, '..', 'src', ...p.split('/')), 'utf8'))
    .join('\n')

  test('the message/delivery/patch sites gate on the resumable predicate, not awaiting_human alone', () => {
    // 旧的「只认 awaiting_human」判据必须已经消失。
    expect(SRC).not.toMatch(/status === 'awaiting_human'\)\s*(kickResume|continueTask)/)
    // 判据本身与 `isWorkgroupKickResumable` 同形：两个可恢复态，其余一律不驱动。
    expect(SRC).toContain("status === 'awaiting_human' || status === 'interrupted'")
    // 三条房间路径（发言 / 交付 / 改配置）都走同一个判据。
    const uses = SRC.split('isResumable(loaded.task.status)').length - 1
    expect(uses).toBeGreaterThanOrEqual(3)
  })
})
