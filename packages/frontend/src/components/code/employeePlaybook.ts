// RFC-310 PR-11 — business-facing digital employee playbook helpers.
//
// The UI speaks in steps, triggers and executors. Exact resource refs and
// capability ids remain wire details assembled here; users never type them.

export interface PublishedResourceOption {
  id: string
  name: string
  publishedRevision: number | null
  capabilityId?: string
  purpose?: string
  executorKind?: 'agent' | 'workgroup' | 'script' | null
}

export type EmployeePreset = 'general' | 'java' | 'cpp'
export type BusinessTrigger =
  | 'always'
  | 'requirement-ready'
  | 'review-feedback'
  | 'pipeline-failed'
  | 'merge-conflict'

export type BusinessProducerKind =
  | 'platform'
  | 'agent'
  | 'script'
  | 'digital-employee'
  | 'approval-prepare'
  | 'approval-submit'
  | 'approval-observe'

/**
 * 创建向导预置的标准步骤。
 *
 * `displayName` 是**落库内容**（写进说明书 draft），不是渲染期文案——所以它必须在
 * 创建那一刻按创建者的语言取值，而不能写死。此前这里是五个中文字面量，于是英文界面
 * 创建出来的员工，工作步骤名是中文：整页英文里孤零零一行「实现修改」。这条是 RFC-310
 * T121 的 `/code/config/employees` 详情页视觉基线**第一次截图就照出来的**——功能测试
 * 从不看文字属于哪种语言。
 */
export const STANDARD_CAPABILITY_STEPS = [
  { capabilityId: 'requirement.analyze', nameKey: 'requirementAnalyze' },
  { capabilityId: 'change.implement', nameKey: 'changeImplement' },
  { capabilityId: 'change.review', nameKey: 'changeReview' },
  { capabilityId: 'mr.feedback.apply', nameKey: 'mrFeedbackApply' },
  { capabilityId: 'pipeline.repair', nameKey: 'pipelineRepair' },
] as const

export const PLATFORM_ACTIONS = [
  'requirement.acquire',
  'repository.inspect',
  'pipeline.collect',
  'verification.run',
  'change.publish',
  'mr.ensure',
  'mr.collect',
  'pipeline.rerun',
  'pipeline.trigger',
  'readiness.evaluate',
] as const

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

export function exactRef(value: unknown): { id: string; revision: number } | null {
  const ref = asRecord(value)
  return typeof ref.id === 'string' && typeof ref.revision === 'number'
    ? { id: ref.id, revision: ref.revision }
    : null
}

export function publishedRef(
  resource: PublishedResourceOption | undefined,
): { id: string; revision: number } | null {
  return resource?.publishedRevision === null || resource?.publishedRevision === undefined
    ? null
    : { id: resource.id, revision: resource.publishedRevision }
}

export function employeePresetOf(draft: Record<string, unknown>): EmployeePreset {
  const predicates = Array.isArray(draft.supportedRepositoryFacts)
    ? draft.supportedRepositoryFacts.map(asRecord)
    : []
  const language = predicates.find(
    (predicate) =>
      predicate.kind === 'set-contains-any' && predicate.fact === 'repository.languages',
  )
  const values = Array.isArray(language?.values) ? language.values : []
  if (values.includes('java')) return 'java'
  if (values.includes('cpp') || values.includes('c++') || values.includes('c')) return 'cpp'
  return 'general'
}

export function responsibilityPredicates(preset: EmployeePreset): Record<string, unknown>[] {
  if (preset === 'java') {
    return [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] }]
  }
  if (preset === 'cpp') {
    return [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['c', 'cpp', 'c++'] }]
  }
  return []
}

export function triggerOf(step: Record<string, unknown>): BusinessTrigger {
  const predicates = Array.isArray(step.when) ? step.when.map(asRecord) : []
  const first = predicates[0]
  if (first === undefined) return 'always'
  if (first.fact === 'pipeline.requiredGatesAllPass' && first.value === false) {
    return 'pipeline-failed'
  }
  if (first.fact === 'mr.unhandledFeedbackCount') return 'review-feedback'
  if (first.fact === 'mr.conflict' && first.value === true) return 'merge-conflict'
  if (first.fact === 'requirement.bundleComplete' && first.value === true) {
    return 'requirement-ready'
  }
  return 'always'
}

export function predicatesForTrigger(trigger: BusinessTrigger): Record<string, unknown>[] {
  switch (trigger) {
    case 'requirement-ready':
      return [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true }]
    case 'review-feedback':
      return [{ kind: 'number-compare', fact: 'mr.unhandledFeedbackCount', op: 'gt', value: 0 }]
    case 'pipeline-failed':
      return [{ kind: 'boolean-is', fact: 'pipeline.requiredGatesAllPass', value: false }]
    case 'merge-conflict':
      return [{ kind: 'boolean-is', fact: 'mr.conflict', value: true }]
    case 'always':
      return []
  }
}

export function normalizeStepOrder(steps: Record<string, unknown>[]): Record<string, unknown>[] {
  return steps.map((step, index) => ({
    ...step,
    input:
      index === 0
        ? { kind: 'mission-requirement' }
        : { kind: 'step-output', stepId: String(steps[index - 1]?.stepId ?? '') },
    onSuccess: index + 1 < steps.length ? String(steps[index + 1]?.stepId ?? '') : 'reconcile',
  }))
}

export function newBusinessStep(
  index: number,
  displayName = `Step ${index + 1}`,
): Record<string, unknown> {
  return {
    stepId: `step-${index + 1}`,
    displayName,
    description: '',
    when: [],
    producer: { kind: 'platform', capabilityId: 'repository.inspect' },
    input: { kind: 'mission-requirement' },
    onSuccess: 'reconcile',
    join: null,
    onFailure: {
      retry: { sameScene: 1, freshScene: 1 },
      onExhausted: 'block',
      onRejected: null,
      onExpired: null,
    },
  }
}

export function buildInitialEmployeePlaybook(input: {
  description: string
  preset: EmployeePreset
  policy: PublishedResourceOption
  implementations: readonly PublishedResourceOption[]
  /**
   * 按 `STANDARD_CAPABILITY_STEPS[].nameKey` 取步骤名。**必填**而不是给个默认值：默认值
   * 会让任何漏改的调用点静默继续写死一种语言，而编译错误会把调用点逐个点出来。
   *
   * 传 nameKey 而不是 capabilityId，是因为 capabilityId 带点（`change.implement`），而
   * i18n 的 key 一旦含点就会被 `tests/i18n-batch-extraction.test.ts` 的扁平化按路径拆开
   * ——它在 bundle 里找不到那一层，报「leaf 不是字符串」。（页面上却看着是好的：i18next
   * 的 `ignoreJSONStructure` 会在嵌套查找失败后再试一次扁平 key，于是这个坑只在门禁里现形。）
   */
  stepName: (nameKey: string) => string
}): Record<string, unknown> {
  const selected = STANDARD_CAPABILITY_STEPS.flatMap((spec, index) => {
    const implementation = input.implementations.find(
      (candidate) =>
        candidate.publishedRevision !== null && candidate.capabilityId === spec.capabilityId,
    )
    const implementationRef = publishedRef(implementation)
    if (implementationRef === null) return []
    return [
      {
        stepId: `step-${index + 1}-${spec.capabilityId.replaceAll('.', '-')}`,
        displayName: input.stepName(spec.nameKey),
        description: '',
        when:
          spec.capabilityId === 'mr.feedback.apply'
            ? predicatesForTrigger('review-feedback')
            : spec.capabilityId === 'pipeline.repair'
              ? predicatesForTrigger('pipeline-failed')
              : spec.capabilityId === 'requirement.analyze'
                ? predicatesForTrigger('requirement-ready')
                : [],
        producer: {
          kind: implementation?.executorKind === 'script' ? 'script' : 'agent',
          implementationRef,
        },
        input: { kind: 'mission-requirement' },
        onSuccess: 'reconcile',
        join: null,
        onFailure: {
          retry: { sameScene: 1, freshScene: 1 },
          onExhausted: 'block',
          onRejected: null,
          onExpired: null,
        },
      },
    ]
  })
  // The first three capabilities form the one-shot delivery chain. Review and
  // pipeline repair are reactive duties: they must wait independently for new
  // MR/pipeline evidence and return to reconciliation after each occurrence.
  // Chaining them after implementation would make the employee wait forever
  // whenever its initial MR has no feedback or failing gate.
  const reactiveCapabilities = new Set(['mr.feedback.apply', 'pipeline.repair'])
  const coreSteps = selected.filter((step) => {
    const producer = asRecord(step.producer)
    const ref = exactRef(producer.implementationRef)
    const implementation = input.implementations.find(
      (candidate) => candidate.id === ref?.id && candidate.publishedRevision === ref?.revision,
    )
    return implementation?.capabilityId === undefined
      ? !String(step.stepId).includes('mr-feedback-apply') &&
          !String(step.stepId).includes('pipeline-repair')
      : !reactiveCapabilities.has(implementation.capabilityId)
  })
  const reactiveSteps = selected
    .filter((step) => !coreSteps.includes(step))
    .map((step) => ({
      ...step,
      input: { kind: 'mission-requirement' },
      onSuccess: 'reconcile',
    }))
  const steps = [...normalizeStepOrder(coreSteps), ...reactiveSteps]
  const firstByCapability = new Map<string, PublishedResourceOption>()
  for (const implementation of input.implementations) {
    if (
      implementation.capabilityId !== undefined &&
      !firstByCapability.has(implementation.capabilityId)
    ) {
      firstByCapability.set(implementation.capabilityId, implementation)
    }
  }
  const routes = [...firstByCapability.values()].flatMap((implementation) => {
    const implementationRef = publishedRef(implementation)
    return implementationRef === null || implementation.capabilityId === undefined
      ? []
      : [
          {
            capabilityId: implementation.capabilityId,
            rules: [],
            fallbackTemplateRef: implementationRef,
          },
        ]
  })
  return {
    schemaVersion: 1,
    description: input.description,
    businessStatus: 'enabled',
    supportedRepositoryFacts: responsibilityPredicates(input.preset),
    steps,
    problemTypes: [],
    problemProducers: [],
    problemHandlers: [],
    capabilityRoutes: routes,
    requirementSources: [],
    pipelineProviders: [],
    defaultPolicyRef: publishedRef(input.policy),
  }
}
