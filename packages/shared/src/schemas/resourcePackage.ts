// RFC-286 F3 —— 资源配置包 preview/commit 的 wire 形状单源（RFC-271 语义）。
//
// 以后端 services/resourcePackage/{parse,preview}.ts 的**实际产出形状**为源：
// PackageRequirements 各字段在后端 parse 层全带 `.default([])`（parse 后数组
// 恒在），因此本响应形状里对应字段**必填**——前端旧手写副本的全-optional 是
// 历史防御写法，随迁清除。后端 preview 返回对象以 `satisfies PackagePreview`
// 接锚（防漂移，RFC-286 AC-3 对拍）；前端 api/resourcePackages.ts 改 import。
//
// `importId` / `previewToken` 幂等语义（随迁自前端 client 头注）：
//   · importId —— commit 幂等键。没有它，commit 成功但响应丢失后重传同一个包
//     会再建一遍资源（服务端每次新生成 id 等于没有幂等）。
//   · previewToken —— 把整套确认基线（候选集 + expect 基线 + human 候选）签死。
//     前端不解读、不重算，只原样回传。

import { z } from 'zod'
import type { PackageSecretRef } from '../bundle/secrets'

export const ResourcePackageTypeSchema = z.enum([
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
])
export type ResourcePackageType = z.infer<typeof ResourcePackageTypeSchema>

export const ImportActionSchema = z.enum(['new', 'reuse', 'overwrite'])
export type ImportAction = z.infer<typeof ImportActionSchema>

// 类型单源是 bundle/secrets 的既有**接口**（resourceType 为宽 string——这是
// 类型层的形状）。wire 上实际值恒为六类 enum：后端 parse.ts 的同名私有 schema
// 用 AclResourceTypeSchema 严格校验后才会产出（勘误：不是「后端真源就是宽
// string」，宽的只是接口形状；此处沿用宽形状仅为复用该接口 + 避免 shared 根
// 双导出歧义，不表示接受任意 resourceType）。
export const PackageSecretRefSchema: z.ZodType<PackageSecretRef> = z.object({
  resourceType: z.string(),
  resourceName: z.string(),
  field: z.string(),
})

export const PackagePreviewCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  expect: z.record(z.string(), z.unknown()),
  owned: z.boolean(),
})
export type PackagePreviewCandidate = z.infer<typeof PackagePreviewCandidateSchema>

export const PackagePreviewEntrySchema = z.object({
  localSlug: z.string(),
  type: ResourcePackageTypeSchema,
  name: z.string(),
  candidates: z.array(PackagePreviewCandidateSchema),
  allowedActions: z.array(ImportActionSchema),
  /** Server-selected safe default. Overwrite is never selected implicitly. */
  defaultAction: ImportActionSchema.nullable(),
  /** Missing permission points when no write action is currently available. */
  missingPermissions: z.array(z.string()),
  /** Credential positions owned by this entry. */
  secretFields: z.array(PackageSecretRefSchema),
  suggestedName: z.string(),
})
export type PackagePreviewEntry = z.infer<typeof PackagePreviewEntrySchema>

export const HumanMemberSlotSchema = z.object({
  workgroupSlug: z.string(),
  username: z.string(),
  displayName: z.string(),
  suggestedUserId: z.string().nullable(),
  required: z.boolean(),
})
export type HumanMemberSlot = z.infer<typeof HumanMemberSlotSchema>

/**
 * 响应形状：字段**必填**（后端 parse 层 `.default([])` 保证 parse 后数组恒在
 * ——RFC-286 设计门定音，前端旧全-optional 副本随迁清除）。
 */
export const PackageRequirementsSchema = z.object({
  runtimes: z.array(z.string()),
  codeHosts: z.array(z.string()),
  executables: z.array(z.string()),
  pluginSources: z.array(z.object({ name: z.string(), spec: z.string(), sourceKind: z.string() })),
  projectSkills: z.array(z.string()),
  mcpKinds: z.array(z.string()),
  humanMembers: z.array(z.string()),
})
export type PackageRequirements = z.infer<typeof PackageRequirementsSchema>

export const PackagePreviewRootSchema = z.object({
  slug: z.string(),
  type: ResourcePackageTypeSchema,
  name: z.string(),
})

export const PackagePreviewSchema = z.object({
  importId: z.string(),
  root: PackagePreviewRootSchema,
  entries: z.array(PackagePreviewEntrySchema),
  humanMembers: z.array(HumanMemberSlotSchema),
  previewToken: z.string(),
  expiresAt: z.number(),
  secrets: z.array(PackageSecretRefSchema),
  requirements: PackageRequirementsSchema,
})
export type PackagePreview = z.infer<typeof PackagePreviewSchema>

export const ImportDecisionSchema = z.object({
  localSlug: z.string(),
  action: ImportActionSchema,
  targetId: z.string().optional(),
  finalName: z.string().optional(),
})
export type ImportDecision = z.infer<typeof ImportDecisionSchema>

export const HumanMemberMappingSchema = z.object({
  workgroupSlug: z.string(),
  username: z.string(),
  userId: z.string().nullable(),
})
export type HumanMemberMapping = z.infer<typeof HumanMemberMappingSchema>

export const PackageSecretInputSchema = z.object({
  resourceType: z.string(),
  resourceName: z.string(),
  field: z.string(),
  value: z.string(),
})
export type PackageSecretInput = z.infer<typeof PackageSecretInputSchema>

export const PackageImportReceiptSchema = z.object({
  journalId: z.string(),
  applied: z.array(
    z.object({
      opId: z.string(),
      resourceType: z.string(),
      resourceId: z.string(),
      action: z.enum(['create', 'update']),
      name: z.string(),
    }),
  ),
  root: z
    .object({
      resourceType: ResourcePackageTypeSchema,
      resourceId: z.string(),
      name: z.string(),
      action: z.enum(['create', 'update', 'reuse']),
    })
    .optional(),
  skippedSecrets: z.array(PackageSecretRefSchema).optional(),
})
export type PackageImportReceipt = z.infer<typeof PackageImportReceiptSchema>
