// RFC-271 — `ResourceBundle` 顶层 + 引用闭合性校验。
//
// 两个边界（R4-P1-3 / R6-P1-1）：
//
//  · **`ops` 允许为空**——「全 reuse 的包」翻译结果就是零 op。要求 `.min(1)` 会让它
//    在 parse 阶段就失败、根本进不了 journal。引擎对空 bundle 走 **no-op 成功路径**，
//    但**仍要跑 selectedExternalFence**（否则全 reuse 恰恰是完全免检的那一档）。
//  · **`rootRef` 允许指向 external**——根被 reuse / overwrite 时它没有 create slug。
//    此时必须带 `rootType`：external token 不自带类型，receipt 需要它才能报出根的类型。

import { z } from 'zod'
import { AclResourceTypeSchema } from '../schemas/resourceAcl'
import { BUNDLE_MAX_OPS, BundleOpSchema, type BundleOp } from './op'

export const BUNDLE_VERSION = 1

const RootRefSchema = z
  .string()
  // ⚠️ 必须接受 `builtin:` —— 导出一个 built-in 根时 serializer 就是这么写的
  // （built-in 不产 op，写 `local:` 会让 parser 判 `bundle-dangling-root`）。
  // 少了这一支，导出的包**自己的 parser 都解析不了**（实测 `package-invalid`）。
  .regex(
    /^(local:[a-z0-9][a-z0-9_-]{0,63}|external:[A-Za-z0-9._:#/-]{1,128}|builtin:(agent|workflow)\/\S{1,256})$/,
  )

export interface BundleRefIssue {
  code:
    | 'bundle-duplicate-op-id'
    | 'bundle-duplicate-slug'
    | 'bundle-dangling-local-ref'
    | 'bundle-dangling-root'
    | 'bundle-root-type-missing'
    | 'bundle-too-many-ops'
  message: string
  /** 出问题的 opId / slug，供 UI 定位。 */
  pointer?: string
}

/** 收集 bundle 内所有 `local:` 引用（各槽位都要扫到）。 */
function collectLocalRefs(op: BundleOp): string[] {
  const out: string[] = []
  const push = (wire: unknown): void => {
    if (typeof wire === 'string' && wire.startsWith('local:')) out.push(wire.slice('local:'.length))
  }
  const p = op.payload as Record<string, unknown>
  for (const key of ['skills', 'dependsOn', 'mcp', 'plugins'] as const) {
    const arr = p[key]
    if (Array.isArray(arr)) for (const item of arr) push(item)
  }
  const members = p.members
  if (Array.isArray(members)) {
    for (const m of members) {
      if (typeof m === 'object' && m !== null) push((m as Record<string, unknown>).agentRef)
    }
  }
  // 工作流 definition 里的引用槽（agentRef / call 目标）已在 lowering 时写成 wire。
  const definition = p.definition
  if (typeof definition === 'object' && definition !== null) {
    const nodes = (definition as Record<string, unknown>).nodes
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (typeof n !== 'object' || n === null) continue
        const rec = n as Record<string, unknown>
        push(rec.agentRef)
        // ⚠️ call 目标的实际字段是 `workflowRef` / `workgroupRef`（见 serialize 的
        // lifting）。这里曾写 `targetRef` —— 一个**根本不存在的字段**，于是 call 槽的
        // `local:` 引用从来没被闭合性校验扫到过：一个引用了包内子工作流、而该子工作流
        // 又没有 create op 的包，能一路过 schema 到 apply 才炸。
        push(rec.workflowRef)
        push(rec.workgroupRef)
      }
    }
  }
  return out
}

/**
 * 闭合性校验：重复 slug / 悬空 `local:` 引用 / 悬空 rootRef / external root 缺 type /
 * 超出 op 上限。**external 形态的 rootRef 不算悬空。**
 */
export function collectBundleRefIssues(bundle: {
  ops: readonly BundleOp[]
  rootRef?: string
  rootType?: string
}): BundleRefIssue[] {
  const issues: BundleRefIssue[] = []

  if (bundle.ops.length > BUNDLE_MAX_OPS) {
    issues.push({
      code: 'bundle-too-many-ops',
      message: `bundle has ${bundle.ops.length} ops; the limit is ${BUNDLE_MAX_OPS}`,
    })
  }

  // `opId` 是引擎侧 Map 的**键**（pluginInstalls / skillStages / skillVersionStages
  // 全按它索引）。重复的 opId 不会报错，只会静静地让后一项 `Map.set` 覆盖前一项：
  // 两个插件都用 `op-1` 时，插件 A 保留自己的 spec，`cachedPath` 却指向插件 B 装出来
  // 的目录。这属于「schema 本该挡住」的一类，放到运行时就只能靠肉眼发现。
  const opIds = new Set<string>()
  for (const op of bundle.ops) {
    if (opIds.has(op.opId)) {
      issues.push({
        code: 'bundle-duplicate-op-id',
        message: `opId '${op.opId}' is used by more than one op`,
        pointer: op.opId,
      })
      continue
    }
    opIds.add(op.opId)
  }

  const slugs = new Set<string>()
  for (const op of bundle.ops) {
    const slug = (op as { slug?: string }).slug
    if (slug === undefined) continue
    if (slugs.has(slug)) {
      issues.push({
        code: 'bundle-duplicate-slug',
        message: `slug '${slug}' is declared by more than one create op`,
        pointer: op.opId,
      })
      continue
    }
    slugs.add(slug)
  }

  for (const op of bundle.ops) {
    for (const slug of collectLocalRefs(op)) {
      if (slugs.has(slug)) continue
      issues.push({
        code: 'bundle-dangling-local-ref',
        message: `op ${op.opId} references local:${slug}, which no create op declares`,
        pointer: op.opId,
      })
    }
  }

  if (bundle.rootRef !== undefined) {
    if (bundle.rootRef.startsWith('local:')) {
      const slug = bundle.rootRef.slice('local:'.length)
      if (!slugs.has(slug)) {
        issues.push({
          code: 'bundle-dangling-root',
          message: `rootRef points at local:${slug}, which no create op declares`,
          pointer: bundle.rootRef,
        })
      }
    } else if (bundle.rootRef.startsWith('builtin:')) {
      // `builtin:<type>/<name>` **自带类型**，不需要 rootType；它也不指向任何 op
      // （built-in 不产 create op），所以既不算悬空、也不缺类型。
    } else if (bundle.rootType === undefined) {
      // external root 不自带类型；receipt 报不出根是什么就等于没有根。
      issues.push({
        code: 'bundle-root-type-missing',
        message: 'an external rootRef requires rootType',
        pointer: bundle.rootRef,
      })
    }
  }

  return issues
}

export const BundleSchema = z
  .object({
    bundleVersion: z.literal(BUNDLE_VERSION),
    /** ⚠️ 允许为空（全 reuse 的包）；上限由 collectBundleRefIssues 报专门错误码。 */
    ops: z.array(BundleOpSchema),
    rootRef: RootRefSchema.optional(),
    /** rootRef 为 external 时必填。 */
    rootType: AclResourceTypeSchema.optional(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    for (const issue of collectBundleRefIssues(bundle)) {
      ctx.addIssue({ code: 'custom', message: `${issue.code}: ${issue.message}` })
    }
  })
export type ResourceBundle = z.infer<typeof BundleSchema>
