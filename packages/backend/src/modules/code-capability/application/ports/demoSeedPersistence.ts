import type { CapabilityTemplateRecord } from './capabilityTemplatePersistence'

export interface CodeCapabilityDemoSeedAggregate {
  readonly template: CapabilityTemplateRecord
}
export interface CodeCapabilityDemoSeedPersistence {
  ensure(aggregate: CodeCapabilityDemoSeedAggregate): Promise<void>
}
