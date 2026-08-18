// RFC-310 T13a —— VerificationProfile 内容 codec（design.md §3.5）。
//
// 本地 build/test 是可执行配置，不能藏在 prompt 或普通 policy string 里：
// 每步一个 program ref + 隔离/超时/成功判据/证据选择。pass 判据是程序化的
// （exit code ∈ successExitCodes），程序 stdout 里的 "passed" 不是事实。
// 修改 programRef/argsRef 需要 `scripts:author`（route 集成层强制，字段级
// 门槛沿 RFC-309 惯例）。verification 在一次性 disposable workspace 执行，
// 写入绝不回流 publication candidate——那是 engine 层合同（PR-5 T57）。

import { z } from 'zod'

import { canonicalDigest } from './canonicalJson'

/** 单步墙钟硬上限：30 分钟。verification 是本地门禁，不是 soak 场。 */
export const VERIFICATION_STEP_TIMEOUT_CAP_MS = 30 * 60 * 1000

const resourceRef = z.string().min(1).max(200)

export const verificationEvidenceSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file-glob'), value: z.string().min(1).max(500) }).strict(),
  z
    .object({ kind: z.literal('stdout-tail'), value: z.number().int().min(1).max(1_000_000) })
    .strict(),
])

export const verificationStepSchema = z
  .object({
    stepId: z.string().min(1).max(120),
    /** 可执行程序引用；写它需要 scripts:author（route 层字段级门）。 */
    programRef: resourceRef,
    argsRef: resourceRef.nullable(),
    timeoutMs: z.number().int().min(1).max(VERIFICATION_STEP_TIMEOUT_CAP_MS),
    networkProfileRef: resourceRef,
    successExitCodes: z.array(z.number().int().min(0).max(255)).min(1).max(16),
    evidenceSelectors: z.array(verificationEvidenceSelectorSchema).max(16),
  })
  .strict()

export const verificationProfileContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    steps: z.array(verificationStepSchema).max(32),
    stopPolicy: z.enum(['first-failure', 'collect-all']),
    maxParallel: z.number().int().min(1).max(8),
  })
  .strict()

export type VerificationProfileContent = z.infer<typeof verificationProfileContentSchema>

export interface VerificationProfilePublishViolation {
  readonly code: 'no-steps' | 'duplicate-step-id'
  readonly detail: string
}

/** publish validator：空 profile 与重复 stepId 都不是可运行门禁。 */
export function validateVerificationProfileForPublish(
  content: VerificationProfileContent,
): VerificationProfilePublishViolation[] {
  const violations: VerificationProfilePublishViolation[] = []
  if (content.steps.length === 0) {
    violations.push({ code: 'no-steps', detail: 'a verification profile needs at least one step' })
  }
  const seen = new Set<string>()
  for (const step of content.steps) {
    if (seen.has(step.stepId)) {
      violations.push({ code: 'duplicate-step-id', detail: step.stepId })
    }
    seen.add(step.stepId)
  }
  return violations
}

export function verificationProfileContentDigest(content: VerificationProfileContent): string {
  return canonicalDigest(content)
}
