import { assertEvidenceStagingFactory } from '@/modules/development-automation/public/participants'
import type { EvidenceStagingFactory } from '@/modules/development-automation/public/types'
import type {
  ApprovalAdapterBinding,
  PipelineAdapterBinding,
  RequirementAdapterBinding,
} from './ports/developmentPurposeBinding'

/** Invalid complete choices fail before stage allocation or program preparation. */
export function assertDevelopmentAdapterBinding(
  binding: RequirementAdapterBinding | PipelineAdapterBinding | ApprovalAdapterBinding,
  members: readonly string[],
  staging: readonly EvidenceStagingFactory[] = [],
): void {
  if (typeof binding?.configurationFor !== 'function') {
    throw new Error('development-adapter-configuration-binding-incomplete')
  }
  const effects = binding.effects
  if (
    effects?.namespace?.kind !== 'evidence-staging-namespace' ||
    typeof effects.programs?.bind !== 'function'
  ) {
    throw new Error('development-adapter-purpose-incomplete:programs.bind')
  }
  const receiver = effects as unknown as Record<string, unknown>
  for (const member of members) {
    if (typeof receiver[member] !== 'function') {
      throw new Error(`development-adapter-purpose-incomplete:${member}`)
    }
  }
  for (const factory of staging) {
    assertEvidenceStagingFactory(factory)
    if (factory.namespace.reference !== effects.namespace.reference) {
      throw new Error('development-adapter-staging-namespace-mismatch')
    }
  }
}
