import { CreateAgentSchema, CreateWorkflowSchema } from '@agent-workflow/shared'
import { demoResourceCatalogSeedParticipantBrand } from '../domain/participantBrands'
import type {
  DemoResourceCatalogSeedInput,
  DemoResourceCatalogSeedParticipant,
  DemoResourceCatalogSeedReceipt,
} from '../public/participants'
import type {
  DemoResourceCatalogSeedPersistence,
  PreparedDemoResourceCatalogSeed,
} from './ports/demoResourceCatalogSeed'

function prepare(input: DemoResourceCatalogSeedInput): PreparedDemoResourceCatalogSeed {
  if (
    input.marker.kind !== 'initial-demo-offer' ||
    input.marker.ownerUserId.length === 0 ||
    !Number.isSafeInteger(input.marker.offeredAt) ||
    input.marker.offeredAt < 0
  ) {
    throw new Error('demo resource catalog seed marker context is invalid')
  }
  if (input.agent.id.length === 0) {
    throw new Error('demo resource catalog agent id is required')
  }
  if (input.workflows.length !== 2) {
    throw new Error('demo resource catalog seed requires exactly two workflows')
  }
  const workflowIds = new Set(input.workflows.map((workflow) => workflow.id))
  if (workflowIds.size !== input.workflows.length || workflowIds.has('')) {
    throw new Error('demo resource catalog workflow ids must be non-empty and unique')
  }

  // Demo agents intentionally carry the visible `[demo]` prefix that predates
  // the public create API's identifier grammar. Validate every other field
  // through the public schema, then restore the explicitly trusted sample
  // label; ordinary create/update paths remain strict.
  const validatedAgent = CreateAgentSchema.parse({
    name: 'demo-reviewer',
    description: input.agent.description,
    outputs: [...input.agent.outputs],
    inputs: [],
    syncOutputsOnIterate: input.agent.syncOutputsOnIterate,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: { readonly: input.agent.readonly },
    bodyMd: input.agent.bodyMd,
  })

  return Object.freeze({
    marker: Object.freeze({ ...input.marker }),
    agent: Object.freeze({
      id: input.agent.id,
      value: Object.freeze({ ...validatedAgent, name: input.agent.name }),
    }),
    workflows: Object.freeze(
      input.workflows.map((workflow) =>
        Object.freeze({
          id: workflow.id,
          value: CreateWorkflowSchema.parse({
            name: workflow.name,
            description: workflow.description,
            definition: workflow.definition,
          }),
        }),
      ),
    ),
  })
}

export function createDemoResourceCatalogSeedParticipant(
  persistence: DemoResourceCatalogSeedPersistence,
): DemoResourceCatalogSeedParticipant {
  return Object.freeze({
    [demoResourceCatalogSeedParticipantBrand]: 'demo-resource-catalog-seed-participant' as const,
    async seed(input: DemoResourceCatalogSeedInput): Promise<DemoResourceCatalogSeedReceipt> {
      return persistence.seed(prepare(input))
    },
  })
}
