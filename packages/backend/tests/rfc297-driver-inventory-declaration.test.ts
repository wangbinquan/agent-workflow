// RFC-297 T5 —— 每个注册 driver 的清单表态必须完备且自洽。
//
// 编译期已有棘轮：`InventoryDeclaration` 由映射类型在封闭的面/字段联合上派生，
// 新增一个面或给某面新增一个字段，任何未表态的 driver 都编译不过（本 RFC 落地
// 时 rfc143 的 mock driver 就是这样被逼着补齐的）。这组用例补的是棘轮拦不住的
// 两类情况：
//  · `as` 断言绕过类型检查后留下的空洞；
//  · 表态之间**自相矛盾**——例如声明「我不产任何启动观测」却又说某个面
//    supported，或者面 supported 而其全部字段 unsupported（那意味着这一面只有
//    名字，是合法的，但反过来面 unsupported 而字段却写 supported 就是笔误）。

import { describe, expect, test } from 'bun:test'
import {
  INVENTORY_FACES,
  INVENTORY_FIELDS_BY_FACE,
  type InventoryFace,
} from '@agent-workflow/shared'
import { RUNTIME_KINDS, getRuntimeDriver } from '@/services/runtime'

const drivers = RUNTIME_KINDS.map((kind) => ({ kind, driver: getRuntimeDriver(kind) }))

describe('清单表态完备性', () => {
  for (const { kind, driver } of drivers) {
    test(`${kind}: 五个面齐全，且每面的字段表态不多不少`, () => {
      const declaration = driver.capabilities.inventory
      expect(Object.keys(declaration).sort()).toEqual([...INVENTORY_FACES].sort())
      for (const face of INVENTORY_FACES) {
        const expected = [...INVENTORY_FIELDS_BY_FACE[face]].sort()
        expect(Object.keys(declaration[face].fields).sort()).toEqual(expected)
      }
    })

    test(`${kind}: 面 unsupported 时，其字段不得声明 supported`, () => {
      const declaration = driver.capabilities.inventory
      for (const face of INVENTORY_FACES) {
        if (declaration[face].support !== 'unsupported') continue
        const fields = declaration[face].fields as Readonly<Record<string, string>>
        for (const [field, support] of Object.entries(fields)) {
          expect(`${face}.${field}=${support}`).toBe(`${face}.${field}=unsupported`)
        }
      }
    })

    test(`${kind}: startupObservation 与面表态自洽`, () => {
      const caps = driver.capabilities
      if (caps.startupObservation !== 'none') return
      // 没有观测源却声称某面 supported = 承诺了一份永远拿不出来的清单。
      const supported = INVENTORY_FACES.filter((f) => caps.inventory[f].support === 'supported')
      expect(supported).toEqual([])
    })
  }
})

describe('两个内建运行时的表态反映各自协议的真实能力', () => {
  const declarationOf = (kind: 'opencode' | 'claude-code') =>
    getRuntimeDriver(kind).capabilities.inventory

  test('claude 没有插件概念——plugins 面 unsupported（与 declarationFaces 一致）', () => {
    expect(declarationOf('claude-code').plugins.support).toBe('unsupported')
    expect(getRuntimeDriver('claude-code').capabilities.declarationFaces.plugins).toBe(
      'unsupported',
    )
  })

  test('claude 的 init 报告工具集，opencode 的 dump 插件不报告', () => {
    expect(declarationOf('claude-code').tools.support).toBe('supported')
    expect(declarationOf('opencode').tools.support).toBe('unsupported')
  })

  test('opencode 的富字段全部可观测——统一读端不得让它掉字段（AC-2）', () => {
    const d = declarationOf('opencode')
    const richFaces: InventoryFace[] = ['agents', 'skills', 'mcps', 'plugins']
    for (const face of richFaces) {
      const fields = d[face].fields as Readonly<Record<string, string>>
      for (const [field, support] of Object.entries(fields)) {
        expect(`${face}.${field}=${support}`).toBe(`${face}.${field}=supported`)
      }
    }
  })

  test('claude 只按名字报告：除 mcps.status 外的富字段一律 unsupported', () => {
    const d = declarationOf('claude-code')
    expect(d.mcps.fields.status).toBe('supported')
    const nameOnly = [
      d.agents.fields.mode,
      d.agents.fields.model,
      d.agents.fields.source,
      d.skills.fields.source,
      d.skills.fields.path,
      d.skills.fields.description,
      d.mcps.fields.type,
      d.mcps.fields.hint,
    ]
    expect(nameOnly).toEqual(Array(nameOnly.length).fill('unsupported'))
  })
})
