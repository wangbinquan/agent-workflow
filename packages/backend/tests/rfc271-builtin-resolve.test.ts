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
