// RFC-310 T3 —— Agent outcome envelope（design.md §7.4）。
//
// Agent 的唯一结果通道：named port 上恰好一个 nonce-bound frame。strict schema
// 把 `changedPaths` / `commitSha` / `pushed` / `testsPassed` / `mergeable` 等
// 冒充平台事实的字段一律按 unknown key 拒绝——真实 diff/测试/head 只能由平台
// 采集（§0.3 不变量 4）。outcome payload 按 capability 再收窄（语义校验在
// capability semantic validator，PR-4 T47）。
//
// 实现注记：header 字段被展开进每个 outcome 分支而不是 z.intersection——
// zod 的 intersection 会让两侧 strict 互相把对方的键当 unknown 拒掉。

import { z } from 'zod'

export const AGENT_RESULT_PORT = 'agent-result'

const headerShape = {
  protocolVersion: z.literal(1),
  nonce: z.string().min(16),
  port: z.literal(AGENT_RESULT_PORT),
  actionRunRef: z.string().min(1),
  inputDigest: z.string().min(1),
  capabilityId: z.string().min(1),
} as const

const questions = z
  .array(
    z
      .object({
        questionId: z.string().min(1),
        text: z.string().min(1),
        rationale: z.string().min(1),
      })
      .strict(),
  )
  .min(1)

export const agentChangedResultSchema = z.discriminatedUnion('capabilityId', [
  z
    .object({
      capabilityId: z.literal('change.implement'),
      summary: z.string().min(1),
      requirementCoverage: z
        .array(
          z
            .object({
              itemRef: z.string().min(1),
              disposition: z.enum(['implemented', 'not-applicable']),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      capabilityId: z.literal('mr.feedback.apply'),
      summary: z.string().min(1),
      feedback: z
        .array(
          z
            .object({
              threadRef: z.string().min(1),
              revision: z.string().min(1),
              disposition: z.enum(['addressed', 'needs-human']),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      capabilityId: z.literal('pipeline.repair'),
      summary: z.string().min(1),
      issueRefs: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      capabilityId: z.literal('verification.repair'),
      summary: z.string().min(1),
      failureRefs: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      capabilityId: z.literal('conflict.repair'),
      summary: z.string().min(1),
      conflictRefs: z.array(z.string().min(1)).min(1),
    })
    .strict(),
])

/**
 * RFC-310 PR-5 T54 —— read-only 能力的完成 outcome（§7.4「只读能力有自己的
 * outcome union，不得使用 changed」）。首个成员：requirement.analyze 的
 * RequirementAnalysisResult（§8.2：coverage、经 module catalog 对拍的
 * affectedModuleRefs、scopeDisposition；不含 employee/template id——那是平台
 * route 的职权）。scopeDisposition 只有 ready/already-satisfied-candidate 两
 * 值：需要更多信息时 Agent 必须用 `needs-information` outcome 走问题集闭环，
 * 不许把「不确定」伪装成分析结论（semantic validator 双向锁）。
 */
export const agentReadOnlyResultSchema = z.discriminatedUnion('capabilityId', [
  z
    .object({
      capabilityId: z.literal('requirement.analyze'),
      summary: z.string().min(1),
      requirementCoverage: z
        .array(
          z
            .object({
              itemRef: z.string().min(1),
              disposition: z.enum(['in-scope', 'not-applicable']),
            })
            .strict(),
        )
        .min(1),
      affectedModuleRefs: z.array(z.string().min(1)).max(64),
      scopeDisposition: z.enum(['ready', 'already-satisfied-candidate']),
    })
    .strict(),
  // PR-5 T58 —— change.review：对 immutable candidate snapshot 的结构化审阅。
  // findings 是素材不是裁决（§设计「findings 不能让 Agent 自己决定通过」）：
  // 平台按 closed severity/disposition 与 policy 决定 implement/repair/放行/
  // block。reviewedCandidateRef 必须命中当前 candidateRef（semantic validator
  // 对拍）——陈旧树的审阅整体无效。findings 允许为空（clean review）。
  z
    .object({
      capabilityId: z.literal('change.review'),
      summary: z.string().min(1),
      reviewedCandidateRef: z.string().regex(/^[0-9a-f]{64}$/),
      findings: z
        .array(
          z
            .object({
              findingId: z.string().min(1).max(120),
              path: z.string().min(1).max(500),
              severity: z.enum(['blocker', 'major', 'minor', 'info']),
              disposition: z.enum(['must-fix', 'should-fix', 'note']),
              summary: z.string().min(1).max(2000),
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  z
    .object({
      capabilityId: z.literal('problem.classify'),
      producerId: z.string().min(1).max(120),
      evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
      headSha: z.string().regex(/^[0-9a-f]{40}$/),
      complete: z.boolean(),
      problems: z
        .array(
          z
            .object({
              problemRef: z.string().min(1).max(200),
              typeId: z.string().min(1).max(120),
              subjectRefs: z.array(z.string().min(1).max(500)).min(1).max(200),
              summary: z.string().min(1).max(2_000),
            })
            .strict(),
        )
        .max(500),
    })
    .strict(),
  z
    .object({
      capabilityId: z.literal('approval.prepare'),
      stepRunRef: z.string().min(1),
      approvalType: z.string().min(1).max(120),
      title: z.string().min(1).max(500),
      bodyArtifactRef: z.string().min(1).max(500),
      evidenceRefs: z.array(z.string().min(1).max(500)).max(100),
      requestedScopes: z.array(z.string().min(1).max(200)).max(100),
    })
    .strict(),
])

export const agentOutcomeEnvelopeSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({ ...headerShape, outcome: z.literal('changed'), result: agentChangedResultSchema })
      .strict(),
    z
      .object({
        ...headerShape,
        outcome: z.literal('completed'),
        result: agentReadOnlyResultSchema,
      })
      .strict(),
    z
      .object({
        ...headerShape,
        outcome: z.literal('no-change'),
        result: z.object({ reason: z.string().min(1), summary: z.string().min(1) }).strict(),
      })
      .strict(),
    z
      .object({
        ...headerShape,
        outcome: z.literal('needs-information'),
        result: z.object({ questions }).strict(),
      })
      .strict(),
    z
      .object({
        ...headerShape,
        outcome: z.literal('blocked'),
        result: z.object({ code: z.string().min(1), explanation: z.string().min(1) }).strict(),
      })
      .strict(),
  ])
  // changed 分支的 header.capabilityId 必须与 result.capabilityId 一致，
  // 防止「header 报 A 能力、payload 冒充 B 能力」绕过 per-capability validator。
  .superRefine((value, ctx) => {
    if (
      (value.outcome === 'changed' || value.outcome === 'completed') &&
      value.result.capabilityId !== value.capabilityId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.outcome} result capability '${value.result.capabilityId}' does not match header '${value.capabilityId}'`,
        path: ['result', 'capabilityId'],
      })
    }
  })

export type AgentOutcomeEnvelope = z.infer<typeof agentOutcomeEnvelopeSchema>
