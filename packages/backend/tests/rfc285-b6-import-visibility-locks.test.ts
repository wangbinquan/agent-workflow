// RFC-285 T8（B6③）—— 导入产物默认 private 的三路回归锁。
//
// 为什么这条测试存在：审计曾登记「导入单向放宽 visibility」洞；RFC-285 设计门
// 对账发现 v1 所引两锚已脱靶——RFC-231 已把三条导入路全部收到
// `initialPrivateResourceAcl` 单点（E7 从能力清单撤下、降级为回归锁）。本文件
// 锁住这个「已达标现状」防将来漂移：任何一路把导入产物改回 public/字面 ACL，
// 这里先红。行为级 ACL 断言由 rfc231-private-copy / rfc271-import-commit /
// rfc099-resource-routes 等既有套件承担；本锁做的是**装配路径在场性**——
// 三路创建都必须穿过单一 ACL 初值函数。
//
//   ① workflow YAML 导入 → services/workflow.ts createWorkflow 单点；
//   ② skill ZIP 导入 → skill-zip.ts 全部创建走 createManagedSkillWithFiles
//     （skill.ts 内 initialPrivateResourceAcl ×2：reserve 与 recreate 两臂）；
//   ③ bundle apply → bundle/apply.ts 的 plugin 铸造走 initialPrivateResourceAcl
//     （RFC-284 T11 收编）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (rel: string): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', 'services', rel), 'utf8')

describe('RFC-285 B6③ — 导入产物 private 三路装配锁', () => {
  test('① workflow 创建（含 YAML 导入路）经 initialPrivateResourceAcl', () => {
    const workflow = src('workflow.ts')
    expect(workflow).toContain('initialPrivateResourceAcl(input.ownerUserId)')
    // 不得出现字面 public 初值铸造（visibility 字面量只允许出现在读取/比较侧）。
    expect(workflow.includes("visibility: 'public'")).toBe(false)
  })

  test('② skill ZIP 导入全部创建穿过 createManagedSkillWithFiles 单点', () => {
    const zip = src('skill-zip.ts')
    expect(zip).toContain('createManagedSkillWithFiles')
    // zip 路自身不得另铸 ACL 初值（单点在 skill.ts）。
    expect(zip.includes('initialPrivateResourceAcl')).toBe(false)
    expect(zip.includes("visibility: 'public'")).toBe(false)
    const skill = src('skill.ts')
    expect((skill.match(/initialPrivateResourceAcl\(ownerUserId\)/g) ?? []).length).toBe(2)
  })

  test('③ bundle apply 的 plugin 铸造经 initialPrivateResourceAcl（RFC-284 T11）', () => {
    const apply = src('bundle/apply.ts')
    expect(apply).toContain('initialPrivateResourceAcl(ctx.actor.user.id)')
    expect(apply.includes("visibility: 'public'")).toBe(false)
  })
})
