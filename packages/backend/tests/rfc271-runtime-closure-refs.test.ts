// RFC-271 T6f —— runner 闭包组装（技能 / MCP / 插件 / dependsOn）的引用归位。
//
// 三处此前各写各的去重键：scheduler 的 `m:`/`p:` 前缀串、mcpClosure 与
// pluginClosure 各自的 `Set<裸 id>`。两种写法各带一个未被约束过的假设：
//   · 前缀串自造命名空间 —— 来第三类引用就会撞车；
//   · 裸 id 当键 —— 默认「id 跨资源类型全局唯一」，schema 从没保证过这件事。
// 归位到 `runtimeRefKey`（JSON 元组、type 进 key）后两条都不成立。
//
// 另外两条是本次改动最容易悄悄改错的地方：
//   · **project 技能不是资源**：无 DB row / 无 ACL / 无 owner，只能走专属 AST
//     变体，否则闭包遍历与 ACL 会把它当成一个查不到的受管技能；
//   · **`onMissing` 是调用级的**：同一条 dependsOn 引用，保存期硬失败、tolerant
//     UI preview 静默跳过 —— 这个差异必须留在调用点，不能塌成域的固有语义。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DISPATCH_CALL_POLICY,
  isNonResourceRef,
  PREVIEW_CALL_POLICY,
  VALIDATE_CALL_POLICY,
  type Agent,
} from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { createAgent, getAgentById } from '../src/services/agent'
import { resolveDependsClosure } from '../src/services/agentDeps'
import { collectMcpIdsFromClosure } from '../src/services/mcpClosure'
import { collectPluginIdsFromClosure } from '../src/services/pluginClosure'
import { agentSkillRef, runtimeIdRef, runtimeRefKey } from '../src/services/ref/runtimeRef'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

const agentRow = (over: Partial<Agent>): Agent =>
  ({
    id: 'a1',
    name: 'a',
    description: '',
    outputs: [],
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    ...over,
  }) as unknown as Agent

describe('agentSkillRef —— 判别联合的两支各有归属', () => {
  test('managed → id 引用（有行、有 ACL）', () => {
    expect(agentSkillRef({ kind: 'managed', skillId: '01SKILL' })).toEqual({
      k: 'id',
      type: 'skill',
      id: '01SKILL',
    })
  })

  test('project → 专属的非资源变体（无行、无 ACL、按名透传 CLI）', () => {
    const ref = agentSkillRef({ kind: 'project', name: 'repo-helper' })
    expect(ref).toEqual({ k: 'project-skill', name: 'repo-helper' })
    // 闭包遍历 / 去重门 / ACL 都靠这条判据跳过它。
    expect(isNonResourceRef(ref)).toBe(true)
  })

  test('**绝不**把 project 技能表达成 `{k:"name",type:"skill"}`', () => {
    // 那样表达等于宣称「库里有一行叫这个名字的受管技能」，闭包会去查、查不到就
    // 报 skill-not-found —— 而它本来就不该有行。
    const ref = agentSkillRef({ kind: 'project', name: 'repo-helper' })
    expect(ref.k).not.toBe('name')
    expect(isNonResourceRef(agentSkillRef({ kind: 'managed', skillId: 'x' }))).toBe(false)
  })
})

describe('runtimeRefKey —— 跨类型不碰撞', () => {
  test('同一个 id 串在四类资源下是四个不同的 key', () => {
    const keys = (['agent', 'skill', 'mcp', 'plugin'] as const).map((t) =>
      runtimeRefKey(runtimeIdRef(t, 'SAME')),
    )
    expect(new Set(keys).size).toBe(4)
  })

  test('受管技能与同名 project 技能不是同一条', () => {
    expect(runtimeRefKey(agentSkillRef({ kind: 'managed', skillId: 'helper' }))).not.toBe(
      runtimeRefKey(agentSkillRef({ kind: 'project', name: 'helper' })),
    )
  })

  test('旧的 `m:`/`p:` 前缀串曾把这两条判成不同 —— 新键保持该结论，且更彻底', () => {
    // 老写法只覆盖技能一类；新键对所有类型都成立（上一条），所以是真包含关系。
    expect(runtimeRefKey(runtimeIdRef('mcp', 'github'))).not.toBe(
      runtimeRefKey(runtimeIdRef('plugin', 'github')),
    )
  })
})

describe('闭包 collector —— 顺序契约不变（first-seen，root 在前）', () => {
  const closure: Agent[] = [
    agentRow({ id: 'root', mcp: ['m2', 'm1'], plugins: ['p2'] }),
    agentRow({ id: 'dep', mcp: ['m1', 'm3'], plugins: ['p2', 'p1'] }),
  ]

  test('MCP：去重后保持首见顺序', () => {
    expect(collectMcpIdsFromClosure(closure)).toEqual(['m2', 'm1', 'm3'])
  })

  test('插件：同上', () => {
    expect(collectPluginIdsFromClosure(closure)).toEqual(['p2', 'p1'])
  })

  test('空闭包 / 缺字段不炸', () => {
    expect(collectMcpIdsFromClosure([])).toEqual([])
    expect(collectPluginIdsFromClosure([agentRow({ id: 'x' })])).toEqual([])
  })
})

describe('resolveDependsClosure —— onMissing 留在调用级', () => {
  // root 用**合成对象**而不是落库的行：`createAgent` 自己就会拒绝指向幽灵 id 的
  // dependsOn，所以「闭包里有一条解析不到的引用」这个形态只能这样构造——
  // `validateDependsOn` 走的也正是同一条合成 root 路径。
  const seed = async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const leaf = await createAgent(db, {
      name: 'leaf',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const top = agentRow({
      id: '01TOPTOPTOPTOPTOPTOPTOPTOP',
      name: 'top',
      dependsOn: [leaf.id, '01GHOSTGHOSTGHOSTGHOSTGHOST'],
    })
    return { db, top, leaf }
  }

  test("preview（onMissing:'skip'）跳过查不到的依赖，遍历继续", async () => {
    const { db, top, leaf } = await seed()
    const r = await resolveDependsClosure({ get: (id) => getAgentById(db, id) }, top, {
      call: PREVIEW_CALL_POLICY,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agents.map((a) => a.id)).toEqual([top.id, leaf.id])
  })

  test("validate / dispatch（onMissing:'fail'）硬失败在同一条引用上", async () => {
    const { db, top } = await seed()
    for (const call of [VALIDATE_CALL_POLICY, DISPATCH_CALL_POLICY]) {
      await expect(
        resolveDependsClosure({ get: (id) => getAgentById(db, id) }, top, { call }),
      ).rejects.toMatchObject({ code: 'agent-dependency-not-found' })
    }
  })

  test('两种归属**必须**由调用点给出：策略是必填参数，没有「默认硬失败」这一档', () => {
    // 源码级断言：可选参数 + 默认值会让「这是调用点的选择」这件事从签名里消失，
    // 下一个人就会以为硬失败是 dependsOn 域的固有语义（它不是）。
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'services', 'agentDeps.ts'), 'utf8')
    expect(src).toContain('opts: ResolveClosureOpts,')
    expect(src).not.toContain('opts: ResolveClosureOpts = {}')
    expect(src).not.toContain('allowMissing?:')
  })
})
