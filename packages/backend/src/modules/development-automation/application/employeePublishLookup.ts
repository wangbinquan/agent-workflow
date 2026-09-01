import type { AsyncEmployeePublishLookup } from './ports/developmentConfigPersistence'
import type {
  DigitalEmployeeContent,
  EmployeePublishLookup,
  VersionedRef,
} from '../domain/digitalEmployee'

function uniqueRefs(refs: readonly VersionedRef[]): VersionedRef[] {
  return [...new Map(refs.map((ref) => [`${ref.id}\u0000${ref.revision}`, ref])).values()]
}

/** Loads every exact cross-resource ref before running the synchronous domain validator. */
export async function loadEmployeePublishLookup(
  content: DigitalEmployeeContent,
  queries: AsyncEmployeePublishLookup,
): Promise<EmployeePublishLookup> {
  const steps = content.steps ?? []
  const templateRefs = uniqueRefs([
    ...content.capabilityRoutes.flatMap((route) => [
      ...route.rules.map((rule) => rule.templateRef),
      ...(route.fallbackTemplateRef === null ? [] : [route.fallbackTemplateRef]),
    ]),
    ...steps.flatMap((step) =>
      step.producer.kind === 'agent' ||
      step.producer.kind === 'script' ||
      step.producer.kind === 'approval-prepare'
        ? [step.producer.implementationRef]
        : [],
    ),
    ...(content.problemProducers ?? []).map((producer) => producer.implementationRef),
    ...(content.problemHandlers ?? []).map((handler) => handler.handler.implementationRef),
  ])
  const adapterRefs = uniqueRefs([
    ...content.requirementSources.map((source) => source.adapterRef),
    ...content.pipelineProviders.map((provider) => provider.adapterRef),
    ...steps.flatMap((step) =>
      step.producer.kind === 'approval-submit' || step.producer.kind === 'approval-observe'
        ? [step.producer.adapterRef]
        : [],
    ),
  ])
  const employeeRefs = uniqueRefs(
    steps.flatMap((step) =>
      step.producer.kind === 'digital-employee' ? [step.producer.employeeRef] : [],
    ),
  )

  const templateEntries = await Promise.all(
    templateRefs.map(
      async (ref) =>
        [
          `${ref.id}\u0000${ref.revision}`,
          await queries.getTemplate(ref.id, ref.revision),
        ] as const,
    ),
  )
  const adapterEntries = await Promise.all(
    adapterRefs.map(
      async (ref) =>
        [`${ref.id}\u0000${ref.revision}`, await queries.getAdapter(ref.id, ref.revision)] as const,
    ),
  )
  const employeeEntries = await Promise.all(
    employeeRefs.map(
      async (ref) =>
        [
          `${ref.id}\u0000${ref.revision}`,
          await queries.getEmployee(ref.id, ref.revision),
        ] as const,
    ),
  )
  const policy = await queries.getPolicy(
    content.defaultPolicyRef.id,
    content.defaultPolicyRef.revision,
  )
  const templates = new Map(templateEntries)
  const adapters = new Map(adapterEntries)
  const employees = new Map(employeeEntries)
  const key = (id: string, revision: number): `${string}\u0000${number}` => `${id}\u0000${revision}`
  return {
    getTemplate: (id, revision) => templates.get(key(id, revision)) ?? null,
    getAdapter: (id, revision) => adapters.get(key(id, revision)) ?? null,
    getEmployee: (id, revision) => employees.get(key(id, revision)) ?? null,
    getPolicy: (id, revision) =>
      id === content.defaultPolicyRef.id && revision === content.defaultPolicyRef.revision
        ? policy
        : null,
  }
}
