// RFC-310 T3 —— NextDecision closed union（design.md §4.5）。
//
// 规则解释器唯一的输出形状。这里没有「执行任意 capability」「任意 code-host
// action」「运行某段脚本」：每个 arm 在 actionCatalog（PR-2）映射到一个固定
// handler，新增 arm 必须同步 authority/状态转移/effect/恢复/测试。ref 字段在
// wire 层是 plain string（brand 见 refs.ts；decision 持久化为 canonical JSON）。

import { z } from 'zod'

const ref = z.string().min(1)
const stepRunRef = { stepRunRef: ref.optional() } as const

export const nextDecisionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('materialize-direct-requirement'),
        submissionRef: ref,
        ...stepRunRef,
      })
      .strict(),
    z
      .object({
        kind: z.literal('collect-external-requirement'),
        adapterBindingRef: ref,
        ...stepRunRef,
      })
      .strict(),
    z
      .object({ kind: z.literal('seed-repository-uploads'), uploadPlanRef: ref, ...stepRunRef })
      .strict(),
    z
      .object({
        kind: z.literal('publish-requirement-questions'),
        questionSetRef: ref,
        channel: z.enum(['platform', 'requirement-source']),
      })
      .strict(),
    z
      .object({
        kind: z.literal('collect-requirement-answers'),
        questionSetRef: ref,
        adapterBindingRef: ref,
      })
      .strict(),
    z.object({ kind: z.literal('collect-repository-facts'), ...stepRunRef }).strict(),
    z.object({ kind: z.literal('collect-mr-facts'), ...stepRunRef }).strict(),
    z
      .object({
        kind: z.literal('collect-pipeline-evidence'),
        gateKeys: z.array(z.string().min(1)).min(1),
        ...stepRunRef,
      })
      .strict(),
    z
      .object({
        kind: z.literal('run-agent-action'),
        capabilityId: z.string().min(1),
        templateRef: ref,
        workSetRef: ref,
        problemInput: z
          .object({
            producerId: z.string().min(1).max(120),
            evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
            headSha: z.string().regex(/^[0-9a-f]{40}$/),
            allowedTypeIds: z.array(z.string().min(1).max(120)).min(1).max(100),
            subjectRefs: z.array(ref).min(1).max(500),
            requiredSubjectRefs: z.array(ref).max(500),
          })
          .strict()
          .optional(),
        approvalInput: z
          .object({
            stepRunRef: ref,
            approvalType: z.string().min(1).max(120),
            evidenceRefs: z.array(ref).max(100),
            requestedScopes: z.array(z.string().min(1).max(200)).max(100),
          })
          .strict()
          .optional(),
        retryBudget: z
          .object({
            sameSession: z.number().int().min(0).max(10),
            freshSession: z.number().int().min(0).max(5),
          })
          .strict()
          .optional(),
        ...stepRunRef,
      })
      .strict(),
    z.object({ kind: z.literal('run-verification'), profileRef: ref, ...stepRunRef }).strict(),
    z
      .object({
        kind: z.literal('invoke-child-mission'),
        stepRunRef: ref,
        targetRepositoryRef: ref,
        targetEmployeeRef: z.object({ id: ref, revision: z.number().int().positive() }).strict(),
        inputEnvelopeRef: ref,
        completion: z.enum(['automation-ready', 'ready-to-merge', 'merged', 'completed']),
        deadlineAt: z.string().datetime({ offset: true }),
        idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
        ancestry: z.array(ref).max(8),
      })
      .strict(),
    z
      .object({
        kind: z.literal('submit-approval'),
        stepRunRef: ref,
        adapterRef: z.object({ id: ref, revision: z.number().int().positive() }).strict(),
        validatedDraftRef: ref,
        deadlineAt: z.string().datetime({ offset: true }),
        idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal('observe-approval'),
        stepRunRef: ref,
        approvalSagaRef: ref,
        pollIntervalMs: z.number().int().min(5_000),
      })
      .strict(),
    z
      .object({
        kind: z.literal('request-human-decision'),
        gate: z.literal('no-change-confirmation'),
      })
      .strict(),
    z.object({ kind: z.literal('prepare-change-candidate'), ...stepRunRef }).strict(),
    z
      .object({
        kind: z.literal('commit-and-publish-candidate'),
        publicationMode: z.enum(['new-branch', 'fast-forward']),
        ...stepRunRef,
      })
      .strict(),
    z.object({ kind: z.literal('ensure-merge-request'), ...stepRunRef }).strict(),
    z.object({ kind: z.literal('reply-feedback'), feedbackReceiptRef: ref }).strict(),
    z
      .object({
        kind: z.literal('trigger-pipeline'),
        gateKeys: z.array(z.string().min(1)).min(1),
        ...stepRunRef,
      })
      .strict(),
    z
      .object({
        kind: z.literal('rerun-pipeline'),
        gateKey: z.string().min(1),
        runRef: ref,
        ...stepRunRef,
      })
      .strict(),
    z.object({ kind: z.literal('publish-readiness'), ...stepRunRef }).strict(),
    z
      .object({
        kind: z.literal('wait'),
        reason: z.string().min(1),
        resumeAt: z.string().datetime({ offset: true }).nullable(),
        wakeSources: z
          .array(z.enum(['webhook', 'pipeline', 'requirement', 'timer', 'manual']))
          .min(0),
        attemptOrdinal: z.number().int().nonnegative(),
      })
      .strict(),
    z.object({ kind: z.literal('handoff'), reason: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('mark-ready-to-merge') }).strict(),
    z
      .object({
        kind: z.literal('mark-terminal'),
        terminal: z.enum(['merged', 'closed-unmerged', 'completed-no-change', 'canceled']),
      })
      .strict(),
    z.object({ kind: z.literal('block'), reason: z.string().min(1) }).strict(),
  ])
  // design §4.8：wait 必须有 resumeAt 或至少一个真实外部 wake source，两者都
  // 没有的 decision 在 publish 时拒绝（zod3 的 discriminatedUnion 成员不能带
  // refine，所以这条挂在 union 级）。
  .superRefine((value, ctx) => {
    if (value.kind === 'wait' && value.resumeAt === null && value.wakeSources.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wait decision needs resumeAt or at least one wake source',
        path: ['wakeSources'],
      })
    }
  })

export type NextDecision = z.infer<typeof nextDecisionSchema>
