// RFC-310 T3 —— PipelineEvidenceManifestV1（design.md §6.3）。
//
// 自建门禁的采集结果：exact head/target 绑定 + 多 gate + 完整性显式声明。
// `unknown/partial/unavailable` 永不折算 pass（readiness 固定算法 §2.4）。
// 大日志只在 evidence 文件区；manifest 只携带 descriptor 与 digest。

import { z } from 'zod'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex')
const gitSha = z.string().regex(/^[0-9a-f]{40}$/, 'git sha')

export const gateStatusSchema = z.enum([
  'queued',
  'running',
  'pass',
  'fail',
  'canceled',
  'skipped',
  'unknown',
  'unavailable',
])

export type GateStatus = z.infer<typeof gateStatusSchema>

export const evidenceFileDescriptorSchema = z
  .object({
    fileId: z.string().min(1),
    relativePath: z.string().min(1),
    mediaType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256,
    redaction: z.enum(['none', 'applied', 'failed']),
  })
  .strict()

export const pipelineEvidenceManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bundleId: z.string().min(1),
    providerKey: z.string().min(1),
    headSha: gitSha,
    targetSha: gitSha,
    completeness: z.enum(['complete', 'partial']),
    gates: z.array(
      z
        .object({
          gateKey: z.string().min(1),
          required: z.boolean(),
          status: gateStatusSchema,
          runRef: z.string().min(1),
          attempt: z.number().int().positive(),
          finishedAt: z.string().datetime({ offset: true }).nullable(),
          retryability: z.enum(['safe', 'unsafe', 'unknown']),
          failureCategories: z.array(z.string().min(1)),
          evidenceFileIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    files: z.array(evidenceFileDescriptorSchema),
    totals: z
      .object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
      .strict(),
    redaction: z.enum(['complete', 'failed']),
    manifestDigest: sha256,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const fileIds = new Set(manifest.files.map((f) => f.fileId))
    manifest.gates.forEach((gate, gateIndex) => {
      gate.evidenceFileIds.forEach((id, idIndex) => {
        if (!fileIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `gate '${gate.gateKey}' references missing evidence file '${id}'`,
            path: ['gates', gateIndex, 'evidenceFileIds', idIndex],
          })
        }
      })
    })
    if (manifest.totals.files !== manifest.files.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `totals.files=${manifest.totals.files} but files.length=${manifest.files.length}`,
        path: ['totals', 'files'],
      })
    }
  })

export type PipelineEvidenceManifestV1 = z.infer<typeof pipelineEvidenceManifestV1Schema>

/** readiness 固定判据（§2.4/§6.3）：只有明确 pass 才算 pass。 */
export function gateCountsAsPass(status: GateStatus): boolean {
  return status === 'pass'
}
