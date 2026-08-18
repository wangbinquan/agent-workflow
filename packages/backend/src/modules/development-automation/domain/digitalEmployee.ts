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
import { checkPredicateAgainstCatalog } from './facts'
import { checkPredicateBudget, factPredicateSchema } from './predicate'

const versionedRef = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

export type VersionedRef = z.infer<typeof versionedRef>

const ruleId = z.string().min(1).max(120)

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
    supportedRepositoryFacts: z.array(factPredicateSchema),
    capabilityRoutes: z.array(capabilityRouteSchema),
    requirementSources: z.array(requirementSourceBindingSchema),
    pipelineProviders: z.array(pipelineProviderBindingSchema),
    defaultPolicyRef: versionedRef,
  })
  .strict()

export type DigitalEmployeeContent = z.infer<typeof digitalEmployeeContentSchema>

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
  readonly where: string
  readonly detail: string
}

/** 发布闭包检查的注入查询面：store 在事务内实现，domain 不触 DB。 */
export interface EmployeePublishLookup {
  getTemplate(templateId: string, revision: number): { readonly capabilityId: string } | null
  getPolicy(policyId: string, revision: number): { readonly exists: true } | null
  getAdapter(adapterId: string, revision: number): { readonly purpose: string } | null
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
