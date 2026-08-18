// RFC-310 T3 —— RequirementBundleManifestV1（design.md §5.3）。
//
// 平台生成、按 `ordinal,fileId` 稳定排序的不可变 manifest。大正文永远留在
// evidence 文件里；DB/prompt 只持 ref 与 digest。repositoryPlacement 是直接
// 上传文件的只读落点说明（targetPath + contentPolicy）；碰撞前提与 baseline
// digest 不进 manifest——那属于 RepositoryUploadPlan（平台 validator 侧）。

import { z } from 'zod'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex')

/** 仓库相对路径（规范化后）：无绝对、无 `..`、无空段、无 NUL。 */
export const repoRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\0') &&
      !/^[a-zA-Z]:[\\/]/.test(p) &&
      p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..'),
    { message: 'must be a normalized repo-relative path' },
  )

export const requirementBundleManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bundleId: z.string().min(1),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('direct'), submissionId: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal('external'),
          sourceKey: z.string().min(1),
          externalId: z.string().min(1),
          sourceRevision: z.string().min(1),
        })
        .strict(),
    ]),
    title: z.string().min(1),
    fetchedAt: z.string().datetime({ offset: true }),
    complete: z.boolean(),
    files: z.array(
      z
        .object({
          fileId: z.string().min(1),
          ordinal: z.number().int().nonnegative(),
          relativePath: z.string().min(1),
          role: z.string().min(1),
          mediaType: z.string().min(1),
          bytes: z.number().int().nonnegative(),
          sha256,
          redaction: z.enum(['none', 'applied', 'failed']),
          repositoryPlacement: z
            .object({
              targetPath: repoRelativePathSchema,
              contentPolicy: z.enum(['preserve-upload', 'agent-editable']),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    totals: z
      .object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
      .strict(),
    writebackRef: z.string().min(1).nullable(),
    manifestDigest: sha256,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const sorted = [...manifest.files].every(
      (file, i, arr) =>
        i === 0 ||
        arr[i - 1]!.ordinal < file.ordinal ||
        (arr[i - 1]!.ordinal === file.ordinal && arr[i - 1]!.fileId < file.fileId),
    )
    if (!sorted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'files must be stably sorted by (ordinal, fileId)',
        path: ['files'],
      })
    }
    if (manifest.totals.files !== manifest.files.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `totals.files=${manifest.totals.files} but files.length=${manifest.files.length}`,
        path: ['totals', 'files'],
      })
    }
  })

export type RequirementBundleManifestV1 = z.infer<typeof requirementBundleManifestV1Schema>
