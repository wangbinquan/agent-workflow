import type { CreateAgent, CreateWorkflow } from '@agent-workflow/shared'
import type {
  DemoResourceCatalogSeedMarkerContext,
  DemoResourceCatalogSeedReceipt,
} from '../../public/participants'

export interface PreparedDemoResourceCatalogAgentSample {
  readonly id: string
  readonly value: CreateAgent
}

export interface PreparedDemoResourceCatalogWorkflowSample {
  readonly id: string
  readonly value: CreateWorkflow
}

export interface PreparedDemoResourceCatalogSeed {
  readonly marker: DemoResourceCatalogSeedMarkerContext
  readonly agent: PreparedDemoResourceCatalogAgentSample
  readonly workflows: readonly PreparedDemoResourceCatalogWorkflowSample[]
}

export interface DemoResourceCatalogSeedPersistence {
  seed(input: PreparedDemoResourceCatalogSeed): Promise<DemoResourceCatalogSeedReceipt>
}
