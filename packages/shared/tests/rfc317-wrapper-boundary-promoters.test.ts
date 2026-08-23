// RFC-317 T58 · findings NK-02 —— 边界提升表的穷尽性与「未知 wrapper 不得借身份」。
//
// 改造前 `promotedSourceForWrapper` 是一条 if-chain 加**隐式默认**（末尾裸 return null），
// 而它所在的模块自称「唯一的结构预言」。加第四种 wrapper kind 会静默落进那个默认，
// 表现为「这个 wrapper 的所有内层端口都过不了边界」——不是任何一处编译错误。
//
// 另一半：两处失败返回把 `'wrapper-git'` 当占位符用
// （`wrapper?.kind ?? 'wrapper-git'` 与直接写死），而该字段**原样**渲染进用户可见诊断
// （workflow.validator.ts ×3、scheduler.ts ×1）。于是一条「这个父节点根本不是 wrapper」
// 的错误，会告诉用户问题出在一个 git wrapper 上。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WRAPPER_NODE_KINDS } from '../src/schemas/workflow'
import { describeWrapperKind } from '../src/workflowScope'

const SCOPE_SRC = resolve(import.meta.dir, '..', 'src', 'workflowScope.ts')

describe('RFC-317 T58 —— 提升表对 WrapperKind 穷尽', () => {
  test('每个 wrapper kind 在表里都有一条**显式**条目', () => {
    // 源码层断言：`satisfies Record<...>` 保证的是编译期，运行期看不见。这里核对
    // 三个 kind 各自以键名出现在表里——包括 `wrapper-git` 那条显式的 `() => null`。
    // 它此前是「掉进默认分支」，与「设计上就不暴露内层端口」在代码里长得一模一样。
    const src = readFileSync(SCOPE_SRC, 'utf8')
    const table = src.slice(
      src.indexOf('const WRAPPER_BOUNDARY_PROMOTERS'),
      src.indexOf('} as const satisfies Record<'),
    )
    expect(table.length).toBeGreaterThan(200)
    for (const kind of WRAPPER_NODE_KINDS) {
      expect(table.includes(`'${kind}'`), `提升表缺少 ${kind} 的显式条目`).toBe(true)
    }
  })

  test('表用 `satisfies Record<WrapperKind, …>` 约束（漏一个 kind 是编译错误）', () => {
    const src = readFileSync(SCOPE_SRC, 'utf8')
    expect(src).toContain('} as const satisfies Record<(typeof WRAPPER_NODE_KINDS)[number]')
  })
})

describe('RFC-317 T58 —— 未知 wrapper 不再借用 git 的身份', () => {
  test('`describeWrapperKind(null)` 说通名，不说 wrapper-git', () => {
    expect(describeWrapperKind(null)).toBe('wrapper')
    expect(describeWrapperKind(null)).not.toBe('wrapper-git')
  })

  test('已知 kind 原样返回（渲染器不改写真实身份）', () => {
    for (const kind of WRAPPER_NODE_KINDS) {
      expect(describeWrapperKind(kind)).toBe(kind)
    }
  })

  test('源码层：两处失败返回不再写死 wrapper-git', () => {
    const src = readFileSync(SCOPE_SRC, 'utf8')
    // 注释里提到那个名字是允许的（本次改动的说明就提到了它）；这里只禁**赋值**形态。
    expect(src).not.toContain("wrapperKind: 'wrapper-git'")
    expect(src).not.toContain("wrapperKind: wrapper?.kind ?? 'wrapper-git'")
  })
})
