// RFC-287 T1⑧ —— 「许可释放先于 iso 清理」的**跨文件结构锁**（接手 rfc208 oracle #1）。
//
// 为什么要新写一条：rfc208 的两条 oracle 都钉在 `scheduler.ts` 的**函数体形状**上
//   · oracle #1 按 `POOL_RELEASE_NAMES` 这些具名释放调用匹配；
//   · oracle #2 是逐字符走 try 嵌套深度的扫描器，从「抢到许可」起、「离开该函数」止。
// RFC-287 把抢/放许可收进 `runAssembly` 之后，两条在 scheduler.ts 里都会**找不到
// 区域可扫**而结构性失效——而它们锁的是 RFC-208 的真事故（在写锁内交接锚点会让
// 落地的提交在一次回收后变成坏对象；释放序颠倒则漏 permit）。所以不能靠改锚了事。
//
// 本锁只钉一条**与文件无关**的结构不变量：**任何 finally 块里，如果既释放许可又
// 清理 iso，释放必须写在清理之前。** 它对「代码搬到哪个文件」免疫——迁移时把新
// 文件加进 FILES 即可，不需要重写断言，也没有「把阈值改小就绿了」的逃生门。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src', 'services')

/** 迁移时把 `schedulerAssembly.ts` 加进来即可（design §10.5 定的落位）。 */
// RFC-287 T3：聚合线迁入后，骨架文件同样纳入扫描（这条锁本就设计成对
// 「代码搬到哪个文件」免疫）。
const FILES = ['scheduler.ts', 'schedulerAssembly.ts'] as const

/** 三个池的释放句柄名（与 rfc208 oracle #1 的 POOL_RELEASE_NAMES 同源）。 */
const RELEASE_NAMES = ['releaseGlobal', 'releaseScript', 'releaseSub', 'releaseHost'] as const

/** 取出所有 `finally { … }` 的块体（大括号配平）。 */
function finallyBlocks(src: string): string[] {
  const out: string[] = []
  const re = /\bfinally\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
    }
    out.push(src.slice(m.index + m[0].length, i - 1))
  }
  return out
}

describe('RFC-287 T1⑧ — 许可释放先于 iso 清理（跨文件结构锁）', () => {
  test('每个同时做两件事的 finally 块里，释放都排在清理之前', () => {
    const offenders: string[] = []
    let checked = 0
    for (const file of FILES) {
      const src = readFileSync(resolve(SRC, file), 'utf8')
      for (const block of finallyBlocks(src)) {
        const discardAt = block.indexOf('discardNodeIso(')
        if (discardAt === -1) continue
        const releaseAt = RELEASE_NAMES.map((n) => block.indexOf(`${n}(`))
          .filter((i) => i !== -1)
          .sort((a, b) => a - b)[0]
        if (releaseAt === undefined) continue // 该 finally 不持有池许可
        checked++
        if (releaseAt > discardAt) {
          offenders.push(`${file}: ${block.trim().slice(0, 80)}`)
        }
      }
    }
    // 防空扫：现状五条装配线各有一个这样的 finally。
    expect(checked).toBeGreaterThanOrEqual(4)
    expect(offenders).toEqual([])
  })
})
