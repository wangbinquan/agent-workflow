// RFC-310 T3 —— NextDecision closed union（design.md §4.5）。
//
// 规则解释器唯一的输出形状。这里没有「执行任意 capability」「任意 code-host
// action」「运行某段脚本」：每个 arm 在 actionCatalog（PR-2）映射到一个固定
// handler，新增 arm 必须同步 authority/状态转移/effect/恢复/测试。ref 字段在
// wire 层是 plain string（brand 见 refs.ts；decision 持久化为 canonical JSON）。

import { z } from 'zod'

const ref = z.string().min(1)

export const nextDecisionSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('materialize-direct-requirement'), submissionRef: ref }).strict(),
    z.object({ kind: z.literal('collect-external-requirement'), adapterBindingRef: ref }).strict(),
    z.object({ kind: z.literal('seed-repository-uploads'), uploadPlanRef: ref }).strict(),
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
    z.object({ kind: z.literal('collect-repository-facts') }).strict(),
    z.object({ kind: z.literal('collect-mr-facts') }).strict(),
    z
      .object({
        kind: z.literal('collect-pipeline-evidence'),
        gateKeys: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('run-agent-action'),
        capabilityId: z.string().min(1),
        templateRef: ref,
        workSetRef: ref,
      })
      .strict(),
    z.object({ kind: z.literal('run-verification'), profileRef: ref }).strict(),
    z
      .object({
        kind: z.literal('request-human-decision'),
        gate: z.literal('no-change-confirmation'),
      })
      .strict(),
    z.object({ kind: z.literal('prepare-change-candidate') }).strict(),
    z
      .object({
        kind: z.literal('commit-and-publish-candidate'),
        publicationMode: z.enum(['new-branch', 'fast-forward']),
      })
      .strict(),
    z.object({ kind: z.literal('ensure-merge-request') }).strict(),
    z.object({ kind: z.literal('reply-feedback'), feedbackReceiptRef: ref }).strict(),
    z
      .object({ kind: z.literal('trigger-pipeline'), gateKeys: z.array(z.string().min(1)).min(1) })
      .strict(),
    z
      .object({ kind: z.literal('rerun-pipeline'), gateKey: z.string().min(1), runRef: ref })
      .strict(),
    z.object({ kind: z.literal('publish-readiness') }).strict(),
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
