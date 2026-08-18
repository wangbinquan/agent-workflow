// RFC-310 T20 —— 配置 package 导入/导出 codec（design.md §12.2）。
//
// 导出物是自包含 JSON：immutable revision 内容 + upstream provenance。导入
// 只能 preview/refuse-unknown-version——未知 formatVersion / 未知资源类型 /
// digest 不符都显式拒绝，绝不降级忽略字段（strict codec 保证）。真正落库由
// application 层走各资源的 create/publish 命令（保持 revision/immutable 语义），
// 本文件只负责格式与完整性。

import { z } from 'zod'

import { canonicalDigest } from './canonicalJson'

export const CONFIG_PACKAGE_FORMAT_VERSION = 1

export const configPackageResourceTypeSchema = z.enum([
  'action-template',
  'verification-profile',
  'digital-employee',
  'automation-policy',
  'development-adapter',
])

export type ConfigPackageResourceType = z.infer<typeof configPackageResourceTypeSchema>

const packagedResourceSchema = z
  .object({
    type: configPackageResourceTypeSchema,
    name: z.string().min(1).max(200),
    /** 导出时的 (id, revision)——导入侧作为 upstream provenance 保留，不复用 id。 */
    upstream: z
      .object({
        resourceId: z.string().min(1),
        revision: z.number().int().positive(),
        exportedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    /** 资源内容（各自 domain codec 的 canonical JSON 值）；导入前逐类重校验。 */
    content: z.unknown(),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type PackagedResource = z.infer<typeof packagedResourceSchema>

export const configPackageSchema = z
  .object({
    formatVersion: z.literal(CONFIG_PACKAGE_FORMAT_VERSION),
    exportedAt: z.string().datetime({ offset: true }),
    resources: z.array(packagedResourceSchema).min(1),
  })
  .strict()

export type ConfigPackage = z.infer<typeof configPackageSchema>

export type ConfigPackageIssue =
  | { readonly code: 'unknown-format-version'; readonly observed: unknown }
  | { readonly code: 'malformed'; readonly detail: string }
  | { readonly code: 'digest-mismatch'; readonly resourceName: string }
  | { readonly code: 'duplicate-resource'; readonly resourceName: string }

/**
 * 导入预检：格式、digest、重名。未知 formatVersion 单列 code（UI 提示升级，
 * 不猜字段）。内容级校验（各资源 codec + publish validator）由 application
 * 在 preview 阶段逐条执行。
 */
export function inspectConfigPackage(raw: unknown): {
  readonly pkg: ConfigPackage | null
  readonly issues: readonly ConfigPackageIssue[]
} {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'formatVersion' in raw &&
    (raw as { formatVersion: unknown }).formatVersion !== CONFIG_PACKAGE_FORMAT_VERSION
  ) {
    return {
      pkg: null,
      issues: [
        {
          code: 'unknown-format-version',
          observed: (raw as { formatVersion: unknown }).formatVersion,
        },
      ],
    }
  }
  const parsed = configPackageSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      pkg: null,
      issues: [{ code: 'malformed', detail: parsed.error.issues[0]?.message ?? 'invalid' }],
    }
  }
  const issues: ConfigPackageIssue[] = []
  const seen = new Set<string>()
  for (const resource of parsed.data.resources) {
    const key = `${resource.type}:${resource.name}`
    if (seen.has(key)) issues.push({ code: 'duplicate-resource', resourceName: resource.name })
    seen.add(key)
    if (canonicalDigest(resource.content) !== resource.contentDigest) {
      issues.push({ code: 'digest-mismatch', resourceName: resource.name })
    }
  }
  return { pkg: issues.length === 0 ? parsed.data : null, issues }
}

export function buildConfigPackage(input: {
  readonly exportedAt: string
  readonly resources: readonly {
    readonly type: ConfigPackageResourceType
    readonly name: string
    readonly resourceId: string
    readonly revision: number
    readonly content: unknown
  }[]
}): ConfigPackage {
  return {
    formatVersion: CONFIG_PACKAGE_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    resources: input.resources.map((r) => ({
      type: r.type,
      name: r.name,
      upstream: { resourceId: r.resourceId, revision: r.revision, exportedAt: input.exportedAt },
      content: r.content,
      contentDigest: canonicalDigest(r.content),
    })),
  }
}
