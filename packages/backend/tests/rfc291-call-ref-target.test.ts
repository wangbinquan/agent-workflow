// RFC-291 面 D (T6a) —— call 选择器绑定到哪一行，只有一个实现说了算。
//
// 设计门 P2-b：初版把 helper 设计成接收「调用方已经挑好的 hinted / oldest」，
// 那等于把真正的裁决（名字相等、可见性、ULID 排序）留在调用侧——dumpBuilder 只要
// 按 Map 顺序取到同名的另一行，helper 单测全绿而两侧选出**不同的工作流**，于是
// 「启动时执行 W2、意图会话里改 W1」这类错位在结构上仍然可能。
//
// 修正后 helper 接收**完整的可见候选集**，自己完成全部裁决；调用方只负责可见性
// （它持有 ACL 上下文）。这组用例锁的就是那条裁决本身，外加两条来自 RFC-243
// 实现门 P0-1 的安全判据：
//   · id 缓存只在该行**仍带选择器名字**时才认（否则改名的行会被一直绑住）
//   · 候选集之外的行永远不会被选中（可见性由调用方过滤 ⇒ 不可见即不在集合里）

import { describe, expect, test } from 'bun:test'
import { pickCallTarget } from '../src/services/execution/callRefTarget'

/** ULID 按字典序即按铸造时间序——这里用可读的假 id 保持同一性质。 */
const older = { id: '01AAAA', name: 'build' }
const newer = { id: '01ZZZZ', name: 'build' }
const renamed = { id: '01MMMM', name: 'build-v2' }
const other = { id: '01NNNN', name: 'deploy' }

describe('pickCallTarget — 名字回落', () => {
  test('同名多行取最老 ULID（name 不唯一是合法状态：YAML 导入碰撞）', () => {
    expect(pickCallTarget({ authoritativeName: 'build' }, [newer, older])?.id).toBe(older.id)
    // 顺序无关：调用方换个顺序递候选集不能改变结果
    expect(pickCallTarget({ authoritativeName: 'build' }, [older, newer])?.id).toBe(older.id)
  })

  test('无同名行 → undefined（调用方负责转成 workflow-call-ref-missing）', () => {
    expect(pickCallTarget({ authoritativeName: 'nope' }, [older, other])).toBeUndefined()
    expect(pickCallTarget({ authoritativeName: 'build' }, [])).toBeUndefined()
  })
})

describe('pickCallTarget — id 缓存优先（RFC-243 实现门 P0-1）', () => {
  test('hint 命中且该行仍带该名字 → 用它，压过「最老」规则', () => {
    // 用户在下拉里选的就是较新的那个；缓存必须尊重这个选择
    expect(
      pickCallTarget({ authoritativeName: 'build', idHint: newer.id }, [older, newer])?.id,
    ).toBe(newer.id)
  })

  test('hint 指向的行已改名 → 缓存作废，回落到名字规则', () => {
    // 关键安全判据：没有这条，一个被改名的行会被 hint 永久绑住，
    // 而作者看到的选择器名字早已指向别的资源。
    const picked = pickCallTarget({ authoritativeName: 'build', idHint: renamed.id }, [
      renamed,
      older,
      newer,
    ])
    expect(picked?.id).toBe(older.id)
  })

  test('hint 指向的行不在候选集里（= 对该 actor 不可见）→ 回落，不泄漏', () => {
    // 可见性由调用方过滤：不可见的行压根不在 candidates 里，于是 hint 落空。
    // 少了这条，一个同名但不可见的行可能被冻结进任务快照并被执行。
    const picked = pickCallTarget({ authoritativeName: 'build', idHint: 'INVISIBLE' }, [
      older,
      newer,
    ])
    expect(picked?.id).toBe(older.id)
  })

  test('hint 命中但名字属于另一个选择器 → 不串台', () => {
    expect(
      pickCallTarget({ authoritativeName: 'build', idHint: other.id }, [other, older])?.id,
    ).toBe(older.id)
  })
})

describe('pickCallTarget — 单点性（AC-14 的结构面）', () => {
  test('相同输入必然同解：freeze 与 dump 两侧不可能选出不同的行', () => {
    // 两侧各自构造候选集（DB 查询 vs 内存 catalog），但只要集合等价，
    // 结果就必然一致——这正是把裁决收进一个函数换来的性质。
    const fromDbQuery = [older, newer, renamed] // freeze 侧：按 name/id 查回来的行
    const fromCatalog = [renamed, newer, older] // dump 侧：内存 Map 遍历顺序不同
    const selector = { authoritativeName: 'build', idHint: newer.id }
    expect(pickCallTarget(selector, fromDbQuery)?.id).toBe(
      pickCallTarget(selector, fromCatalog)?.id,
    )
  })
})
