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

export const agentOutcomeEnvelopeSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({ ...headerShape, outcome: z.literal('changed'), result: agentChangedResultSchema })
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
    if (value.outcome === 'changed' && value.result.capabilityId !== value.capabilityId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `changed result capability '${value.result.capabilityId}' does not match header '${value.capabilityId}'`,
        path: ['result', 'capabilityId'],
      })
    }
  })

export type AgentOutcomeEnvelope = z.infer<typeof agentOutcomeEnvelopeSchema>
