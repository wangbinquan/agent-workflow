// RFC-271 决策 29 — 平台唯一的「怎么指向一个资源」归一化 AST。
//
// 背景：这一个概念此前在仓里有六套各自为政的实现（design §1.1 的表）：
//   ① node.agentId 裸字段读（scheduler 三处）
//   ② workflowName 权威 + workflowId cache（freezeCallClosure）
//   ③ agents.skills/mcp/plugins/dependsOn（runner 组装 config）
//   ④ IntentRef（res#<type>#<n> / $new:<slug>）
//   ⑤ ImportRefSelector（{type, name, ownerUsername?}）
//   ⑥ 配置包的 BundleRef
// 这个 session 查出的 bug 有一半根因在此：机制 ② 内部就不一致（工作流分支认 id
// cache、工作组分支压根不读 workgroupId）；冻结闭包按 name 键控而节点带的是 id；
// 机制 ① 在三处各写一遍。
//
// **归一化 ≠ 改 wire**（R7-P1-1 的教训）。AST 统一，编码不统一：每个域有自己的
// wire codec（见 ./codecs.ts），既有拼写逐字保留 ⇒ INTENT.md、模型输出、存量
// workflow definition、agent.md 导入一个字节都不用改。
//
// ⚠️ 命名：`schemas/agent.ts` 里已有一个叫 `ResourceRefSchema` 的**宽松 string**
// （agent 的 dependsOn/mcp/plugins 的 create/import wire，接受 id 或 name）。那是
// 机制 ③ 的现状，与本文件是两个东西；批次 A′ 负责把它迁到这里来。为避免符号碰撞，
// 本文件的类型叫 `ResourceRefAst`。

import { z } from 'zod'
import { AclResourceTypeSchema, type AclResourceType } from '../schemas/resourceAcl'

/** bundle 内前向引用的 slug 词法（与 intent tempRef 的 slug 部分逐字相同）。 */
export const BUNDLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * 归一化 AST。八个变体覆盖六个域的全部实际形态。
 *
 * 变体的选取原则：**一个变体对应一种「解析方式」**，而不是对应一种拼写。
 * 所以 intent 的 `$new:x` 与 bundle 的 `local:x` 是**同一个** `local` 变体
 * （同样是「指向本 bundle 内某个 create op」），只是两个域的 codec 写法不同。
 */
export type ResourceRefAst =
  /** 本实例的 canonical id（ULID）。机制 ①③。 */
  | { readonly k: 'id'; readonly type: AclResourceType; readonly id: string }
  /**
   * late-bound 名字选择器：**允许解析不到**。机制 ②。
   * 只在 call 目标槽合法——`call-workflow.workflowName` 的权威性就是它。
   */
  | { readonly k: 'name'; readonly type: AclResourceType; readonly name: string }
  /** 可移植名字选择器，`type` 必填且参与稳定 key（R7-P1-1）。机制 ⑤。 */
  | {
      readonly k: 'selector'
      readonly type: AclResourceType
      readonly name: string
      readonly ownerUsername?: string
    }
  /** 会话挂载句柄。机制 ④。 */
  | { readonly k: 'handle'; readonly type: AclResourceType; readonly ordinal: number }
  /** bundle / changeset 内前向引用（intent tempRef 与 bundle local 同源）。 */
  | { readonly k: 'local'; readonly slug: string }
  /** bundle 外部引用，由 provider 解析成本地资源 id。 */
  | { readonly k: 'external'; readonly token: string }
  /**
   * call 节点目标 —— **复合记录，不是 id|name 两种互斥形态**（R7-P1-3）。
   * `freezeCallClosure` 的判据是一条复合行为：idHint 命中**且该行仍带该名字**才用
   * 它，否则回退到最老可见同名行。用互斥形态表达不了「W2 改名后回退 W1」。
   */
  | {
      readonly k: 'call'
      readonly type: 'workflow' | 'workgroup'
      readonly nodeId: string
      readonly authoritativeName: string
      readonly idHint?: string
    }
  /**
   * 仓内（repo-local）技能 —— **非资源叶子**（R8-P1-1 / R10）。
   * 它没有 DB row、没有 ACL，runner 按 `p:<name>` 去重并按名字透传给 CLI
   * （scheduler.ts 的 skills 组装）。放进 AST 是为了让 resolver 完整、不在 runner
   * 组装路径上留 special-case；但它**不入闭包遍历队列、不查 row、不进资源去重门**。
   */
  | { readonly k: 'project-skill'; readonly name: string }
  /**
   * 框架 built-in（`agents` / `workflows` 有 `builtin` 列，owner 通常 `__system__`）。
   *
   * 它**按名字跨实例绑定**：源库的 id 在对端没有意义，而复制一份只会得到 owner 错、
   * `builtin=false` 的同名副本。所以它既不是 `id`（跨实例无效）也不是 `local`
   * （包里不产 create op），需要自己的变体。
   *
   * ⚠️ 它必须**在这里**定义。第一版把 `builtin:` 只加进了 `bundle/payload.ts` 的
   * 私有 regex，于是出现两套解析：正式 codec 拒绝它、payload schema 接受它，而
   * `RootRefSchema` 又两者都不认 —— 导出一个 built-in 根会产出**自己的 parser 都
   * 解析不了**的包。RFC 的核心主张就是「引用身份只有一处定义」，破坏它的代价就是这个。
   */
  | { readonly k: 'builtin'; readonly type: AclResourceType; readonly name: string }

// --- schema（用于跨进程/落盘时的校验；域 codec 见 ./codecs.ts） ---

export const ResourceRefAstSchema: z.ZodType<ResourceRefAst> = z.discriminatedUnion('k', [
  z.object({ k: z.literal('id'), type: AclResourceTypeSchema, id: z.string().min(1).max(128) }),
  z.object({ k: z.literal('name'), type: AclResourceTypeSchema, name: z.string().min(1).max(256) }),
  z.object({
    k: z.literal('selector'),
    type: AclResourceTypeSchema,
    name: z.string().min(1).max(128),
    ownerUsername: z.string().min(1).max(64).optional(),
  }),
  z.object({
    k: z.literal('handle'),
    type: AclResourceTypeSchema,
    ordinal: z.number().int().min(1).max(999999),
  }),
  z.object({ k: z.literal('local'), slug: z.string().regex(BUNDLE_SLUG_RE) }),
  z.object({ k: z.literal('external'), token: z.string().min(1).max(128) }),
  z.object({
    k: z.literal('call'),
    type: z.enum(['workflow', 'workgroup']),
    nodeId: z.string().min(1).max(128),
    authoritativeName: z.string().min(1).max(256),
    idHint: z.string().min(1).max(128).optional(),
  }),
  z.object({ k: z.literal('project-skill'), name: z.string().min(1).max(128) }),
]) as unknown as z.ZodType<ResourceRefAst>

/** 稳定 key —— JSON 元组，避免分隔符碰撞（沿用 importRefSelectorKey 的做法）。 */
export function resourceRefKey(ref: ResourceRefAst): string {
  switch (ref.k) {
    case 'id':
      return JSON.stringify(['id', ref.type, ref.id])
    case 'name':
      return JSON.stringify(['name', ref.type, ref.name])
    case 'selector':
      // ⚠️ type 必须进 key：否则 {type:'mcp',name:'github'} 与
      // {type:'plugin',name:'github'} 会归并成同一个 key（R7-P1-1）。
      return JSON.stringify(['selector', ref.type, ref.name, ref.ownerUsername ?? null])
    case 'handle':
      return JSON.stringify(['handle', ref.type, ref.ordinal])
    case 'local':
      return JSON.stringify(['local', ref.slug])
    case 'external':
      return JSON.stringify(['external', ref.token])
    case 'call':
      // 边身份 = (source 由调用方提供) + nodeId；同名两个节点必须不同 key。
      return JSON.stringify([
        'call',
        ref.type,
        ref.nodeId,
        ref.authoritativeName,
        ref.idHint ?? null,
      ])
    case 'builtin':
      return JSON.stringify(['builtin', ref.type, ref.name])
    case 'project-skill':
      return JSON.stringify(['project-skill', ref.name])
  }
}

/** `project-skill` 是唯一的非资源变体——闭包遍历/去重门/ACL 都要跳过它。 */
export function isNonResourceRef(ref: ResourceRefAst): boolean {
  return ref.k === 'project-skill'
}
