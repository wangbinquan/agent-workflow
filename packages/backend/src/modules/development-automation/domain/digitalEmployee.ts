// RFC-310 T14 —— DigitalEmployeeTemplate 内容 codec 与发布闭包检查（design.md §3.6）。
//
// 一名数字员工 = 能力包：每项 Agent capability 的有序 ActionTemplate route、
// requirement source / pipeline provider 的 adapter 绑定、默认 policy。route 是
// **唯一** template selector（compatibility 只拒绝不选择，§3.4）；发布做闭包
// 检查——缺模板、capability 不匹配、adapter purpose 错、predicate 越目录都在
// publish 时拒绝，而不是等 Mission 运行时才撞上。引用一律 (id, revision) 精确
// 版本：Mission pin 后不因资源被编辑而漂移。

import { z } from 'zod'

import { agentCapabilityIdSchema } from './capabilityDefinition'
import { canonicalDigest } from './canonicalJson'
import { checkPredicateAgainstCatalog } from './facts'
import { checkPredicateBudget, factPredicateSchema } from './predicate'

const versionedRef = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

export type VersionedRef = z.infer<typeof versionedRef>

const ruleId = z.string().min(1).max(120)
const stepId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)

const stepTargetSchema = z.union([stepId, z.enum(['reconcile', 'complete', 'block', 'handoff'])])

const retryBudgetSchema = z
  .object({
    sameScene: z.number().int().min(0).max(10),
    freshScene: z.number().int().min(0).max(5),
  })
  .strict()

const stepFailureRuleSchema = z
  .object({
    retry: retryBudgetSchema,
    onExhausted: stepTargetSchema,
    onRejected: stepTargetSchema.nullable(),
    onExpired: stepTargetSchema.nullable(),
  })
  .strict()

const targetRepositoryRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), repositoryId: z.string().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal('fact'),
      factId: z.enum(['problem.targetRepositoryId', 'requirement.targetRepositoryId']),
    })
    .strict(),
])

export const employeeStepProducerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('platform'),
      capabilityId: z.enum([
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
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('agent'), implementationRef: versionedRef }).strict(),
  z.object({ kind: z.literal('script'), implementationRef: versionedRef }).strict(),
  z
    .object({
      kind: z.literal('digital-employee'),
      employeeRef: versionedRef,
      repository: targetRepositoryRuleSchema,
      completion: z.enum(['automation-ready', 'ready-to-merge', 'merged', 'completed']),
      deadlineMs: z
        .number()
        .int()
        .min(1_000)
        .max(30 * 24 * 60 * 60 * 1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval-prepare'),
      executor: z.enum(['agent', 'script']),
      implementationRef: versionedRef,
      approvalType: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval-submit'),
      adapterRef: versionedRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval-observe'),
      adapterRef: versionedRef,
      pollIntervalMs: z
        .number()
        .int()
        .min(5_000)
        .max(24 * 60 * 60 * 1000),
      deadlineMs: z
        .number()
        .int()
        .min(5_000)
        .max(30 * 24 * 60 * 60 * 1000),
      webhookSourceKey: z.string().min(1).max(120).nullable(),
    })
    .strict(),
])

const stepInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mission-requirement') }).strict(),
  z.object({ kind: z.literal('selected-problems') }).strict(),
  z.object({ kind: z.literal('step-output'), stepId }).strict(),
  z
    .object({
      kind: z.literal('compose'),
      sources: z
        .array(z.object({ name: z.string().min(1).max(80), stepId }).strict())
        .min(1)
        .max(16),
    })
    .strict(),
])

const stepJoinSchema = z
  .object({
    groupId: stepId,
    mode: z.enum(['all', 'any', 'quorum']),
    quorum: z.number().int().positive().nullable(),
    memberStepIds: z.array(stepId).min(1).max(32),
    deadlineMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 24 * 60 * 60 * 1000),
    onDeadline: stepTargetSchema,
    onPartial: stepTargetSchema,
  })
  .strict()

export const employeeStepSchema = z
  .object({
    stepId,
    displayName: z.string().min(1).max(200),
    description: z.string().max(2_000),
    when: z.array(factPredicateSchema).max(16),
    producer: employeeStepProducerSchema,
    input: stepInputSchema,
    onSuccess: stepTargetSchema,
    join: stepJoinSchema.nullable(),
    onFailure: stepFailureRuleSchema,
  })
  .strict()

export const problemTypeDefinitionSchema = z
  .object({
    typeId: stepId,
    displayName: z.string().min(1).max(200),
    evidenceDomain: z.enum(['pipeline', 'verification', 'feedback', 'conflict', 'mr']),
    repairable: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    unknownFallback: z.boolean(),
  })
  .strict()

export const problemProducerDefinitionSchema = z
  .object({
    producerId: stepId,
    displayName: z.string().min(1).max(200),
    kind: z.enum(['agent', 'script']),
    implementationRef: versionedRef,
    evidenceDomains: z.array(problemTypeDefinitionSchema.shape.evidenceDomain).min(1).max(5),
    allowedTypeIds: z.array(stepId).min(1).max(100),
    when: z.array(factPredicateSchema).max(16),
    retry: retryBudgetSchema,
    fallbackProducerId: stepId.nullable(),
  })
  .strict()

export const problemHandlingRuleSchema = z
  .object({
    ruleId,
    typeId: stepId,
    when: z.array(factPredicateSchema).max(16),
    handler: z
      .object({
        kind: z.enum(['agent', 'script']),
        implementationRef: versionedRef,
      })
      .strict(),
    verifyStepIds: z.array(stepId).max(16),
    retry: retryBudgetSchema,
    fallbackRuleId: ruleId.nullable(),
  })
  .strict()

export const capabilityRouteRuleSchema = z
  .object({
    ruleId,
    when: z.array(factPredicateSchema).min(1),
    templateRef: versionedRef,
  })
  .strict()

export const capabilityRouteSchema = z
  .object({
    capabilityId: agentCapabilityIdSchema,
    rules: z.array(capabilityRouteRuleSchema),
    fallbackTemplateRef: versionedRef.nullable(),
  })
  .strict()

export const requirementSourceBindingSchema = z
  .object({
    sourceKey: z.string().min(1).max(120),
    adapterRef: versionedRef,
    isDefault: z.boolean(),
  })
  .strict()

export const pipelineProviderBindingSchema = z
  .object({
    providerKey: z.string().min(1).max(120),
    adapterRef: versionedRef,
  })
  .strict()

export const digitalEmployeeContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    description: z.string().max(4000),
    businessStatus: z.enum(['enabled', 'disabled']).optional(),
    supportedRepositoryFacts: z.array(factPredicateSchema),
    steps: z.array(employeeStepSchema).max(100).optional(),
    problemTypes: z.array(problemTypeDefinitionSchema).max(100).optional(),
    problemProducers: z.array(problemProducerDefinitionSchema).max(100).optional(),
    problemHandlers: z.array(problemHandlingRuleSchema).max(200).optional(),
    capabilityRoutes: z.array(capabilityRouteSchema),
    requirementSources: z.array(requirementSourceBindingSchema),
    pipelineProviders: z.array(pipelineProviderBindingSchema),
    defaultPolicyRef: versionedRef,
  })
  .strict()

export type DigitalEmployeeContent = z.infer<typeof digitalEmployeeContentSchema>

export interface CompiledEmployeePlaybook {
  readonly schemaVersion: 1
  readonly businessStatus: 'enabled' | 'disabled'
  readonly stepIds: readonly string[]
  readonly problemTypeIds: readonly string[]
  readonly producerIds: readonly string[]
  readonly handlerRuleIds: readonly string[]
  readonly callTargets: readonly string[]
  readonly approvalAdapterRefs: readonly string[]
  readonly digest: string
}

/**
 * Pure, canonical business projection used by preview and Mission pinning.
 * Cross-resource closure validation remains `validateDigitalEmployeeForPublish`;
 * this function intentionally has no DB lookup and therefore replays byte-for-byte.
 */
export function compileEmployeePlaybook(content: DigitalEmployeeContent): CompiledEmployeePlaybook {
  const steps = content.steps ?? []
  const core = {
    schemaVersion: 1 as const,
    businessStatus: content.businessStatus ?? ('enabled' as const),
    stepIds: steps.map((step) => step.stepId),
    problemTypeIds: (content.problemTypes ?? []).map((type) => type.typeId),
    producerIds: (content.problemProducers ?? []).map((producer) => producer.producerId),
    handlerRuleIds: (content.problemHandlers ?? []).map((handler) => handler.ruleId),
    callTargets: steps.flatMap((step) =>
      step.producer.kind === 'digital-employee'
        ? [`${step.producer.employeeRef.id}@${step.producer.employeeRef.revision}`]
        : [],
    ),
    approvalAdapterRefs: steps.flatMap((step) =>
      step.producer.kind === 'approval-submit' || step.producer.kind === 'approval-observe'
        ? [`${step.producer.adapterRef.id}@${step.producer.adapterRef.revision}`]
        : [],
    ),
  }
  return { ...core, digest: canonicalDigest(core) }
}

export interface EmployeePublishViolation {
  readonly code:
    | 'route-empty'
    | 'duplicate-route-capability'
    | 'duplicate-rule-id'
    | 'template-missing'
    | 'template-capability-mismatch'
    | 'duplicate-source-key'
    | 'multiple-default-sources'
    | 'duplicate-provider-key'
    | 'adapter-missing'
    | 'adapter-purpose-mismatch'
    | 'policy-missing'
    | 'predicate-invalid'
    | 'predicate-budget'
    | 'duplicate-step-id'
    | 'step-target-missing'
    | 'step-input-source-missing'
    | 'step-cycle'
    | 'step-implementation-missing'
    | 'step-implementation-capability-mismatch'
    | 'child-employee-missing'
    | 'approval-adapter-mismatch'
    | 'join-invalid'
    | 'duplicate-problem-type'
    | 'problem-unknown-fallback-invalid'
    | 'duplicate-problem-producer'
    | 'problem-type-missing'
    | 'problem-producer-fallback-missing'
    | 'problem-producer-fallback-cycle'
    | 'duplicate-problem-handler-rule'
    | 'problem-handler-fallback-missing'
    | 'problem-handler-fallback-type-mismatch'
    | 'problem-handler-fallback-cycle'
    | 'problem-implementation-missing'
    | 'problem-implementation-capability-mismatch'
  readonly where: string
  readonly detail: string
}

/** 发布闭包检查的注入查询面：store 在事务内实现，domain 不触 DB。 */
export interface EmployeePublishLookup {
  getTemplate(templateId: string, revision: number): { readonly capabilityId: string } | null
  getPolicy(policyId: string, revision: number): { readonly exists: true } | null
  getAdapter(adapterId: string, revision: number): { readonly purpose: string } | null
  getEmployee?(employeeId: string, revision: number): { readonly exists: true } | null
}

export function validateDigitalEmployeeForPublish(
  content: DigitalEmployeeContent,
  lookup: EmployeePublishLookup,
): EmployeePublishViolation[] {
  const violations: EmployeePublishViolation[] = []
  const push = (code: EmployeePublishViolation['code'], where: string, detail: string): void => {
    violations.push({ code, where, detail })
  }
  const checkPredicates = (
    predicates: readonly z.infer<typeof factPredicateSchema>[],
    phase: 'admission-selection' | 'action-decision',
    where: string,
  ): void => {
    for (const predicate of predicates) {
      for (const v of checkPredicateAgainstCatalog(predicate, phase)) {
        push('predicate-invalid', where, `${v.code}:${v.factId}`)
      }
      for (const v of checkPredicateBudget(predicate)) {
        push('predicate-budget', where, v.code)
      }
    }
  }

  checkPredicates(
    content.supportedRepositoryFacts,
    'admission-selection',
    'supportedRepositoryFacts',
  )

  const steps = content.steps ?? []
  const stepIndexes = new Map<string, number>()
  const stepIds = new Set<string>()
  for (const [index, step] of steps.entries()) {
    const where = `steps/${step.stepId}`
    if (stepIds.has(step.stepId)) push('duplicate-step-id', where, step.stepId)
    stepIds.add(step.stepId)
    stepIndexes.set(step.stepId, index)
    checkPredicates(step.when, 'action-decision', `${where}/when`)
  }

  const isStepTarget = (target: string): boolean =>
    !['reconcile', 'complete', 'block', 'handoff'].includes(target)
  const stepTargets = (step: (typeof steps)[number]): string[] => [
    step.onSuccess,
    step.onFailure.onExhausted,
    ...(step.onFailure.onRejected === null ? [] : [step.onFailure.onRejected]),
    ...(step.onFailure.onExpired === null ? [] : [step.onFailure.onExpired]),
    ...(step.join === null ? [] : [step.join.onDeadline, step.join.onPartial]),
  ]

  for (const [index, step] of steps.entries()) {
    const where = `steps/${step.stepId}`
    for (const target of stepTargets(step)) {
      if (isStepTarget(target) && !stepIds.has(target)) {
        push('step-target-missing', where, target)
      }
    }
    const inputSources =
      step.input.kind === 'step-output'
        ? [step.input.stepId]
        : step.input.kind === 'compose'
          ? step.input.sources.map((source) => source.stepId)
          : []
    for (const source of inputSources) {
      const sourceIndex = stepIndexes.get(source)
      if (sourceIndex === undefined || sourceIndex >= index) {
        push('step-input-source-missing', `${where}/input`, source)
      }
    }
    if (step.join !== null) {
      const members = new Set(step.join.memberStepIds)
      const quorumValid =
        step.join.mode === 'quorum'
          ? step.join.quorum !== null && step.join.quorum >= 1 && step.join.quorum <= members.size
          : step.join.quorum === null
      if (
        members.size !== step.join.memberStepIds.length ||
        [...members].some((member) => !stepIds.has(member)) ||
        !quorumValid
      ) {
        push('join-invalid', `${where}/join`, step.join.groupId)
      }
    }
    const producer = step.producer
    if (
      producer.kind === 'agent' ||
      producer.kind === 'script' ||
      producer.kind === 'approval-prepare'
    ) {
      const implementation = lookup.getTemplate(
        producer.implementationRef.id,
        producer.implementationRef.revision,
      )
      if (implementation === null) {
        push(
          'step-implementation-missing',
          `${where}/producer`,
          `${producer.implementationRef.id}@${producer.implementationRef.revision}`,
        )
      } else if (
        producer.kind === 'approval-prepare' &&
        implementation.capabilityId !== 'approval.prepare'
      ) {
        push(
          'step-implementation-capability-mismatch',
          `${where}/producer`,
          `${producer.implementationRef.id}@${producer.implementationRef.revision} implements ${implementation.capabilityId}`,
        )
      }
    } else if (producer.kind === 'digital-employee') {
      const child = lookup.getEmployee?.(producer.employeeRef.id, producer.employeeRef.revision)
      if (child === null || child === undefined) {
        push(
          'child-employee-missing',
          `${where}/producer`,
          `${producer.employeeRef.id}@${producer.employeeRef.revision}`,
        )
      }
    } else if (producer.kind === 'approval-submit' || producer.kind === 'approval-observe') {
      const adapter = lookup.getAdapter(producer.adapterRef.id, producer.adapterRef.revision)
      if (adapter === null || adapter.purpose !== 'approval-gateway') {
        push(
          'approval-adapter-mismatch',
          `${where}/producer`,
          `${producer.adapterRef.id}@${producer.adapterRef.revision}`,
        )
      }
    }
  }

  // Explicit step jumps must form a DAG. Repetition belongs to bounded retry,
  // while returning to platform reconciliation uses the closed `reconcile`
  // target; an arbitrary graph cycle would be an unbounded second scheduler.
  const edges = new Map(
    steps.map((step) => [
      step.stepId,
      stepTargets(step).filter((target) => isStepTarget(target) && stepIds.has(target)),
    ]),
  )
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const id of stepIds) {
    if (visit(id)) {
      push('step-cycle', `steps/${id}`, id)
      break
    }
  }

  const problemTypes = content.problemTypes ?? []
  const problemTypeIds = new Set<string>()
  const fallbackByDomain = new Set<string>()
  for (const type of problemTypes) {
    const where = `problemTypes/${type.typeId}`
    if (problemTypeIds.has(type.typeId)) push('duplicate-problem-type', where, type.typeId)
    problemTypeIds.add(type.typeId)
    if (type.unknownFallback) {
      if (fallbackByDomain.has(type.evidenceDomain)) {
        push('problem-unknown-fallback-invalid', where, type.evidenceDomain)
      }
      fallbackByDomain.add(type.evidenceDomain)
    }
  }

  const producers = content.problemProducers ?? []
  const producerIds = new Set(producers.map((producer) => producer.producerId))
  if (producerIds.size !== producers.length) {
    push('duplicate-problem-producer', 'problemProducers', 'producerId must be unique')
  }
  for (const producer of producers) {
    const where = `problemProducers/${producer.producerId}`
    checkPredicates(producer.when, 'action-decision', `${where}/when`)
    for (const typeId of producer.allowedTypeIds) {
      if (!problemTypeIds.has(typeId)) push('problem-type-missing', where, typeId)
    }
    if (producer.fallbackProducerId !== null && !producerIds.has(producer.fallbackProducerId)) {
      push('problem-producer-fallback-missing', where, producer.fallbackProducerId)
    }
    const implementation = lookup.getTemplate(
      producer.implementationRef.id,
      producer.implementationRef.revision,
    )
    if (implementation === null) {
      push(
        'problem-implementation-missing',
        where,
        `${producer.implementationRef.id}@${producer.implementationRef.revision}`,
      )
    } else if (implementation.capabilityId !== 'problem.classify') {
      push(
        'problem-implementation-capability-mismatch',
        where,
        `${producer.implementationRef.id}@${producer.implementationRef.revision} implements ${implementation.capabilityId}`,
      )
    }
  }
  const producerFallbacks = new Map(
    producers.map((producer) => [producer.producerId, producer.fallbackProducerId]),
  )
  for (const producer of producers) {
    const seen = new Set<string>()
    let current: string | null = producer.producerId
    while (current !== null) {
      if (seen.has(current)) {
        push('problem-producer-fallback-cycle', `problemProducers/${producer.producerId}`, current)
        break
      }
      seen.add(current)
      current = producerFallbacks.get(current) ?? null
    }
  }

  const handlers = content.problemHandlers ?? []
  const handlerRuleIds = new Set(handlers.map((handler) => handler.ruleId))
  if (handlerRuleIds.size !== handlers.length) {
    push('duplicate-problem-handler-rule', 'problemHandlers', 'ruleId must be unique')
  }
  for (const handler of handlers) {
    const where = `problemHandlers/${handler.ruleId}`
    checkPredicates(handler.when, 'action-decision', `${where}/when`)
    if (!problemTypeIds.has(handler.typeId)) push('problem-type-missing', where, handler.typeId)
    for (const verifyStepId of handler.verifyStepIds) {
      if (!stepIds.has(verifyStepId))
        push('step-target-missing', `${where}/verifyStepIds`, verifyStepId)
    }
    if (handler.fallbackRuleId !== null && !handlerRuleIds.has(handler.fallbackRuleId)) {
      push('problem-handler-fallback-missing', where, handler.fallbackRuleId)
    } else if (handler.fallbackRuleId !== null) {
      const fallback = handlers.find((candidate) => candidate.ruleId === handler.fallbackRuleId)
      if (fallback !== undefined && fallback.typeId !== handler.typeId) {
        push(
          'problem-handler-fallback-type-mismatch',
          where,
          `${handler.fallbackRuleId}:${handler.typeId}->${fallback.typeId}`,
        )
      }
    }
    if (
      lookup.getTemplate(
        handler.handler.implementationRef.id,
        handler.handler.implementationRef.revision,
      ) === null
    ) {
      push(
        'problem-implementation-missing',
        where,
        `${handler.handler.implementationRef.id}@${handler.handler.implementationRef.revision}`,
      )
    }
  }
  const handlerFallbacks = new Map(
    handlers.map((handler) => [handler.ruleId, handler.fallbackRuleId]),
  )
  for (const handler of handlers) {
    const seen = new Set<string>()
    let current: string | null = handler.ruleId
    while (current !== null) {
      if (seen.has(current)) {
        push('problem-handler-fallback-cycle', `problemHandlers/${handler.ruleId}`, current)
        break
      }
      seen.add(current)
      current = handlerFallbacks.get(current) ?? null
    }
  }

  const seenCapabilities = new Set<string>()
  for (const route of content.capabilityRoutes) {
    const where = `capabilityRoutes/${route.capabilityId}`
    if (seenCapabilities.has(route.capabilityId)) {
      push('duplicate-route-capability', where, route.capabilityId)
    }
    seenCapabilities.add(route.capabilityId)
    if (route.rules.length === 0 && route.fallbackTemplateRef === null) {
      push('route-empty', where, 'no rules and no fallback')
    }
    const seenRules = new Set<string>()
    for (const rule of route.rules) {
      if (seenRules.has(rule.ruleId)) push('duplicate-rule-id', where, rule.ruleId)
      seenRules.add(rule.ruleId)
      checkPredicates(rule.when, 'action-decision', `${where}/${rule.ruleId}`)
    }
    const templateRefs = [
      ...route.rules.map((r) => r.templateRef),
      ...(route.fallbackTemplateRef === null ? [] : [route.fallbackTemplateRef]),
    ]
    for (const ref of templateRefs) {
      const template = lookup.getTemplate(ref.id, ref.revision)
      if (template === null) {
        push('template-missing', where, `${ref.id}@${ref.revision}`)
      } else if (template.capabilityId !== route.capabilityId) {
        push(
          'template-capability-mismatch',
          where,
          `${ref.id}@${ref.revision} implements ${template.capabilityId}`,
        )
      }
    }
  }

  const seenSourceKeys = new Set<string>()
  let defaults = 0
  for (const source of content.requirementSources) {
    const where = `requirementSources/${source.sourceKey}`
    if (seenSourceKeys.has(source.sourceKey)) {
      push('duplicate-source-key', where, source.sourceKey)
    }
    seenSourceKeys.add(source.sourceKey)
    if (source.isDefault) defaults += 1
    const adapter = lookup.getAdapter(source.adapterRef.id, source.adapterRef.revision)
    if (adapter === null) {
      push('adapter-missing', where, `${source.adapterRef.id}@${source.adapterRef.revision}`)
    } else if (adapter.purpose !== 'requirement-source') {
      push('adapter-purpose-mismatch', where, `purpose=${adapter.purpose}`)
    }
  }
  if (defaults > 1) {
    push('multiple-default-sources', 'requirementSources', `${defaults} defaults`)
  }

  const seenProviders = new Set<string>()
  for (const provider of content.pipelineProviders) {
    const where = `pipelineProviders/${provider.providerKey}`
    if (seenProviders.has(provider.providerKey)) {
      push('duplicate-provider-key', where, provider.providerKey)
    }
    seenProviders.add(provider.providerKey)
    const adapter = lookup.getAdapter(provider.adapterRef.id, provider.adapterRef.revision)
    if (adapter === null) {
      push('adapter-missing', where, `${provider.adapterRef.id}@${provider.adapterRef.revision}`)
    } else if (adapter.purpose !== 'pipeline-gate') {
      push('adapter-purpose-mismatch', where, `purpose=${adapter.purpose}`)
    }
  }

  if (lookup.getPolicy(content.defaultPolicyRef.id, content.defaultPolicyRef.revision) === null) {
    push(
      'policy-missing',
      'defaultPolicyRef',
      `${content.defaultPolicyRef.id}@${content.defaultPolicyRef.revision}`,
    )
  }

  return violations
}
