// RFC-310 PR-8 T87/T88 —— policy builder 的前端静态目录。
//
// fact catalog / 谓词词表 / agent capability 目录都是后端 domain 的 closed
// 集合（backend/src/modules/development-automation/domain/{facts,predicate,
// capabilityDefinition}.ts）。前端不 import 后端包——本文件是它们的静态镜像，
// 漂移由 tests/code-policy-pages.test.tsx 直接相对路径 import 后端 domain
// 对拍锁定（后端加 leaf/词/能力而这里没同步 ⇒ 测试红）。

export type FactValueType = 'enum' | 'boolean' | 'number' | 'string-set'

export interface FactCatalogEntry {
  readonly id: string
  readonly type: FactValueType
  /** enum 的 closed vocabulary；其他类型为 null。 */
  readonly vocabulary: readonly string[] | null
}

export const POLICY_FACT_CATALOG: readonly FactCatalogEntry[] = [
  { id: 'repository.languages', type: 'string-set', vocabulary: null },
  { id: 'repository.buildSystems', type: 'string-set', vocabulary: null },
  { id: 'repository.moduleIds', type: 'string-set', vocabulary: null },
  { id: 'repository.changedPathClasses', type: 'string-set', vocabulary: null },
  { id: 'repository.defaultBranchKnown', type: 'boolean', vocabulary: null },
  { id: 'requirement.sourceKind', type: 'enum', vocabulary: ['direct', 'external'] },
  { id: 'requirement.bundleComplete', type: 'boolean', vocabulary: null },
  {
    id: 'requirement.clarificationState',
    type: 'enum',
    vocabulary: ['none', 'questions-published', 'answers-committed'],
  },
  {
    id: 'requirement.uploadSeedState',
    type: 'enum',
    vocabulary: ['not-applicable', 'pending', 'seeded', 'published'],
  },
  { id: 'requirement.affectedModuleIds', type: 'string-set', vocabulary: null },
  {
    id: 'requirement.scopeDisposition',
    type: 'enum',
    vocabulary: ['ready', 'needs-information', 'already-satisfied-candidate'],
  },
  { id: 'mr.exists', type: 'boolean', vocabulary: null },
  { id: 'mr.draft', type: 'boolean', vocabulary: null },
  { id: 'mr.conflict', type: 'boolean', vocabulary: null },
  { id: 'mr.mergeable', type: 'enum', vocabulary: ['yes', 'no', 'unknown'] },
  { id: 'mr.approvalHold', type: 'boolean', vocabulary: null },
  { id: 'mr.unhandledFeedbackCount', type: 'number', vocabulary: null },
  { id: 'mr.terminalState', type: 'enum', vocabulary: ['active', 'merged', 'closed'] },
  { id: 'pipeline.completeness', type: 'enum', vocabulary: ['complete', 'partial'] },
  { id: 'pipeline.requiredGatesAllPass', type: 'boolean', vocabulary: null },
  { id: 'pipeline.failingRequiredGateKeys', type: 'string-set', vocabulary: null },
  { id: 'pipeline.failureCategories', type: 'string-set', vocabulary: null },
  { id: 'pipeline.missingRequiredGateKeys', type: 'string-set', vocabulary: null },
  { id: 'pipeline.anyRunning', type: 'boolean', vocabulary: null },
  {
    id: 'verification.lastOutcome',
    type: 'enum',
    vocabulary: ['not-run', 'passed', 'failed'],
  },
  { id: 'verification.allRequiredPassed', type: 'boolean', vocabulary: null },
  { id: 'verification.failedProfileRefs', type: 'string-set', vocabulary: null },
  { id: 'action.pendingKind', type: 'enum', vocabulary: ['none', 'agent', 'program', 'effect'] },
  {
    id: 'action.lastOutcome',
    type: 'enum',
    vocabulary: [
      'none',
      'changed',
      'no-change',
      'needs-information',
      'blocked',
      'failed',
      'completed',
    ],
  },
  {
    id: 'action.lastFailureCategory',
    type: 'enum',
    vocabulary: [
      'none',
      'transient',
      'stale-input',
      'configuration',
      'permission',
      'invalid-user-input',
      'business-failure',
      'contract-violation',
    ],
  },
  {
    id: 'action.candidateState',
    type: 'enum',
    vocabulary: ['none', 'prepared', 'verified', 'published'],
  },
  { id: 'budget.actionRunsRemaining', type: 'number', vocabulary: null },
  { id: 'budget.pipelineRerunsRemaining', type: 'number', vocabulary: null },
  { id: 'budget.commitsRemaining', type: 'number', vocabulary: null },
]

export function factEntry(id: string): FactCatalogEntry | undefined {
  return POLICY_FACT_CATALOG.find((entry) => entry.id === id)
}

/** builder 支持的叶子谓词 kind（组合子 all/any/not 走 JSON 兜底行）。 */
export const LEAF_PREDICATE_KINDS = [
  'enum-equals',
  'enum-in',
  'set-contains-any',
  'set-contains-all',
  'number-compare',
  'boolean-is',
  'path-class-any',
] as const
export type LeafPredicateKind = (typeof LEAF_PREDICATE_KINDS)[number]

export const NUMBER_COMPARE_OPS = ['eq', 'lt', 'lte', 'gt', 'gte'] as const

/** agent capability 目录（actionPriority 规则可选的动作面）。 */
export const AGENT_CAPABILITY_IDS = [
  'requirement.analyze',
  'change.implement',
  'change.review',
  'verification.repair',
  'mr.feedback.apply',
  'pipeline.repair',
  'conflict.repair',
  'mr.review.external',
  'problem.classify',
  'approval.prepare',
] as const

/** 产品硬上限镜像（NumberInput 的 max 提示；后端 publish validator 是权威）。 */
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
  retentionDays: 3650,
} as const

/** 固定 guard 顺序（design §4.3——只读呈现：守卫先于一切规则，不可配置）。 */
export const FIXED_GUARD_ORDER = [
  'terminal',
  'lease-epoch',
  'active-effect-transition',
  'fact-integrity',
  'stale-baseline',
  'authority',
  'budget-exhausted',
  'automation-mode',
  'upload-seed',
] as const

/** 新 policy 的默认 content（后端 defaultAutomationPolicyContent 的镜像）。 */
export function defaultPolicyTemplate(): Record<string, unknown> {
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
          ruleId: 'default-analyze',
          when: [
            { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
            { kind: 'boolean-is', fact: 'repository.defaultBranchKnown', value: true },
            { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
          ],
          capabilityId: 'requirement.analyze',
        },
        {
          ruleId: 'default-implement',
          when: [{ kind: 'enum-equals', fact: 'requirement.scopeDisposition', value: 'ready' }],
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

/** simulator 的 guards 默认值（一个「健康 working mission」的形态）。 */
export function defaultGuardFixture(): Record<string, unknown> {
  return {
    missionTerminal: false,
    mrTerminal: 'not-applicable',
    holdsLease: true,
    activeWritableAction: false,
    unsettledEffect: false,
    transitionFence: 'none',
    factIntegrityViolations: [],
    staleBaseline: false,
    authorityViolations: [],
    exhaustedBudgets: [],
    automationMode: 'active',
    uploadSeed: 'not-applicable',
    uploadPlanRef: null,
  }
}
