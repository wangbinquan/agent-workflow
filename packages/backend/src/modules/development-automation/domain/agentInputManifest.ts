// RFC-310 PR-4 T45 —— AgentInputManifestV1（design.md §7.3）。
//
// Agent 不接收开放 `context: Record<string,unknown>`：每项能力有 exact input
// schema，这里是公共头。所有挂载只有 opaque bundle ref/digest + workspace
// 相对 mount path——主机绝对路径不进 prompt/DB/event（§7.3 尾段）。
// inputDigest 是 content-addressed：对除 `inputDigest` 自身与 `protocol.nonce`
// 之外的全部字段做 canonicalDigest——fresh rerun 换 nonce 不换输入内容
// （§7.7：same B/E/T、new nonce），digest 必须稳定才能作 attempt 对拍键。

import { z } from 'zod'

import { canonicalDigest, type CanonicalJsonValue } from './canonicalJson'
import { agentCapabilityIdSchema } from './capabilityDefinition'
import { repoRelativePathSchema } from './requirementManifest'
import { AGENT_RESULT_PORT } from './agentEnvelope'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex')

/** 只读 evidence 挂载：opaque ref/digest + workspace 相对落点，无 host path。 */
export const readonlyMountDescriptorSchema = z
  .object({
    bundleId: z.string().min(1),
    manifestDigest: sha256,
    mountPath: repoRelativePathSchema,
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict()

export type ReadonlyMountDescriptor = z.infer<typeof readonlyMountDescriptorSchema>

/**
 * 直接上传约束（§7.3）：只含 plan/placement digest 与按 ordinal 排序的落点
 * 语义；不含 expected baseline digest 或 host path。preserve 落点从 write
 * allowlist 扣除、editable 明确允许但不可删除/改 mode——由 workspace
 * validator 强制，这里是给 Agent 看的合同陈述。
 */
export const repositoryUploadConstraintDescriptorSchema = z
  .object({
    planDigest: sha256,
    placementDigest: sha256,
    entries: z
      .array(
        z
          .object({
            ordinal: z.number().int().nonnegative(),
            targetPath: repoRelativePathSchema,
            contentPolicy: z.enum(['preserve-upload', 'agent-editable']),
            fileMode: z.enum(['regular', 'executable']),
            originalEvidenceFileId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sorted = value.entries.every((e, i, arr) => i === 0 || arr[i - 1]!.ordinal < e.ordinal)
    if (!sorted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'entries must be strictly sorted by ordinal',
        path: ['entries'],
      })
    }
  })

export type RepositoryUploadConstraintDescriptor = z.infer<
  typeof repositoryUploadConstraintDescriptorSchema
>

/** feedback 输入闭集：(threadRef, revision) 即语义 validator 的双射基。 */
export const feedbackSnapshotDescriptorSchema = z
  .object({
    snapshotRef: z.string().min(1),
    items: z
      .array(z.object({ threadRef: z.string().min(1), revision: z.string().min(1) }).strict())
      .min(1),
  })
  .strict()

export type FeedbackSnapshotDescriptor = z.infer<typeof feedbackSnapshotDescriptorSchema>

/** verification/pipeline 失败闭集：repair 类 outcome 只能引用这些 ref。 */
export const verificationEvidenceDescriptorSchema = z
  .object({
    bundleRef: z.string().min(1),
    manifestDigest: sha256,
    failureRefs: z.array(z.string().min(1)).min(1),
  })
  .strict()

export type VerificationEvidenceDescriptor = z.infer<typeof verificationEvidenceDescriptorSchema>

/** 受保护逻辑根：给 Agent 的「禁写区」陈述（真实强制在快照对拍侧）。 */
export const logicalRootSchema = z
  .object({ rootId: z.string().min(1), workspacePath: repoRelativePathSchema })
  .strict()

export type LogicalRoot = z.infer<typeof logicalRootSchema>

export const agentInputManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    actionRunRef: z.string().min(1),
    capabilityId: agentCapabilityIdSchema,
    capabilityContractVersion: z.number().int().positive(),
    templateRevision: z.number().int().positive(),
    missionRevision: z.number().int().nonnegative(),
    baseHeadSha: z.string().regex(/^[0-9a-f]{40}$/, 'git sha'),
    inputDigest: sha256,
    requirementBundle: readonlyMountDescriptorSchema.nullable(),
    repositoryUploads: repositoryUploadConstraintDescriptorSchema.nullable(),
    pipelineBundle: readonlyMountDescriptorSchema.nullable(),
    feedbackSnapshot: feedbackSnapshotDescriptorSchema.nullable(),
    verificationEvidence: verificationEvidenceDescriptorSchema.nullable(),
    problemEvidence: z
      .object({
        producerId: z.string().min(1).max(120),
        evidenceDigest: sha256,
        headSha: z.string().regex(/^[0-9a-f]{40}$/),
        allowedTypeIds: z.array(z.string().min(1).max(120)).min(1).max(100),
        subjectRefs: z.array(z.string().min(1).max(500)).min(1).max(500),
        requiredSubjectRefs: z.array(z.string().min(1).max(500)).max(500),
      })
      .strict()
      .optional(),
    approvalContext: z
      .object({
        stepRunRef: z.string().min(1),
        approvalType: z.string().min(1).max(120),
        evidenceRefs: z.array(z.string().min(1).max(500)).max(100),
        requestedScopes: z.array(z.string().min(1).max(200)).max(100),
      })
      .strict()
      .optional(),
    /** repository inspector 归类的可写路径类标签（解析成前缀在平台侧）。 */
    writablePathClasses: z.array(z.string().min(1)),
    protectedRoots: z.array(logicalRootSchema),
    protocol: z
      .object({
        nonce: z.string().min(16),
        port: z.literal(AGENT_RESULT_PORT),
        outcomeSchemaId: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (computeAgentInputDigest(manifest) !== manifest.inputDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inputDigest does not match the manifest content digest',
        path: ['inputDigest'],
      })
    }
  })

export type AgentInputManifestV1 = z.infer<typeof agentInputManifestV1Schema>

/**
 * content-addressed input digest：排除 `inputDigest` 自身与 `protocol.nonce`
 * （nonce 是防伪 token，不是输入内容）。构造方先以 inputDigest 占位任意值
 * 调本函数，再回填。
 */
export function computeAgentInputDigest(
  manifest: Omit<AgentInputManifestV1, 'inputDigest'> & { readonly inputDigest?: string },
): string {
  const { inputDigest: _ignored, protocol, ...rest } = manifest
  return canonicalDigest({
    ...rest,
    protocol: { port: protocol.port, outcomeSchemaId: protocol.outcomeSchemaId },
  } as unknown as CanonicalJsonValue)
}
