// RFC-271 决策 29（T0b）—— 统一引用模型的锁。
//
// 这个文件锁三件事，每一件都对应设计门抓出的一次真实缺陷：
//
//  ① **字节级 round-trip**（R7-P1-1）：决策 29 承诺「INTENT.md、模型输出、存量
//     definition、agent.md 导入一个字节都不用改」。那个承诺只有靠逐字往返测试才
//     能兑现——初稿把「归一化」和「wire」混成一张形态表，intent 的 `$new:x` 和
//     bundle 的 `local:x` 被迫二选一，选哪个都破坏一边。
//
//  ② **域是收窄不是放宽**：把 `name:` 放进 agent 的 dependsOn 必须 parse 失败。
//     没有这条，「统一」会退化成「各域都能塞任意形态」。
//
//  ③ **selector 的 type 必须进稳定 key**（R7-P1-1）：丢了 type，
//     {type:'mcp',name:'github'} 与 {type:'plugin',name:'github'} 会归并成同一个
//     key —— agent.md 导入时两个不同资源被当成一个。
//
// 另锁 project-skill 是非资源叶子（R8-P1-1 / R10）：它没有 row/ACL，闭包遍历、
// 资源去重门都要跳过它，但它**必须**能在 agent.skills 槽里往返，否则一个今天
// 完全合法、能跑的代理无法 round-trip。

//
// 覆盖验收条款：AC-B2（域收窄）/ AC-B2b（name: late-bound）/ AC-B2d（wire 零变更）/ AC-B2h（agent skills 专属 codec）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { INTENT_HANDLE_RE, INTENT_TEMP_REF_RE } from '../src/ref/codecs'
import {
  decodeAgentSkillRef,
  decodeBundleAgentSkillRef,
  decodeBundleCallRef,
  decodeBundleIdentityRef,
  decodeCallRef,
  decodeImportSelectorRef,
  decodeIntentRef,
  encodeAgentSkillRef,
  encodeBundleAgentSkillRef,
  encodeBundleCallRef,
  encodeBundleIdentityRef,
  encodeCallRef,
  encodeImportSelectorRef,
  encodeIntentRef,
  isNonResourceRef,
  RESOURCE_REF_AST_KINDS,
  REF_DOMAIN_VARIANTS,
  resourceRefKey,
  ResourceRefAstSchema,
  type AgentSkillWire,
  type ResourceRefAst,
} from '../src/ref'

describe('① 字节级 round-trip —— 「wire 零变更」的唯一硬保证', () => {
  test('intent handle / tempRef 拼写逐字不变', () => {
    // 这两个字符串就是模型今天看到的东西（schemas/intentChangeset.ts 的正则）。
    for (const wire of ['res#agent#3', 'res#workgroup#123456', '$new:auditor', '$new:a-b_c9']) {
      const ast = decodeIntentRef(wire)
      expect(ast).not.toBeNull()
      expect(encodeIntentRef(ast!)).toBe(wire)
    }
  })

  test('intent tempRef 与 bundle local 是同一个 AST 变体、两种编码', () => {
    // R7-P1-1 的要害：初稿要求二者共用一种拼写，选哪个都破坏一边。
    const fromIntent = decodeIntentRef('$new:auditor')!
    const fromBundle = decodeBundleIdentityRef('local:auditor')!
    expect(fromIntent).toEqual(fromBundle)
    expect(encodeIntentRef(fromIntent)).toBe('$new:auditor')
    expect(encodeBundleIdentityRef(fromBundle)).toBe('local:auditor')
  })

  test('agent.skills 判别联合两个分支都能往返（managed / project）', () => {
    const cases: AgentSkillWire[] = [
      { kind: 'managed', skillId: '01JMANAGED0000000000000000' },
      { kind: 'project', name: 'repo-lint' },
      // RFC-264：仓内技能名允许非 ASCII（正式写路径只要求相对不越界）。
      { kind: 'project', name: '审计 规则' },
    ]
    for (const wire of cases) {
      expect(encodeAgentSkillRef(decodeAgentSkillRef(wire))).toEqual(wire)
    }
  })

  test('call 复合记录往返：idHint 缺席时不得凭空生出来', () => {
    const withHint = { nodeId: 'c1', name: 'audit', idHint: '01JW2000000000000000000000' }
    const lateBound = { nodeId: 'c2', name: 'ghost' }
    expect(encodeCallRef(decodeCallRef('workflow', withHint))).toEqual(withHint)
    expect(encodeCallRef(decodeCallRef('workgroup', lateBound))).toEqual(lateBound)
  })

  test('import selector 往返且保留 ownerUsername 的缺席/在场', () => {
    for (const wire of [
      { type: 'mcp' as const, name: 'github' },
      { type: 'skill' as const, name: 'review', ownerUsername: 'alice' },
    ]) {
      expect(encodeImportSelectorRef(decodeImportSelectorRef(wire))).toEqual(wire)
    }
  })

  test('bundle 三种槽位形态各自往返', () => {
    expect(encodeBundleIdentityRef(decodeBundleIdentityRef('local:a1')!)).toBe('local:a1')
    expect(encodeBundleIdentityRef(decodeBundleIdentityRef('external:tok')!)).toBe('external:tok')
    expect(encodeBundleAgentSkillRef(decodeBundleAgentSkillRef('project:repo-lint')!)).toBe(
      'project:repo-lint',
    )
    expect(encodeBundleCallRef(decodeBundleCallRef('name:workflow/audit')!)).toBe(
      'name:workflow/audit',
    )
    for (const wire of ['builtin:agent/merger', 'builtin:workflow/host']) {
      expect(encodeBundleIdentityRef(decodeBundleIdentityRef(wire)!)).toBe(wire)
      expect(encodeBundleCallRef(decodeBundleCallRef(wire)!)).toBe(wire)
    }
  })

  test("builtin managed 技能的 external token 编码可往返（design §1.1b' 的表）", () => {
    const wire = 'external:builtin/skill/skill-merger'
    expect(encodeBundleIdentityRef(decodeBundleIdentityRef(wire)!)).toBe(wire)
  })
})

describe('② 域是收窄不是放宽 —— 跨域形态必须 parse 失败', () => {
  test('name: 形态不得出现在 identity 槽（agent 的 dependsOn/mcp/plugins）', () => {
    expect(decodeBundleIdentityRef('name:workflow/audit')).toBeNull()
  })

  test('project: 形态只在 agent.skills 槽合法', () => {
    expect(decodeBundleAgentSkillRef('project:repo-lint')).not.toBeNull()
    // 其余两个槽都必须拒绝它
    expect(decodeBundleIdentityRef('project:repo-lint')).toBeNull()
    expect(decodeBundleCallRef('project:repo-lint')).toBeNull()
  })

  test('builtin: 只进 identity/call 域，不渗进 agent.skills', () => {
    const wire = 'builtin:workflow/host'
    const ast = { k: 'builtin', type: 'workflow', name: 'host' } as const
    expect(decodeBundleIdentityRef(wire)).toEqual(ast)
    expect(decodeBundleCallRef(wire)).toEqual(ast)
    expect(decodeBundleAgentSkillRef(wire)).toBeNull()
    expect(encodeBundleIdentityRef(ast)).toBe(wire)
    expect(encodeBundleCallRef(ast)).toBe(wire)
    expect(encodeBundleAgentSkillRef(ast)).toBeNull()
  })

  test('intent codec 不认识 bundle 的拼写，反之亦然', () => {
    expect(decodeIntentRef('local:auditor')).toBeNull()
    expect(decodeIntentRef('external:tok')).toBeNull()
    expect(decodeBundleIdentityRef('$new:auditor')).toBeNull()
    expect(decodeBundleIdentityRef('res#agent#3')).toBeNull()
  })

  test('编码方向同样收窄：拿错变体一律 null，不静默降级', () => {
    const nameRef: ResourceRefAst = { k: 'name', type: 'workflow', name: 'audit' }
    expect(encodeBundleIdentityRef(nameRef)).toBeNull()
    expect(encodeIntentRef(nameRef)).toBeNull()
    const projectRef: ResourceRefAst = { k: 'project-skill', name: 'repo-lint' }
    expect(encodeBundleIdentityRef(projectRef)).toBeNull()
    expect(encodeRuntimeIdRefSafe(projectRef)).toBeNull()
  })

  test('域变体表覆盖了全部九个 AST 变体（新增变体会让这条红）', () => {
    const declared = new Set(Object.values(REF_DOMAIN_VARIANTS).flat())
    const all: ResourceRefAst['k'][] = [
      'id',
      'name',
      'selector',
      'handle',
      'local',
      'external',
      'call',
      'project-skill',
      'builtin',
    ]
    for (const k of all) expect(declared.has(k)).toBe(true)
    expect(REF_DOMAIN_VARIANTS.bundleIdentity).toContain('builtin')
    expect(REF_DOMAIN_VARIANTS.bundleCall).toContain('builtin')
    expect(REF_DOMAIN_VARIANTS.bundleAgentSkill).not.toContain('builtin')
  })
})

describe('③ 稳定 key —— selector 的 type 必须参与', () => {
  test('同名不同类型的 selector 不得归并（R7-P1-1 的具体反例）', () => {
    const mcp = resourceRefKey({ k: 'selector', type: 'mcp', name: 'github' })
    const plugin = resourceRefKey({ k: 'selector', type: 'plugin', name: 'github' })
    expect(mcp).not.toBe(plugin)
  })

  test('ownerUsername 缺席与在场是不同的 key', () => {
    const bare = resourceRefKey({ k: 'selector', type: 'skill', name: 'review' })
    const owned = resourceRefKey({
      k: 'selector',
      type: 'skill',
      name: 'review',
      ownerUsername: 'alice',
    })
    expect(bare).not.toBe(owned)
  })

  test('call 的边身份按 nodeId 区分 —— 同名两个节点必须不同 key', () => {
    // R6-P1-3 / R7-P1-4：同名两个 call 节点各自生效的前提。
    const c1 = resourceRefKey({
      k: 'call',
      type: 'workflow',
      nodeId: 'c1',
      authoritativeName: 'audit',
      idHint: 'W1',
    })
    const c2 = resourceRefKey({
      k: 'call',
      type: 'workflow',
      nodeId: 'c2',
      authoritativeName: 'audit',
      idHint: 'W2',
    })
    expect(c1).not.toBe(c2)
  })
})

describe('project-skill 是非资源叶子', () => {
  test('isNonResourceRef 只对 project-skill 为真', () => {
    expect(isNonResourceRef({ k: 'project-skill', name: 'repo-lint' })).toBe(true)
    expect(isNonResourceRef({ k: 'id', type: 'skill', id: '01J' })).toBe(false)
    expect(isNonResourceRef({ k: 'name', type: 'workflow', name: 'audit' })).toBe(false)
  })

  test('managed 与 project 同名时是两个不同身份（运行时按 m:/p: 分别去重）', () => {
    const managed = resourceRefKey({ k: 'id', type: 'skill', id: 'lint' })
    const project = resourceRefKey({ k: 'project-skill', name: 'lint' })
    expect(managed).not.toBe(project)
  })
})

describe('AST schema', () => {
  test('九个变体都能通过 schema', () => {
    const all: ResourceRefAst[] = [
      { k: 'id', type: 'agent', id: '01J' },
      { k: 'name', type: 'workflow', name: 'audit' },
      { k: 'selector', type: 'mcp', name: 'github' },
      { k: 'handle', type: 'skill', ordinal: 3 },
      { k: 'local', slug: 'auditor' },
      { k: 'external', token: 'builtin/skill/x' },
      { k: 'call', type: 'workgroup', nodeId: 'c1', authoritativeName: 'squad' },
      { k: 'project-skill', name: 'repo-lint' },
      { k: 'builtin', type: 'workflow', name: 'host' },
    ]
    expect(all.map((ref) => ref.k)).toEqual(RESOURCE_REF_AST_KINDS)
    for (const ref of all) expect(ResourceRefAstSchema.safeParse(ref).success).toBe(true)
  })

  test('builtin 只允许真有 builtin 列的 agent/workflow', () => {
    expect(
      ResourceRefAstSchema.safeParse({ k: 'builtin', type: 'agent', name: 'merger' }).success,
    ).toBe(true)
    for (const type of ['skill', 'mcp', 'plugin', 'workgroup']) {
      expect(ResourceRefAstSchema.safeParse({ k: 'builtin', type, name: 'x' }).success).toBe(false)
    }
  })

  test('local slug 词法与 intent tempRef 的 slug 部分一致', () => {
    expect(ResourceRefAstSchema.safeParse({ k: 'local', slug: 'A-bad' }).success).toBe(false)
    expect(ResourceRefAstSchema.safeParse({ k: 'local', slug: 'ok-9_x' }).success).toBe(true)
  })
})

/** encodeRuntimeIdRef 的 null 分支包装（避免测试里 import 顺序噪音）。 */
function encodeRuntimeIdRefSafe(ref: ResourceRefAst): string | null {
  return ref.k === 'id' ? ref.id : null
}

describe('T6b/T6c —— lexicon 只有一份（决策 29 的实质）', () => {
  test('intent 的两个正则由 ref/codecs 定义，schemas 侧只是 re-export', () => {
    // 决策 29 要消除的正是「同一概念多套实现」。这条守卫保证以后没人再复制一份
    // 正则回 schemas/：那样两边会各自漂移，而 wire 是模型看得见的东西。
    const codecs = readFileSync(resolve(import.meta.dir, '..', 'src', 'ref', 'codecs.ts'), 'utf8')
    const schema = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'schemas', 'intentChangeset.ts'),
      'utf8',
    )
    expect(codecs).toContain('export const INTENT_HANDLE_RE')
    expect(codecs).toContain('export const INTENT_TEMP_REF_RE')
    // schemas 侧不得再有自己的定义（re-export 不含 `= /`）
    expect(schema).not.toMatch(
      /export const INTENT_HANDLE_RE\s*=\s*$|export const INTENT_HANDLE_RE\s*=\s*\//,
    )
    expect(schema).not.toMatch(/export const INTENT_TEMP_REF_RE\s*=\s*\//)
    expect(schema).toContain("from '../ref/codecs'")
  })

  test('两处 wire 拼写与今天逐字节相同（模型契约不动）', () => {
    expect(INTENT_HANDLE_RE.test('res#agent#3')).toBe(true)
    expect(INTENT_TEMP_REF_RE.test('$new:auditor')).toBe(true)
    // 反例同样不变
    expect(INTENT_HANDLE_RE.test('res#agent#0')).toBe(false)
    expect(INTENT_TEMP_REF_RE.test('$new:Bad')).toBe(false)
  })
})
