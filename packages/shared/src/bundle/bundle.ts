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
import { AclResourceTypeSchema, type AclResourceType } from '../schemas/resourceAcl'
import { decodeBundleIdentityRef } from '../ref/codecs'
import { BUNDLE_MAX_OPS, BundleOpSchema, type BundleOp } from './op'
import { BundleIdentityRefWireSchema } from './payload'

export const BUNDLE_VERSION = 1

// Root 是 identity 域的一个槽，不再拷贝第二份正则。这也锁住 built-in 根与
// payload 内 built-in 引用共用同一个 codec/schema 词法面。
const RootRefSchema = BundleIdentityRefWireSchema

export interface BundleRefIssue {
  code:
    | 'bundle-duplicate-op-id'
    | 'bundle-duplicate-slug'
    | 'bundle-dangling-local-ref'
    | 'bundle-local-ref-type-mismatch'
    | 'bundle-dangling-root'
    | 'bundle-builtin-root-not-supported'
    | 'bundle-root-type-missing'
    | 'bundle-too-many-ops'
  message: string
  /** 出问题的 opId / slug，供 UI 定位。 */
  pointer?: string
}

interface LocalRefUse {
  slug: string
  expectedType: AclResourceType
}

function resourceTypeOfBundleOp(op: BundleOp): AclResourceType {
  switch (op.kind) {
    case 'agent-create':
    case 'agent-update':
      return 'agent'
    case 'skill-create':
    case 'skill-update':
      return 'skill'
    case 'mcp-create':
    case 'mcp-update':
      return 'mcp'
    case 'plugin-create':
    case 'plugin-update':
      return 'plugin'
    case 'workflow-create':
    case 'workflow-update':
      return 'workflow'
    case 'workgroup-create':
    case 'workgroup-update':
      return 'workgroup'
  }
}

/** 收集 bundle 内所有 `local:` 引用，并保留槽位期待的资源类型。 */
function collectLocalRefs(op: BundleOp): LocalRefUse[] {
  const out: LocalRefUse[] = []
  const push = (wire: unknown, expectedType: AclResourceType): void => {
    if (typeof wire !== 'string') return
    const decoded = decodeBundleIdentityRef(wire)
    if (decoded?.k === 'local') out.push({ slug: decoded.slug, expectedType })
  }
  const p = op.payload as Record<string, unknown>
  if (op.kind === 'agent-create' || op.kind === 'agent-update') {
    const slots = [
      ['skills', 'skill'],
      ['dependsOn', 'agent'],
      ['mcp', 'mcp'],
      ['plugins', 'plugin'],
    ] as const
    for (const [key, type] of slots) {
      const arr = p[key]
      if (Array.isArray(arr)) for (const item of arr) push(item, type)
    }
  }
  if (op.kind === 'workgroup-create' || op.kind === 'workgroup-update') {
    const members = p.members
    if (Array.isArray(members)) {
      for (const m of members) {
        if (typeof m === 'object' && m !== null) {
          push((m as Record<string, unknown>).agentRef, 'agent')
        }
      }
    }
  }
  // 工作流 definition 里的引用槽（agentRef / call 目标）已在 lowering 时写成 wire。
  const definition =
    op.kind === 'workflow-create' || op.kind === 'workflow-update' ? p.definition : undefined
  if (typeof definition === 'object' && definition !== null && !Array.isArray(definition)) {
    const nodes = (definition as Record<string, unknown>).nodes
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (typeof n !== 'object' || n === null) continue
        const rec = n as Record<string, unknown>
        push(rec.agentRef, 'agent')
        // ⚠️ call 目标的实际字段是 `workflowRef` / `workgroupRef`（见 serialize 的
        // lifting）。这里曾写 `targetRef` —— 一个**根本不存在的字段**，于是 call 槽的
        // `local:` 引用从来没被闭合性校验扫到过：一个引用了包内子工作流、而该子工作流
        // 又没有 create op 的包，能一路过 schema 到 apply 才炸。
        push(rec.workflowRef, 'workflow')
        push(rec.workgroupRef, 'workgroup')
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

  const slugs = new Map<string, { type: AclResourceType; opId: string }>()
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
    slugs.set(slug, { type: resourceTypeOfBundleOp(op), opId: op.opId })
  }

  for (const op of bundle.ops) {
    for (const ref of collectLocalRefs(op)) {
      const target = slugs.get(ref.slug)
      if (target === undefined) {
        issues.push({
          code: 'bundle-dangling-local-ref',
          message: `op ${op.opId} references local:${ref.slug}, which no create op declares`,
          pointer: op.opId,
        })
        continue
      }
      if (target.type !== ref.expectedType) {
        issues.push({
          code: 'bundle-local-ref-type-mismatch',
          message: `op ${op.opId} uses local:${ref.slug} as ${ref.expectedType}, but ${target.opId} declares ${target.type}`,
          pointer: op.opId,
        })
      }
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
      // built-in **不能自己当根**。导出侧已在 `walkExportClosure` 422 拦下，所以诚实
      // 产出的包不会有这种根；这里挡的是手工构造 / 被篡改的包。
      //
      // 必须给它一个**自己的** code：落进下面「external root 缺 rootType」那支会报出
      // 一条与病因无关的错（builtin 自带类型，加 rootType 也修不好），让人往错的方向查。
      issues.push({
        code: 'bundle-builtin-root-not-supported',
        message:
          'a builtin resource cannot be the package root; export a resource that references it instead',
        pointer: bundle.rootRef,
      })
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
