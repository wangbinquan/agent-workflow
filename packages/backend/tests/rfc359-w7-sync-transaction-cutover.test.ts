// RFC-359 —— I14「record-before-act」在**生产 prestage 链**上的源码层兜底。
//
// # 这个文件原本是什么，为什么只剩这一条
//
// 它原本锁的是**通用 bundle 引擎**（`services/bundle/apply.ts`）那四笔 journal 事务从
// bun:sqlite 独有的同步 `dbTxSync` 切到中立事务原语之后的行为：①认领事务同生共死、
// ②record-before-act、③pre-commit 失败终态化、④收敛 CAS。
//
// 资源包 apply 两台引擎合一（plan §5dv/§5dy）之后那台引擎已经退役，①③④ 在统一引擎上各有落点：
//
//   · ① 认领 / 提交事务的原子性 → `rfc359-w11-atomic-apply-neutral-transaction-conformance`
//     （中途失败后的残留，两个引擎都问）；三态重放 → `rfc359-w14-unified-apply-journal-replay`；
//   · ③ pre-commit 失败 ⇒ 零可见 + journal `failed` 且带原因 → 同上 ⑤；
//   · ④ 收敛 CAS（10 分钟下限 / active 跳过 / committed 只前滚）→
//     `rfc349-resource-package-maintenance`，判据挂在中立的 converge 命令上。
//
// **② 没有行为落点，只能用源码断言兜底**，所以它留在这里、并改指生产在用的那份适配器。
//
// # 为什么需要一条源码层断言（`docs/dev-gotchas.md` 允许的最低限度形态）
//
// `recordArtifact` 是异步的中立事务写。生产链上漏掉一个 `await`**不会让任何既有测试变红**
// ——2026-09-07 实测：把三处 `await context.recordArtifact(...)` 改成
// `void context.recordArtifact(...)`，当时的 bundle-engine / recovery-hardening /
// apply-replay-recovery-parity 全绿。原因是那些断言都在 apply **返回之后**才读 journal，
// 那时 fire-and-forget 的写早就落库了；真正被打破的是「副作用之前 journal 已落库」这一条
// **时序**不变量，而它只在崩溃 / SIGKILL 的窗口里可见。
//
// `bun run lint:promises`（no-floating-promises）挡得住**裸**调用，但挡不住显式 `void`。
// 这条断言补上那个缺口。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 生产在用的 prestage 链。合一前它是 `legacyResourcePackageMutationParticipants.ts`
 * （SQLite 专属），现在两个 provider 装的都是这一份。
 */
const PRESTAGE_ADAPTER = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'aggregateAdapters',
  'postgresqlResourcePackageMutationParticipants.ts',
)

describe('I14 record-before-act —— 生产 prestage 链的每一处 recordArtifact 都必须 await', () => {
  test('生产参与者里没有未 await 的 recordArtifact', () => {
    const source = readFileSync(PRESTAGE_ADAPTER, 'utf8')
    const calls = [...source.matchAll(/(\S*\s*)[A-Za-z.]*journal\.recordArtifact\(/g)]
    expect(
      calls.length,
      '语料失效：适配器里一处 recordArtifact 调用都没扫到',
    ).toBeGreaterThanOrEqual(3)
    for (const call of calls) {
      expect(
        call[1],
        `recordArtifact 必须写成 \`await …journal.recordArtifact(...)\`；` +
          `丢掉 await（含显式 \`void\`）会让副作用跑在 journal 落库之前，而既有测试不会红`,
      ).toBe('await ')
    }
  })
})
