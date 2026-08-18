// RFC-310 T13 —— ActionTemplate 内容 codec（design.md §3.4）。
//
// 模板是「某项 Agent 能力的具体实现」（java-spring@3 这种），只能配置实现面：
// executor/prompt supplement/知识与验证引用/重试默认。能力的 schema、阶段、
// workspace mode、Git/代码托管权限、semantic validator、下一动作在
// CapabilityDefinition 里锁死，模板无字段可覆盖——这里根本不存在那些键，
// strict schema 会把任何伪装成配置的越权键当 unknown key 拒绝。
// `compatibility` 是无顺序、只会拒绝不兼容选择的约束，不参与「选哪份模板」
// ——唯一 selector 是 DigitalEmployee 的 CapabilityRoute（§3.4/§3.6）。

import { z } from 'zod'

import { POLICY_HARD_CAPS } from './automationPolicy'
import { canonicalDigest } from './canonicalJson'
import { agentCapabilityIdSchema } from './capabilityDefinition'
import { checkPredicateAgainstCatalog, type DecisionPhase } from './facts'
import { checkPredicateBudget, factPredicateSchema } from './predicate'

const resourceRef = z.string().min(1).max(200)

export const actionTemplateContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilityId: agentCapabilityIdSchema,
    capabilityContractVersion: z.number().int().positive(),
    labels: z.array(z.string().min(1).max(80)).max(20),
    /** 只拒绝不兼容选择，不做第二 selector（route 发布时证明 when ⇒ compatibility）。 */
    compatibility: z.array(factPredicateSchema).max(16),
    executor: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('agent'), agentRef: resourceRef }).strict(),
      z.object({ kind: z.literal('workgroup'), workgroupRef: resourceRef }).strict(),
    ]),
    runtimeProfileRef: resourceRef,
    /** 领域知识补充；放在不可覆盖 protocol block 之前，不能改变运行合同（§3.4）。 */
    promptSupplement: z.string().max(20_000),
    skillRefs: z.array(resourceRef).max(32),
    mcpRefs: z.array(resourceRef).max(32),
    readOnlyResourceRefs: z.array(resourceRef).max(32),
    contextProfileRef: resourceRef.nullable(),
    /** 只能收窄 capability workspace mode；打开 Git/evidence roots 在 validator 层拒。 */
    writablePathPolicyRef: resourceRef.nullable(),
    additionalProtectedPathClasses: z.array(z.string().min(1).max(120)).max(32),
    verificationProfileRef: resourceRef,
    retryDefaults: z
      .object({
        sameSession: z.number().int().min(0).max(POLICY_HARD_CAPS.sameSessionRetries),
        freshSession: z.number().int().min(0).max(POLICY_HARD_CAPS.freshSessionReruns),
      })
      .strict(),
  })
  .strict()

export type ActionTemplateContent = z.infer<typeof actionTemplateContentSchema>

export interface ActionTemplatePublishViolation {
  readonly code: 'compatibility-predicate-invalid' | 'compatibility-predicate-budget'
  readonly detail: string
}

const COMPATIBILITY_PHASE: DecisionPhase = 'action-decision'

/** publish validator：schema 之外的目录/预算交叉检查。 */
export function validateActionTemplateForPublish(
  content: ActionTemplateContent,
): ActionTemplatePublishViolation[] {
  const violations: ActionTemplatePublishViolation[] = []
  for (const predicate of content.compatibility) {
    for (const v of checkPredicateAgainstCatalog(predicate, COMPATIBILITY_PHASE)) {
      violations.push({
        code: 'compatibility-predicate-invalid',
        detail: `${v.code}:${v.factId}`,
      })
    }
    for (const v of checkPredicateBudget(predicate)) {
      violations.push({ code: 'compatibility-predicate-budget', detail: v.code })
    }
  }
  return violations
}

export function actionTemplateContentDigest(content: ActionTemplateContent): string {
  return canonicalDigest(content)
}
