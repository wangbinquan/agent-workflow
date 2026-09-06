// 调度架构审视 2026-07-14 — 重试预算单源锁。
//
// 「模型格式滑」的重试预算 `3` 曾在四处各写一份、仅靠注释对齐（scheduler
// `defaultNodeRetries ?? 3` / workgroup `WG_PROTOCOL_RETRIES = 3` / dw
// `DW_MAX_GENERATE_ATTEMPTS = 3` / free_collab 重开 `priorRuns < 3`）。
// 现收敛到 shared 的 DEFAULT_PROTOCOL_RETRY_BUDGET；本文件锁两件事：
//   1. 常量本身的值（改预算是产品决策，必须显式过这条锁）；
//   2. 四个消费点引用常量而非回退成字面量（精确字符串禁令，表级不扩散）。
// 各点位语义仍按站点注释（retries-after-first vs total attempts）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'

const SRC = (rel: string): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')

describe('DEFAULT_PROTOCOL_RETRY_BUDGET 单源', () => {
  test('预算值 = 3（改动它是显式产品决策）', () => {
    expect(DEFAULT_PROTOCOL_RETRY_BUDGET).toBe(3)
  })

  test('task-execution mechanics：defaultNodeRetries 兜底走共享常量', () => {
    const sources = [
      SRC('modules/task-execution/composition/nodeMechanics.ts'),
      SRC('modules/task-execution/composition/wrapperMechanics.ts'),
    ]
    expect(
      sources.reduce(
        (count, source) =>
          count +
          source.split('opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET').length -
          1,
        0,
      ),
    ).toBe(4)
    for (const source of sources) expect(source).not.toContain('defaultNodeRetries ?? 3')
  })

  test('workgroup 回合驱动：协议重试 + fc 重开预算走共享常量', () => {
    // RFC-359 W4-D19c：两个 provider 合到同一条中立驱动，两个锚点都在它里面
    // （合一前分居 legacy 的 turnExecution.ts 与 lifecycle.ts）。
    const driver = SRC('modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts')
    // 协议重试预算：每回合的上限允许被 spec 覆盖（消息回合是单发），兜底走共享常量。
    expect(driver).toContain('spec.maxProtocolRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET')
    expect(driver).not.toContain('maxProtocolRetries ?? 3')
    // RFC-215：fc 重开预算从「按 shardKey 数 node_runs 行（priorRuns）」改为
    // workgroup_assignments.attempt_count 列（批量 shardKey 下行计数失效），
    // 判据仍必须走共享常量。
    expect(driver).toContain('attempts < DEFAULT_PROTOCOL_RETRY_BUDGET')
    expect(driver).not.toContain('attempts < 3')
    // 「换进程重跑」是**另一份**预算，也走同一个常量（合一前 SQLite 同形）。
    expect(driver).toContain('transientRetriesUsed < DEFAULT_PROTOCOL_RETRY_BUDGET')
  })

  test('dynamicWorkflowRunner：生成尝试上限走共享常量', () => {
    const s = SRC('services/dynamicWorkflowRunner.ts')
    expect(s).toContain('const DW_MAX_GENERATE_ATTEMPTS = DEFAULT_PROTOCOL_RETRY_BUDGET')
    expect(s).not.toContain('DW_MAX_GENERATE_ATTEMPTS = 3')
  })
})
