// 执行闭包同名冲突判据的锁。
//
// 这条判据存在的理由是一次**实测**：`stageSkills` 按名字建目录
// （`join(skillsDir, skill.name)`），两个不同 owner 的同名技能注入后只剩一个目录、
// 一份内容 —— 另一份静默消失，无告警无日志。MCP 同形（`inject.ts` 的
// `if (Object.hasOwn(servers, m.name)) continue`，先到先得丢弃第二个）。
//
// 见 `docs/audit-backlog.md` 的「执行闭包内同名资源会静默冲突」条目：接线点已定位，
// 失败语义待产品决策，所以这里先只锁判据本身。

import { describe, expect, test } from 'bun:test'
import {
  describeClosureNameConflicts,
  findClosureNameConflicts,
} from '../src/services/closureNameConflict'

describe('闭包同名冲突判据', () => {
  test('不同 id 共享同一个名字 ⇒ 冲突（注入期会撞车的正是这种）', () => {
    const out = findClosureNameConflicts([
      { id: 'S_ALICE', name: 'lint' },
      { id: 'S_BOB', name: 'lint' },
      { id: 'S_OTHER', name: 'format' },
    ])
    expect(out).toEqual([{ name: 'lint', ids: ['S_ALICE', 'S_BOB'] }])
  })

  test('**同一个 id 经多条路径进入闭包 ⇒ 不是冲突**', () => {
    // 菱形依赖是正常的 DAG 汇聚：A 直接引用 S，又 dependsOn 一个也引用 S 的 B。
    // 不先按 id 去重的话，每个菱形都会被误报成冲突 —— 那会让这条判据无法上线。
    expect(
      findClosureNameConflicts([
        { id: 'S1', name: 'lint' },
        { id: 'S1', name: 'lint' },
        { id: 'S1', name: 'lint' },
      ]),
    ).toEqual([])
  })

  test('空闭包 / 全不同名 ⇒ 无冲突', () => {
    expect(findClosureNameConflicts([])).toEqual([])
    expect(
      findClosureNameConflicts([
        { id: 'a', name: 'x' },
        { id: 'b', name: 'y' },
      ]),
    ).toEqual([])
  })

  test('三方同名也完整列出，且顺序稳定（错误信息要可比对）', () => {
    const out = findClosureNameConflicts([
      { id: 'c', name: 'dup' },
      { id: 'a', name: 'dup' },
      { id: 'b', name: 'dup' },
      { id: 'z', name: 'aaa' },
      { id: 'y', name: 'aaa' },
    ])
    // 名字字典序；ids 也字典序 —— 同一份闭包每次报同样的顺序。
    expect(out).toEqual([
      { name: 'aaa', ids: ['y', 'z'] },
      { name: 'dup', ids: ['a', 'b', 'c'] },
    ])
  })

  test('摘要点名资源类型、名字与全部 id', () => {
    const msg = describeClosureNameConflicts('skill', [{ name: 'lint', ids: ['S_ALICE', 'S_BOB'] }])
    expect(msg).toContain('skill')
    expect(msg).toContain('lint')
    expect(msg).toContain('S_ALICE')
    expect(msg).toContain('S_BOB')
  })

  test('名字里的特殊字符不影响判定（`constructor` 是合法资源名）', () => {
    // `Object.hasOwn` 那条去重逻辑的注释专门提过：`constructor` 是合法资源名。
    // 这里用 Map，不受原型链影响 —— 锁住这一点。
    expect(
      findClosureNameConflicts([
        { id: '1', name: 'constructor' },
        { id: '2', name: 'constructor' },
      ]),
    ).toEqual([{ name: 'constructor', ids: ['1', '2'] }])
  })
})
