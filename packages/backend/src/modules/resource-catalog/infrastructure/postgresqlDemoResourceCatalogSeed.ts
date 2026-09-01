import { eq } from 'drizzle-orm'
import { agents, workflows } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  DemoResourceCatalogSeedPersistence,
  PreparedDemoResourceCatalogSeed,
} from '../application/ports/demoResourceCatalogSeed'
import type { DemoResourceCatalogSeedReceipt } from '../public/participants'
import { createAgentPersistenceValues } from './agentPersistence'
import { runPostgresqlResourceCatalogTransaction } from './postgresql/repositorySupport'
import { createWorkflowPersistenceValues } from './workflowPersistence'

type DemoResourceCatalogOccupiedIdWarning =
  DemoResourceCatalogSeedReceipt['occupiedIdWarnings'][number]

export function createPostgresqlDemoResourceCatalogSeedPersistence(
  db: PostgresqlDatabaseClient,
): DemoResourceCatalogSeedPersistence {
  return Object.freeze({
    async seed(input: PreparedDemoResourceCatalogSeed): Promise<DemoResourceCatalogSeedReceipt> {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const warnings: DemoResourceCatalogOccupiedIdWarning[] = []
        let createdAgent = false
        const createdWorkflowIds: string[] = []

        const existingAgent = await transaction
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, input.agent.id))
          .get()
        if (existingAgent === undefined) {
          await transaction
            .insert(agents)
            .values({
              ...createAgentPersistenceValues({
                id: input.agent.id,
                agent: input.agent.value,
                ownerUserId: input.marker.ownerUserId,
                now: input.marker.offeredAt,
              }),
              visibility: 'public',
            })
            .run()
          createdAgent = true
        } else if (existingAgent.name !== input.agent.value.name) {
          warnings.push({
            resourceType: 'agent',
            resourceId: input.agent.id,
            expectedName: input.agent.value.name,
            occupiedBy: existingAgent.name,
          })
        }

        for (const workflow of input.workflows) {
          const existing = await transaction
            .select({ name: workflows.name })
            .from(workflows)
            .where(eq(workflows.id, workflow.id))
            .get()
          if (existing !== undefined) {
            if (existing.name !== workflow.value.name) {
              warnings.push({
                resourceType: 'workflow',
                resourceId: workflow.id,
                expectedName: workflow.value.name,
                occupiedBy: existing.name,
              })
            }
            continue
          }
          await transaction
            .insert(workflows)
            .values({
              ...createWorkflowPersistenceValues({
                id: workflow.id,
                workflow: workflow.value,
                ownerUserId: input.marker.ownerUserId,
                now: input.marker.offeredAt,
              }),
              visibility: 'public',
            })
            .run()
          createdWorkflowIds.push(workflow.id)
        }

        return Object.freeze({
          createdAgent,
          createdWorkflowIds: Object.freeze(createdWorkflowIds),
          occupiedIdWarnings: Object.freeze(warnings.map((warning) => Object.freeze(warning))),
        })
      })
    },
  })
}
