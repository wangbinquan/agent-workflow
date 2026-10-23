// RFC-359 —— 资源包 apply **引擎合一之后**，落盘半成品工件的跨格式回落。
//
// # 这条测试为什么存在
//
// 合一之前两个 provider 各写一种半成品工件格式（逐条 `opId` vs `operationId`，字段名也不同），
// 两个读回侧**互不认识**——那张 12 格矩阵就在
// `tests/architecture/rfc359-w5-artifact-format-portability.test.ts` 里逐格钉着。
// 生产侧统一到一台 apply 引擎之后，写出的是统一那一种；但一台在合一**之前**起过的 SQLite
// daemon，盘上可能留着旧格式的半成品。读回侧只认新格式的话，那些 journal 行会永久卡住、
// 半成品目录永远收不掉——这正是那张矩阵在防的事，所以合一的同一笔必须把回落一起做掉。
//
// 回落判据是 `ZodError`：两个读回侧都在**任何副作用之前**整体解码
// （`parseArtifacts` / `parseReceipt` 是两个入口的第一件事），所以「格式不认识」时一个字节都没动过，
// 换一个读回侧重试是安全的。**其它错误必须原样抛出**——路径越界、缺文件、DB 失败要是被当成
// 「换一个读回侧再试」，第二次会在同一个坏状态上再动一次手。下面①②③正是这三条。
//
// 先红后绿：把 `composeResourcePackageApplyArtifactRecoveryChain` 里的
// `if (!(error instanceof ZodError)) throw error` 去掉，③ 当场红（legacy 被调了一次）；
// 把整个 `catch` 去掉，② 当场红（旧格式工件的 journal 行卡住）。

// 2026-10-22 RFC-395 II-a A6：格式在 effect 前选择；effect 的 ZodError 不再触发另一套恢复。
import { describe, expect, test } from 'bun:test'
import { z, type ZodError } from 'zod'

import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../src/modules/resource-catalog/application/resourcePackageMaintenance'
import { createVersionedResourcePackageArtifactRecovery } from '../src/modules/resource-catalog/infrastructure/resourcePackageArtifactRecovery'

const JOURNAL: ResourcePackageApplyJournalSnapshot = Object.freeze({
  id: 'journal-1',
  state: 'committed',
  preparedArtifactsJson: '[]',
  receiptJson: JSON.stringify({ journalId: 'journal-1', applied: [] }),
  updatedAt: 1,
})

const LEGACY_JOURNAL = {
  ...JOURNAL,
  preparedArtifactsJson: JSON.stringify([
    { kind: 'skill-stage', skillId: 's', opId: 'old', skillDir: '/skills/s' },
  ]),
}

/** 解码失败长什么样：用真的 zod 报错，不是自造的 `new Error('ZodError')`。 */
function decodeFailure(): ZodError {
  const parsed = z.object({ operationId: z.string() }).safeParse({ opId: 'op-1' })
  if (parsed.success) throw new Error('fixture must fail to parse')
  return parsed.error
}

function recording(behaviour: {
  rollForward?: () => Promise<void>
  compensate?: () => Promise<void>
}): ResourcePackageApplyArtifactRecoveryPort & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async rollForward() {
      calls.push('rollForward')
      await behaviour.rollForward?.()
    },
    async compensate() {
      calls.push('compensate')
      await behaviour.compensate?.()
    },
  }
}

describe('RFC-395 A6 versioned legacy recovery', () => {
  test('① 统一格式读得动 ⇒ legacy 读回侧一次都不跑', async () => {
    const primary = recording({})
    const legacy = recording({})
    const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

    await chain.rollForward(JOURNAL)
    await chain.compensate(JOURNAL)

    expect(primary.calls).toEqual(['rollForward', 'compensate'])
    expect(legacy.calls).toEqual([])
  })

  test('② 旧格式在 effect 之前分派给 legacy，两个入口一致', async () => {
    const primary = recording({
      rollForward: () => Promise.reject(decodeFailure()),
      compensate: () => Promise.reject(decodeFailure()),
    })
    const legacy = recording({})
    const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

    await chain.rollForward(LEGACY_JOURNAL)
    await chain.compensate(LEGACY_JOURNAL)

    expect(primary.calls).toEqual([])
    expect(legacy.calls).toEqual(['rollForward', 'compensate'])
  })

  test.each([new Error('effect-failed'), decodeFailure()])(
    '③ effect 错误（含 ZodError）原样抛出，不换读回侧',
    async (boom) => {
      const primary = recording({
        rollForward: () => Promise.reject(boom),
        compensate: () => Promise.reject(boom),
      })
      const legacy = recording({})
      const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

      await expect(chain.rollForward(JOURNAL)).rejects.toThrow(boom.message)
      await expect(chain.compensate(JOURNAL)).rejects.toThrow(boom.message)

      expect(legacy.calls).toEqual([])
    },
  )

  test('④ legacy 读回侧自己失败时，报的是 legacy 那条错（不被解码错覆盖）', async () => {
    const primary = recording({ rollForward: () => Promise.reject(decodeFailure()) })
    const legacy = recording({
      rollForward: () => Promise.reject(new Error('legacy-recovery-failed')),
    })
    const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

    await expect(chain.rollForward(LEGACY_JOURNAL)).rejects.toThrow('legacy-recovery-failed')
  })
})
