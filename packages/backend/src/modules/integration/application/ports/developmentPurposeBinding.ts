import type { EvidenceStagingFactory } from '@/modules/development-automation/public/types'
import type { DevelopmentAdapterContent } from '../../domain/developmentAdapterDefinition'
import type {
  AdapterConfigurationReference,
  ApprovalAdapterEffects,
  PipelineAdapterEffects,
  RequirementAdapterEffects,
} from './developmentAdapterEffects'

/** Composition resolves each freshly published configuration into its owner's reference. */
export interface AdapterConfigurationBinding {
  configurationFor(content: DevelopmentAdapterContent): AdapterConfigurationReference
}
export interface RequirementAdapterBinding extends AdapterConfigurationBinding {
  readonly effects: RequirementAdapterEffects
}
export interface PipelineAdapterBinding extends AdapterConfigurationBinding {
  readonly effects: PipelineAdapterEffects
}
export interface ApprovalAdapterBinding extends AdapterConfigurationBinding {
  readonly effects: ApprovalAdapterEffects
  readonly staging: EvidenceStagingFactory
}
