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
//   ① workflow YAML 导入 → Resource Catalog legacy workflow createWorkflow 单点；
//   ② skill ZIP 导入 → skill-zip.ts 全部创建走 createManagedSkillWithFiles
//     （skill.ts 内 initialPrivateResourceAcl ×2：reserve 与 recreate 两臂）；
//   ③ bundle apply → resource-catalog aggregate adapter 的 plugin 铸造经 owner-bound
//      dependency 走 initialPrivateResourceAcl（RFC-284 T11 收编）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const moduleSrc = (rel: string): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', 'modules', rel), 'utf8')
const legacyResourceSrc = (rel: string): string =>
  moduleSrc(`resource-catalog/infrastructure/legacy/${rel}`)

describe('RFC-285 B6③ — 导入产物 private 三路装配锁', () => {
  test('① workflow 创建（含 YAML 导入路）经 initialPrivateResourceAcl', () => {
    const workflow = legacyResourceSrc('workflow.ts')
    expect(workflow).toContain('initialPrivateResourceAcl(input.ownerUserId)')
    // 不得出现字面 public 初值铸造（visibility 字面量只允许出现在读取/比较侧）。
    expect(workflow.includes("visibility: 'public'")).toBe(false)
  })

  test('② skill ZIP 导入全部创建穿过 createManagedSkillWithFiles 单点', () => {
    const zip = legacyResourceSrc('skill-zip.ts')
    expect(zip).toContain('createManagedSkillWithFiles')
    // zip 路自身不得另铸 ACL 初值（单点在 skill.ts）。
    expect(zip.includes('initialPrivateResourceAcl')).toBe(false)
    expect(zip.includes("visibility: 'public'")).toBe(false)
    const skill = legacyResourceSrc('skill.ts')
    expect((skill.match(/initialPrivateResourceAcl\(ownerUserId\)/g) ?? []).length).toBe(2)
  })

  test('③ 资源包 apply 的每条铸造都落 owner + private（RFC-284 T11）', () => {
    // RFC-359（apply 引擎合一，plan §5dy）：legacy 那条链（`legacyResourcePackageMutationParticipants`
    // + 它的依赖表）随通用 bundle 引擎退役，判据改指生产在用的七条臂。
    //
    // 判据形状也跟着变：legacy 那条是「调 `dependencies.initialPrivateResourceAcl(...)`」，
    // 统一那条把同一件事写成逐臂的字面量（`ownerUserId` + `visibility: 'private'` + `aclRevision: 0`）。
    // 锁的东西不变——**每一条铸造都归导入者、都是 private，且没有任何一处写 public**。
    const arms = moduleSrc(
      'resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
    )
    // RFC-401 A1 / A2：agent / MCP / plugin 的新建经各自唯一的写入参与者——资源包把导入者交进去当 owner，参与者铸造
    // private 行（agent 走 `createAgentPersistenceValues` 的 private 缺省；MCP / plugin 写字面量）。
    const participants = ['mcpMutationParticipant.ts', 'pluginMutationParticipant.ts'].map((file) =>
      moduleSrc(`resource-catalog/infrastructure/${file}`),
    )
    const privateMints = [arms, ...participants].reduce(
      (count, src) => count + (src.match(/visibility: 'private',/g) ?? []).length,
      0,
    )
    expect(privateMints, '铸造点一处都没扫到 ⇒ 判据此刻零预言力').toBeGreaterThanOrEqual(4)
    // 归属：arm 里逐条把导入者交给铸造（直接写字面量，或作为 owner 交给参与者）。
    expect(
      (arms.match(/ownerUserId: input\.context\.actor\.user\.id,/g) ?? []).length,
    ).toBeGreaterThanOrEqual(4)
    expect(arms).toContain("Object.freeze({ kind: 'actor' as const, actor: input.context.actor })")
    expect(moduleSrc('resource-catalog/infrastructure/agentPersistence.ts')).toContain(
      "visibility: 'private',",
    )
    for (const src of [arms, ...participants])
      expect(src.includes("visibility: 'public'")).toBe(false)
  })
})
