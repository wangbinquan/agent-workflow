// RFC-310 T15 —— AutomationPolicy closed schema（design.md §3.7，proposal §6.3）。
//
// policy 是多个各自有 closed schema 的 rule group，不是可执行 DSL：predicate
// 只能是 typed AST（predicate.ts），预算都有产品硬上限（不可配置为无限，
// `0` 是显式禁用）。publish 产 immutable revision + canonical digest；运行时
// 使用完整 pinned revision，不做「员工默认 + repo override」逐字段动态 merge。
// 固定安全条件（no-merge/no-approve/unknown-not-pass/no-force-push）不在本
// schema 的配置面里——它们是产品宪法（proposal §2.5/§6.4），无处可关。

import { z } from 'zod'

import { canonicalDigest } from './canonicalJson'
import { agentCapabilityIdSchema } from './capabilityDefinition'
import { checkPredicateAgainstCatalog, type DecisionPhase } from './facts'
import { checkPredicateBudget, factPredicateSchema } from './predicate'
import { repoRelativePathSchema } from './requirementManifest'

// ------------------------------------------------------------ hard caps

/** 产品硬上限：任何 policy 值都不得超过（publish validator 强制）。 */
export const POLICY_HARD_CAPS = {
  sameSessionRetries: 5,
  freshSessionReruns: 3,
  actionRunsPerMission: 200,
  pipelineRerunsPerGate: 10,
  pipelineTriggersPerGate: 10,
  commitsPerMission: 100,
  missionWallTimeMs: 30 * 24 * 60 * 60 * 1000,
  clarificationRounds: 10,
  feedbackBatchLimit: 50,
  conflictRepairAttempts: 5,
  uploadMaxFiles: 100,
  uploadMaxFileBytes: 512 * 1024 * 1024,
  uploadMaxTotalBytes: 2 * 1024 * 1024 * 1024,
  retentionDays: 3650,
} as const

const bounded = (cap: number) => z.number().int().min(0).max(cap)
const ruleId = z.string().min(1).max(120)

// ------------------------------------------------------------ rule groups

export const admissionPolicySchema = z
  .object({
    allowedSubmissionKinds: z.array(z.enum(['direct', 'external-reference'])).min(1),
    duplicateExternalIdDisposition: z.enum(['reuse-active', 'new-generation', 'reject']),
  })
  .strict()

export const repositoryUploadPolicySchema = z
  .object({
    maxFiles: bounded(POLICY_HARD_CAPS.uploadMaxFiles),
    maxFileBytes: bounded(POLICY_HARD_CAPS.uploadMaxFileBytes),
    maxTotalBytes: bounded(POLICY_HARD_CAPS.uploadMaxTotalBytes),
    /** 空数组 = 所有普通业务路径（产品固定保护路径永不放开，validator 层锁）。 */
    allowedTargetPrefixes: z.array(repoRelativePathSchema),
    defaultCollisionMode: z.enum(['create-only', 'replace-existing']),
    allowedCollisionModes: z.array(z.enum(['create-only', 'replace-existing'])).min(1),
    defaultContentPolicy: z.enum(['preserve-upload', 'agent-editable']),
    allowedContentPolicies: z.array(z.enum(['preserve-upload', 'agent-editable'])).min(1),
    allowExecutableFileMode: z.boolean(),
    targetChangedDisposition: z.enum(['block', 'handoff']),
  })
  .strict()

export const requirementLifecyclePolicySchema = z
  .object({
    sourceRefreshMode: z.enum(['manual', 'auto-before-first-push', 'auto']),
    clarificationChannelPriority: z
      .array(z.enum(['platform', 'requirement-source']))
      .min(1)
      .max(2),
    maxClarificationRounds: bounded(POLICY_HARD_CAPS.clarificationRounds),
    clarificationTimeoutMs: z.number().int().min(0).max(POLICY_HARD_CAPS.missionWallTimeMs),
    noChangeConfirmation: z.enum(['program-proof', 'human-confirmation']),
    upload: repositoryUploadPolicySchema,
  })
  .strict()

export const employeeSelectionRuleSchema = z
  .object({
    ruleId,
    when: z.array(factPredicateSchema).min(1),
    employeeRef: z.string().min(1),
  })
  .strict()

export const actionPriorityRuleSchema = z
  .object({
    ruleId,
    when: z.array(factPredicateSchema),
    /** action rule 只选 capability；work set 由平台固定 selector 生成（§4.4）。 */
    capabilityId: agentCapabilityIdSchema,
  })
  .strict()

export const feedbackPolicySchema = z
  .object({
    allowedAuthorClasses: z.array(z.enum(['human', 'bot', 'self'])).min(1),
    batchLimit: z.number().int().min(1).max(POLICY_HARD_CAPS.feedbackBatchLimit),
    requireLatestRevision: z.boolean(),
  })
  .strict()

export const pipelineGatePolicySchema = z
  .object({
    gateKey: z.string().min(1),
    required: z.boolean(),
    missingRunDisposition: z.enum(['observe-only', 'trigger-if-missing']),
    rerunnableCategories: z.array(z.string().min(1)),
    maxReruns: bounded(POLICY_HARD_CAPS.pipelineRerunsPerGate),
    maxTriggers: bounded(POLICY_HARD_CAPS.pipelineTriggersPerGate),
  })
  .strict()

export const pipelinePolicySchema = z
  .object({
    gates: z.array(pipelineGatePolicySchema),
    evidenceStaleAfterMs: z.number().int().min(0).max(POLICY_HARD_CAPS.missionWallTimeMs),
  })
  .strict()

export const conflictPolicySchema = z
  .object({
    /** 默认 report-only（D7）；repair 固定 merge target into source，无 rebase 可配。 */
    mode: z.enum(['report-only', 'repair']),
    maxRepairAttempts: bounded(POLICY_HARD_CAPS.conflictRepairAttempts),
  })
  .strict()

export const deliveryPolicySchema = z
  .object({
    sourceBranchPrefix: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]*$/, 'branch prefix must be a plain ref-safe segment'),
    sourceBranchCollision: z.enum(['deterministic-suffix', 'block']),
    draft: z.boolean(),
    remoteHumanPushDisposition: z.enum(['restart-action-from-new-head', 'handoff']),
  })
  .strict()

export const verificationPolicySchema = z
  .object({
    requiredProfileRefs: z.array(z.string().min(1)),
    stopPolicy: z.enum(['first-failure', 'collect-all']),
  })
  .strict()

export const retryPolicySchema = z
  .object({
    sameSessionRetries: bounded(POLICY_HARD_CAPS.sameSessionRetries),
    freshSessionReruns: bounded(POLICY_HARD_CAPS.freshSessionReruns),
    actionRunsPerMission: z.number().int().min(1).max(POLICY_HARD_CAPS.actionRunsPerMission),
    commitsPerMission: z.number().int().min(1).max(POLICY_HARD_CAPS.commitsPerMission),
    missionWallTimeMs: z.number().int().min(1).max(POLICY_HARD_CAPS.missionWallTimeMs),
  })
  .strict()

export const readinessPolicySchema = z
  .object({
    /** 只可比 pipeline.gates 的 required 集更严（validator 交叉检查）。 */
    additionalRequiredGateKeys: z.array(z.string().min(1)),
    unresolvedFeedbackBlocksReady: z.boolean(),
  })
  .strict()

export const notificationPolicySchema = z
  .object({
    overviewComment: z.enum(['off', 'reuse-single']),
    escalationIntervalMs: z.number().int().min(0).max(POLICY_HARD_CAPS.missionWallTimeMs),
  })
  .strict()

export const retentionPolicySchema = z
  .object({
    requirementBundleTerminalTtlDays: z.number().int().min(1).max(POLICY_HARD_CAPS.retentionDays),
    pipelineBundleTerminalTtlDays: z.number().int().min(1).max(POLICY_HARD_CAPS.retentionDays),
    attemptLedgerTtlDays: z.number().int().min(1).max(POLICY_HARD_CAPS.retentionDays),
  })
  .strict()

// ------------------------------------------------------------ whole policy

export const automationPolicyContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    admission: admissionPolicySchema,
    requirement: requirementLifecyclePolicySchema,
    employeeSelection: z.object({ rules: z.array(employeeSelectionRuleSchema) }).strict(),
    actionPriority: z.object({ rules: z.array(actionPriorityRuleSchema).min(1) }).strict(),
    feedback: feedbackPolicySchema,
    pipeline: pipelinePolicySchema,
    conflict: conflictPolicySchema,
    delivery: deliveryPolicySchema,
    verification: verificationPolicySchema,
    retry: retryPolicySchema,
    readiness: readinessPolicySchema,
    notification: notificationPolicySchema,
    retention: retentionPolicySchema,
  })
  .strict()

export type AutomationPolicyContent = z.infer<typeof automationPolicyContentSchema>

export interface PolicyPublishViolation {
  readonly code:
    | 'duplicate-rule-id'
    | 'predicate-invalid'
    | 'predicate-budget'
    | 'duplicate-gate-key'
    | 'readiness-gate-unknown'
  readonly where: string
  readonly detail: string
}

/** publish validator：schema 之外的交叉/目录检查（design §4.2 publish 拒绝清单）。 */
export function validatePolicyForPublish(
  content: AutomationPolicyContent,
): PolicyPublishViolation[] {
  const violations: PolicyPublishViolation[] = []
  const checkRules = (
    rules: readonly { ruleId: string; when: readonly (typeof factPredicateSchema._type)[] }[],
    phase: DecisionPhase,
    where: string,
  ): void => {
    const seen = new Set<string>()
    for (const rule of rules) {
      if (seen.has(rule.ruleId)) {
        violations.push({ code: 'duplicate-rule-id', where, detail: rule.ruleId })
      }
      seen.add(rule.ruleId)
      for (const predicate of rule.when) {
        for (const v of checkPredicateAgainstCatalog(predicate, phase)) {
          violations.push({
            code: 'predicate-invalid',
            where: `${where}/${rule.ruleId}`,
            detail: `${v.code}:${v.factId}`,
          })
        }
        for (const v of checkPredicateBudget(predicate)) {
          violations.push({
            code: 'predicate-budget',
            where: `${where}/${rule.ruleId}`,
            detail: v.code,
          })
        }
      }
    }
  }
  checkRules(content.employeeSelection.rules, 'admission-selection', 'employeeSelection')
  checkRules(content.actionPriority.rules, 'action-decision', 'actionPriority')

  const gateKeys = new Set<string>()
  for (const gate of content.pipeline.gates) {
    if (gateKeys.has(gate.gateKey)) {
      violations.push({ code: 'duplicate-gate-key', where: 'pipeline.gates', detail: gate.gateKey })
    }
    gateKeys.add(gate.gateKey)
  }
  for (const key of content.readiness.additionalRequiredGateKeys) {
    if (!gateKeys.has(key)) {
      violations.push({
        code: 'readiness-gate-unknown',
        where: 'readiness.additionalRequiredGateKeys',
        detail: key,
      })
    }
  }
  return violations
}

export function policyContentDigest(content: AutomationPolicyContent): string {
  return canonicalDigest(content)
}

/** 版本化默认值：新建 policy 草稿的起点（proposal §11：CI campaign 默认 3 迁入）。 */
export function defaultAutomationPolicyContent(): AutomationPolicyContent {
  return {
    schemaVersion: 1,
    admission: {
      allowedSubmissionKinds: ['direct', 'external-reference'],
      duplicateExternalIdDisposition: 'reject',
    },
    requirement: {
      sourceRefreshMode: 'manual',
      clarificationChannelPriority: ['platform', 'requirement-source'],
      maxClarificationRounds: 3,
      clarificationTimeoutMs: 7 * 24 * 60 * 60 * 1000,
      noChangeConfirmation: 'program-proof',
      upload: {
        maxFiles: 20,
        maxFileBytes: 32 * 1024 * 1024,
        maxTotalBytes: 128 * 1024 * 1024,
        allowedTargetPrefixes: [],
        defaultCollisionMode: 'create-only',
        allowedCollisionModes: ['create-only', 'replace-existing'],
        defaultContentPolicy: 'preserve-upload',
        allowedContentPolicies: ['preserve-upload', 'agent-editable'],
        allowExecutableFileMode: false,
        targetChangedDisposition: 'block',
      },
    },
    employeeSelection: { rules: [] },
    actionPriority: {
      rules: [
        {
          ruleId: 'default-implement',
          when: [
            {
              kind: 'enum-equals',
              fact: 'requirement.scopeDisposition',
              value: 'ready',
            },
          ],
          capabilityId: 'change.implement',
        },
      ],
    },
    feedback: { allowedAuthorClasses: ['human'], batchLimit: 10, requireLatestRevision: true },
    pipeline: { gates: [], evidenceStaleAfterMs: 60 * 60 * 1000 },
    conflict: { mode: 'report-only', maxRepairAttempts: 2 },
    delivery: {
      sourceBranchPrefix: 'aw/mission',
      sourceBranchCollision: 'deterministic-suffix',
      draft: false,
      remoteHumanPushDisposition: 'restart-action-from-new-head',
    },
    verification: { requiredProfileRefs: [], stopPolicy: 'first-failure' },
    retry: {
      sameSessionRetries: 2,
      freshSessionReruns: 1,
      actionRunsPerMission: 50,
      commitsPerMission: 30,
      missionWallTimeMs: 14 * 24 * 60 * 60 * 1000,
    },
    readiness: { additionalRequiredGateKeys: [], unresolvedFeedbackBlocksReady: true },
    notification: { overviewComment: 'reuse-single', escalationIntervalMs: 6 * 60 * 60 * 1000 },
    retention: {
      requirementBundleTerminalTtlDays: 90,
      pipelineBundleTerminalTtlDays: 30,
      attemptLedgerTtlDays: 180,
    },
  }
}
