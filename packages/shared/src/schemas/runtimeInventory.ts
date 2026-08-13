// RFC-297 T1/T2 —— 跨运行时统一的「运行时清单」契约。
//
// 起因（用户实证）：Claude Code 运行时下前台「运行时清单」恒显示「未生成清单
// 文件（插件可能加载失败）」——那条读面（RFC-029）从设计上就是 opencode dump
// 插件专属的，claude 的 `system/init` 清单虽已被正确解析，却只流向了启动验证。
//
// 本模块是纯数据：类型 + zod + 纯函数，零 I/O。运行时侧的观测由各 driver
// 规范化成 `startup_inventory` 事件（载荷即 `RuntimeInventoryPayload`），再由
// 运行时无关的 pipeline stage 与平台声明清单对账，产出 `InventoryEntry`。
//
// 设计要点：
//  · 面（face）与字段（field）是**封闭联合**，driver 逐项静态表态；新增面或新增
//    字段会让任何未表态的 driver 编译报错（与 RFC-282 `declarationFaces` 同构）。
//  · 条目的富字段全部可选：缺失 = 该运行时不提供（declaration 说明是协议没有
//    还是观测不到），null = 提供该字段但本条目无值。
//  · 「无观测」绝不投影为「未加载」——见 `assembleFace` 对 observed===undefined
//    的处理，与 backend `verifyStartup` 的 missing 语义严格同源。

import { z } from 'zod'

// ---------------------------------------------------------------------------
// 表态三态
// ---------------------------------------------------------------------------

/**
 * 一个能力面/字段在某运行时上的状态。语义与 RFC-282 的同名类型一致，权威定义
 * 迁至 shared 以便前端按它选列；backend `services/runtime/types.ts` 再导出。
 */
export const FaceSupportSchema = z.enum([
  'supported', // 该运行时有此概念，且能被观测到
  'unsupported', // 协议上就没有这个概念（如 claude × plugin）
  'unobservable', // 平台会注入，但运行时不报告（无法验证是否生效）
])
export type FaceSupport = z.infer<typeof FaceSupportSchema>

// ---------------------------------------------------------------------------
// 面与字段
// ---------------------------------------------------------------------------

export const INVENTORY_FACES = ['agents', 'skills', 'mcps', 'plugins', 'tools'] as const
export const InventoryFaceSchema = z.enum(INVENTORY_FACES)
export type InventoryFace = z.infer<typeof InventoryFaceSchema>

/**
 * 每个面下可能出现的富字段。`tools` 只有名字，故为 `never`（其表态 Record 为空
 * 对象，合法）。新增字段 = 对应面的 Record 缺键 = 每个 driver 编译报错。
 */
export interface InventoryFieldsByFace {
  agents: 'mode' | 'model' | 'source'
  skills: 'source' | 'path' | 'description'
  mcps: 'status' | 'type' | 'hint'
  plugins: 'source'
  tools: never
}

/**
 * 每面字段集的**运行时**投影，与上面的类型同源（`satisfies` 保证二者不会分叉）。
 * 存在的理由：`InventoryFieldsByFace` 是纯类型，编译期棘轮拦得住老实实现，却拦
 * 不住 `as` 断言绕过；测试需要一个值来逐 driver 核对「表态覆盖了这一面的全部
 * 字段」。
 */
export const INVENTORY_FIELDS_BY_FACE = {
  agents: ['mode', 'model', 'source'],
  skills: ['source', 'path', 'description'],
  mcps: ['status', 'type', 'hint'],
  plugins: ['source'],
  tools: [],
} as const satisfies { readonly [F in InventoryFace]: readonly InventoryFieldsByFace[F][] }

/** driver 的静态声明：面级 + 字段级逐项表态。 */
export type InventoryDeclaration = {
  readonly [F in InventoryFace]: {
    readonly support: FaceSupport
    readonly fields: Readonly<Record<InventoryFieldsByFace[F], FaceSupport>>
  }
}

/**
 * 平台声明清单（`DeclaredManifestV1`）里与各面对应的键名。两侧命名不同形
 * （`agents↔subagents`、`mcps↔mcpServers`），必须单点定义——散在调用点上迟早
 * 对错一处，而对错的后果是「已注入」被显示成「运行时自带」。
 */
export const INVENTORY_FACE_TO_DECLARED_KEY = {
  agents: 'subagents',
  skills: 'skills',
  mcps: 'mcpServers',
  plugins: 'plugins',
  tools: 'tools',
} as const satisfies Readonly<Record<InventoryFace, string>>

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

/**
 * 运行时报告的一条资源，尚未与平台声明对账。字符串字段一律保持运行时原文
 * （status / mode / source / type…），不在 schema 层收窄——运行时迭代快，UI 有
 * 未知值兜底渲染。
 */
export const ObservedInventoryItemSchema = z.object({
  /** 面内唯一键：plugins 用 specifier，其余用 name。 */
  key: z.string(),
  /** 展示名（plugins 即 specifier）。 */
  name: z.string(),
  mode: z.string().nullable().optional(),
  modelProviderId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
})
export type ObservedInventoryItem = z.infer<typeof ObservedInventoryItemSchema>

export const InventoryProvenanceSchema = z.enum([
  'injected', // 平台声明注入 ∩ 运行时报告已加载
  'ambient', // 运行时报告了，但平台没注入（内建 / 机器或项目配置继承）
  'declared-missing', // 平台声明注入了，运行时没报告——与告警 banner 的 missing 同源
])
export type InventoryProvenance = z.infer<typeof InventoryProvenanceSchema>

export const InventoryEntrySchema = ObservedInventoryItemSchema.extend({
  provenance: InventoryProvenanceSchema,
})
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>

// ---------------------------------------------------------------------------
// 面集合：显式五键，全可选（缺席 = 该运行时本轮未报告此面）
// ---------------------------------------------------------------------------

type ObservedFacesShape = { readonly [F in InventoryFace]: z.ZodOptional<z.ZodArray<z.ZodTypeAny>> }
type EntryFacesShape = { readonly [F in InventoryFace]: z.ZodOptional<z.ZodArray<z.ZodTypeAny>> }

const observedFacesShape = {
  agents: z.array(ObservedInventoryItemSchema).optional(),
  skills: z.array(ObservedInventoryItemSchema).optional(),
  mcps: z.array(ObservedInventoryItemSchema).optional(),
  plugins: z.array(ObservedInventoryItemSchema).optional(),
  tools: z.array(ObservedInventoryItemSchema).optional(),
} satisfies ObservedFacesShape

const entryFacesShape = {
  agents: z.array(InventoryEntrySchema).optional(),
  skills: z.array(InventoryEntrySchema).optional(),
  mcps: z.array(InventoryEntrySchema).optional(),
  plugins: z.array(InventoryEntrySchema).optional(),
  tools: z.array(InventoryEntrySchema).optional(),
} satisfies EntryFacesShape

export const ObservedInventoryFacesSchema = z.object(observedFacesShape)
export type ObservedInventoryFaces = z.infer<typeof ObservedInventoryFacesSchema>

export const InventoryFacesSchema = z.object(entryFacesShape)
export type InventoryFaces = z.infer<typeof InventoryFacesSchema>

/**
 * driver 规范化出的 `startup_inventory` 事件载荷：本运行时报告了什么。
 * 对账（provenance）不在此发生——那是运行时无关的 stage 的事。
 */
export const RuntimeInventoryPayloadSchema = z.object({
  faces: ObservedInventoryFacesSchema,
})
export type RuntimeInventoryPayload = z.infer<typeof RuntimeInventoryPayloadSchema>

// ---------------------------------------------------------------------------
// 观测结果（落 node_runs.runtime_inventory_json）
// ---------------------------------------------------------------------------

export const RuntimeInventoryObservationSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('captured'),
    capturedAt: z.number().int(),
    faces: InventoryFacesSchema,
    /**
     * 存量转码专用：该行没有留下平台声明清单，来源对账无从计算（全部记为
     * ambient）。前端据此隐藏来源列，而不是显示一整列错值。
     */
    provenanceUnavailable: z.boolean().optional(),
  }),
  /** 本轮按设计就不产生观测（opencode followup 复用会话）——正常状态，不告警。 */
  z.object({ state: z.literal('not-produced'), reason: z.string() }),
  /** 观测源应该在却缺失。 */
  z.object({ state: z.literal('unavailable'), reason: z.string() }),
  /** 观测源在但坏了。 */
  z.object({ state: z.literal('malformed'), reason: z.string() }),
])
export type RuntimeInventoryObservation = z.infer<typeof RuntimeInventoryObservationSchema>

/** `GET /api/tasks/:id/node-runs/:nodeRunId/inventory` 的响应。 */
export const RuntimeInventoryResponseSchema = z.object({
  observation: RuntimeInventoryObservationSchema,
  /** 本 run 所用运行时的静态表态——前端据此选列，不在前端硬编码运行时名字。 */
  declaration: z.custom<InventoryDeclaration>(),
})
export type RuntimeInventoryResponse = z.infer<typeof RuntimeInventoryResponseSchema>

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 声明了却没被观测到的名字。
 *
 * `observed === undefined` 表示**该面根本没有观测**（运行时不报告这一类），此时
 * 返回空——「无法证明它到场」不等于「它没到场」。RFC-297 T3：backend 的
 * `verifyStartup` 与本模块的 `assembleFace` 共用这一个实现，杜绝两处判定漂移。
 */
export function missingDeclared(
  declared: readonly string[],
  observed: readonly string[] | undefined,
): string[] {
  if (observed === undefined) return []
  const seen = new Set(observed)
  return declared.filter((name) => !seen.has(name))
}

/**
 * 一个面的观测 × 声明 → 带来源对账的条目表。
 *
 * - observed 中出现在 declared 里的 → `injected`
 * - observed 中不在 declared 里的   → `ambient`（运行时内建 / 机器或项目配置继承）
 * - declared 中未被 observed 报告的 → 合成一条 `declared-missing`
 * - `observed === undefined`（该面无观测）→ 不产出任何条目，**也不产出 missing**
 * - `declared === null`（如 tools 未被约束）→ 全部 `ambient`，不产出 missing
 *
 * 输出按 key 字典序稳定排序，便于快照断言与 UI 稳定渲染。
 */
export function assembleFace(
  observed: readonly ObservedInventoryItem[] | undefined,
  declared: readonly string[] | null,
): InventoryEntry[] {
  if (observed === undefined) return []
  const declaredSet = declared === null ? null : new Set(declared)
  const entries: InventoryEntry[] = observed.map((item) => ({
    ...item,
    provenance:
      declaredSet !== null && declaredSet.has(item.key)
        ? ('injected' as const)
        : ('ambient' as const),
  }))
  if (declared !== null) {
    for (const name of missingDeclared(
      declared,
      observed.map((i) => i.key),
    )) {
      entries.push({ key: name, name, provenance: 'declared-missing' })
    }
  }
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 面的表态是否意味着「这一面根本不该出现在界面上」。 */
export function faceIsRenderable(declaration: InventoryDeclaration, face: InventoryFace): boolean {
  return declaration[face].support !== 'unsupported'
}

/** 某个面下应当渲染的字段集（`unsupported` 的字段不出列）。 */
export function renderableFields<F extends InventoryFace>(
  declaration: InventoryDeclaration,
  face: F,
): InventoryFieldsByFace[F][] {
  const fields = declaration[face].fields as Readonly<Record<string, FaceSupport>>
  return Object.keys(fields).filter(
    (key) => fields[key] !== 'unsupported',
  ) as InventoryFieldsByFace[F][]
}
