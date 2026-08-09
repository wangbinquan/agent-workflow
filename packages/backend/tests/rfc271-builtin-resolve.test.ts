// RFC-271 —— `builtin:` 的**语义层**：绑定正确性与 fail-closed。
//
// 覆盖验收条款：AC-9（builtin 不入 resources，只入 builtins 声明）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 词法层的接受/拒绝矩阵在 `shared/tests/rfc271-builtin-ref-wire.test.ts`；这里管
// 词法层**故意不管**的那一半：
//   · 名字能不能命中一个**真的是 built-in** 的行（劫持面）
//   · 命不中时是 fail closed 还是留悬空引用
//
// 最要紧的一条是**劫持**：如果解析只按名字查、不校验 `builtin = true`，那么
// 「导入时自动忽略 built-in」就会退化成「绑到某个碰巧同名的用户资源」——攻击者
// 只要在对端建一个叫 `__skill_merger__` 的普通 agent，就能让别人导入的工作流
// 指向自己的 agent。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ResourceRefAstSchema,
  decodeBundleIdentityRef,
  encodeBundleIdentityRef,
  resourceRefKey,
} from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { agents, workflows } from '../src/db/schema'
import {
  resolveAgentSkillRef,
  resolveIdentityRef,
  type RefResolveCtx,
} from '../src/services/bundle/refs'
import { __lowerPayloadForTests } from '../src/services/bundle/lower'

/** 断言的是**错误码**（契约），不是 message 文案——文案改了不该让测试红。 */
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code,
  )

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/** 与 `commit.ts` 的 provider 实现同构：按名字 + `builtin = true` 查。 */
function ctxOver(db: ReturnType<typeof createInMemoryDb>): RefResolveCtx {
  return {
    idOfSlug: new Map(),
    resolveExternal: async () => {
      throw new Error('external should not be reached in these cases')
    },
    // 与 `commit.ts` 的 provider 等价：`(name, builtin = true)` 双条件。
    // ⚠️ 少了 `builtin === true` 这半就是劫持面 —— 下面的反例正是锁它。
    resolveBuiltin: async (_type, name) => {
      const match = db
        .select()
        .from(agents)
        .all()
        .find((r) => r.name === name && r.builtin === true)
      return match?.id ?? null
    },
  }
}

const seed = (
  db: ReturnType<typeof createInMemoryDb>,
  rows: Array<{ id: string; name: string; builtin: boolean; owner: string }>,
): void => {
  for (const r of rows) {
    db.insert(agents)
      .values({
        id: r.id,
        name: r.name,
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: r.owner,
        visibility: 'public',
        builtin: r.builtin,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()
  }
}

describe('builtin: 语义层 —— 正例', () => {
  test('绑到本实例自己 seed 的那一个（源库 id 完全不参与）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, [{ id: 'DST_BUILTIN', name: '__skill_merger__', builtin: true, owner: '__system__' }])
    const id = await resolveIdentityRef('builtin:agent/__skill_merger__', 'agent', ctxOver(db))
    expect(id).toBe('DST_BUILTIN')
  })
})

describe('builtin: 语义层 —— 劫持面（最要紧的一条）', () => {
  test('同名的**普通**资源不得被当成 built-in 绑定', async () => {
    // 攻击场景：对端没有这个 built-in，攻击者建一个同名的普通 agent。
    // 只按名字查就会把别人导入的工作流指向攻击者的 agent。
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, [{ id: 'ATTACKER', name: '__skill_merger__', builtin: false, owner: 'u-attacker' }])
    expect(
      await codeOf(resolveIdentityRef('builtin:agent/__skill_merger__', 'agent', ctxOver(db))),
    ).toBe('bundle-builtin-missing')
  })

  test('同名普通资源与真 built-in 并存时，绑的是 built-in 那一个', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, [
      { id: 'ATTACKER', name: '__skill_merger__', builtin: false, owner: 'u-attacker' },
      { id: 'REAL', name: '__skill_merger__', builtin: true, owner: '__system__' },
    ])
    expect(await resolveIdentityRef('builtin:agent/__skill_merger__', 'agent', ctxOver(db))).toBe(
      'REAL',
    )
  })
})

describe('builtin: 语义层 —— fail closed', () => {
  test('本实例没有同名 built-in ⇒ 抛错，**不留悬空引用**', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(await codeOf(resolveIdentityRef('builtin:agent/__nope__', 'agent', ctxOver(db)))).toBe(
      'bundle-builtin-missing',
    )
  })

  test('词法层放行的怪名字，在这里被「查不到」挡住（不是路径穿越）', async () => {
    // 与 wire 层那条「刻意宽松」配对：`a/b` / `../../etc/passwd` 过得了正则，
    // 但它们不可能是合法资源名 ⇒ 必然查不到 ⇒ fail closed。
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, [{ id: 'REAL', name: '__skill_merger__', builtin: true, owner: '__system__' }])
    for (const ref of ['builtin:agent/a/b', 'builtin:agent/../../etc/passwd']) {
      expect({ ref, code: await codeOf(resolveIdentityRef(ref, 'agent', ctxOver(db))) }).toEqual({
        ref,
        code: 'bundle-builtin-missing',
      })
    }
  })

  test('provider 没实现 resolveBuiltin（如 intent 场景）⇒ 同样 fail closed，不静默', async () => {
    // 缺省实现等价于「解析不出」。静默返回 undefined 会让引用悬空落库。
    expect(
      await codeOf(
        resolveIdentityRef('builtin:agent/__skill_merger__', 'agent', {
          idOfSlug: new Map(),
          resolveExternal: async () => 'x',
        }),
      ),
    ).toBe('bundle-builtin-missing')
  })

  test('agent.skills 专属域不接受 builtin，不会误当 managed skill', async () => {
    expect(
      await codeOf(
        resolveAgentSkillRef('builtin:agent/__skill_merger__', {
          idOfSlug: new Map(),
          resolveExternal: async () => 'x',
        }),
      ),
    ).toBe('bundle-ref-invalid')
  })
})

describe('local: 语义层二道 fail-closed', () => {
  test('slug 存在但声明类型与槽位不符 ⇒ 不返回预铸 id', async () => {
    const ctx: RefResolveCtx = {
      idOfSlug: new Map([['tool', { id: 'PLUGIN_ID', type: 'plugin' }]]),
      resolveExternal: async () => 'external',
    }
    expect(await resolveIdentityRef('local:tool', 'plugin', ctx)).toBe('PLUGIN_ID')
    expect(await codeOf(resolveIdentityRef('local:tool', 'mcp', ctx))).toBe(
      'bundle-local-ref-type-mismatch',
    )
  })
})

describe('builtin call lowering —— 真实 builtin id + wire 权威名字', () => {
  test('同名普通 workflow 不得劫持，错误 name cache 也不得改写权威名', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const row of [
      { id: 'ATTACKER', ownerUserId: 'u-attacker', builtin: false },
      { id: 'REAL_BUILTIN', ownerUserId: '__system__', builtin: true },
    ]) {
      db.insert(workflows)
        .values({
          ...row,
          name: '__agent_host__',
          description: '',
          definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
          visibility: 'public',
          createdAt: 1,
          updatedAt: 1,
        } as never)
        .run()
    }
    const ctx: RefResolveCtx = {
      idOfSlug: new Map(),
      resolveExternal: async () => {
        throw new Error('external should not be reached')
      },
      resolveBuiltin: async (type, name) => {
        if (type !== 'workflow') return null
        return (
          db
            .select()
            .from(workflows)
            .all()
            .find((row) => row.name === name && row.builtin === true)?.id ?? null
        )
      },
    }
    const op = {
      opId: 'op-1',
      kind: 'workflow-create' as const,
      slug: 'root',
      payload: {
        name: 'root',
        description: '',
        definition: {
          $schema_version: 4,
          inputs: [],
          edges: [],
          nodes: [
            { id: 'call-1', type: 'call-workflow', workflowRef: 'builtin:workflow/__agent_host__' },
          ],
        },
      },
    }
    const lowered = await __lowerPayloadForTests(
      op as never,
      ctx,
      // 如果 builtin 走通用 `nameOfId` 回查，这个污染值会被写进 definition。
      new Map([['REAL_BUILTIN', 'attacker-controlled-name']]),
      {} as never,
      'root',
    )
    const node = ((lowered.definition as { nodes: Array<Record<string, unknown>> }).nodes ?? [])[0]
    expect(node).toMatchObject({
      workflowName: '__agent_host__',
      workflowId: 'REAL_BUILTIN',
    })
    expect(node).not.toHaveProperty('workflowRef')
  })
})

describe('builtin 作为**导出根**：产物必须能被自己的 parser 接受', () => {
  test('统一抽象是**可执行契约**：调真 schema / 真 codec，不是搜源码字符串', () => {
    // 上一版这条只 `readFileSync` + `toContain('k: \'builtin\'')`。实现门指出它的
    // 盲区：源码里有那几个字母，挡不住「类型联合里加了变体、而 `ResourceRefAstSchema`
    // 的 discriminatedUnion 漏了它」——那正是真实发生过的事（AST 有 builtin 变体，
    // schema 没有，于是任何跨进程/落盘校验都会把合法 builtin 引用判非法）。
    //
    // 源码文本断言只配当兜底；能调 API 的地方就该调 API。
    const ref = { k: 'builtin', type: 'workflow', name: 'aw-skill-fusion' } as const

    // ① schema 必须认这个变体（discriminatedUnion 漏一支就在这里红）。
    expect(ResourceRefAstSchema.safeParse(ref).success).toBe(true)

    // ② 编解码必须**往返**：encoder 产出的东西 decoder 要读得回来，且逐字相同。
    const wire = encodeBundleIdentityRef(ref)
    expect(wire).toBe('builtin:workflow/aw-skill-fusion')
    expect(decodeBundleIdentityRef(wire!)).toEqual(ref)

    // ③ 类型必须**收窄**到有 builtin 列的两张表。六类 ACL type 全放进来会造出一种
    // 任何 resolver 都兑现不了的非法状态（`skills.builtin` 那一列根本不存在）。
    expect(ResourceRefAstSchema.safeParse({ k: 'builtin', type: 'skill', name: 'x' }).success).toBe(
      false,
    )

    // ④ key 必须把三要素都算进去，否则两个不同 built-in 会去重成一个。
    expect(resourceRefKey(ref)).not.toBe(
      resourceRefKey({ k: 'builtin', type: 'agent', name: 'aw-skill-fusion' }),
    )
  })

  test('源码层兜底：不得再出现第二处私有 regex（可执行断言够不到的那部分）', () => {
    // 这条锁的是一次真实缺陷：`builtin:` 最初只加进了 `bundle/payload.ts` 的私有
    // regex，没进统一的 `ResourceRefAst` / 域 codec。于是三处各说各话 ——
    //   · serializer 给 built-in 根写 `builtin:`（写 `local:` 会判 dangling-root）
    //   · `RootRefSchema` 只认 `local:` / `external:`
    //   · `parse.ts` 要求 rootRef 必须 `local:` 且出现在 manifest.resources 里
    // 实测导出一个 built-in 工作流，产物被自己的 parser 判 `package-invalid`。
    //
    // 修法不是再加一处 regex，而是**把 builtin 并进统一抽象**：AST 变体 + 域 codec
    // + RootRefSchema + parse 的 root 分支。RFC 的核心主张就是「引用身份只有一处
    // 定义」，每加一处私有解析就是在还这笔债。
    const ast = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'ref', 'ast.ts'),
      'utf8',
    )
    expect(ast).toContain("k: 'builtin'")
    expect(ast).toContain("JSON.stringify(['builtin', ref.type, ref.name])")

    const codecs = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'ref', 'codecs.ts'),
      'utf8',
    )
    expect(codecs).toContain('BUNDLE_BUILTIN_RE')
    expect(codecs).toContain("if (ref.k === 'builtin')")

    const bundle = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'bundle', 'bundle.ts'),
      'utf8',
    )
    // Root 与 payload 必须消费同一个 wire schema，不能再复制一份含 builtin 的 regex。
    expect(bundle).toContain('const RootRefSchema = BundleIdentityRefWireSchema')
    expect(bundle).not.toContain('builtin:(agent|workflow)')
    // 闭合性扫描扫的是**真实字段名**：曾写 `targetRef`（不存在的字段），于是 call
    // 槽的 local: 引用从来没被校验过。
    expect(bundle).toContain("push(rec.workflowRef, 'workflow')")
    expect(bundle).toContain("push(rec.workgroupRef, 'workgroup')")
    expect(bundle).not.toContain('push(rec.targetRef)')
  })
})
