// RFC-359 W4-B2 —— 演示目录种子的持久化：一份实现，两个 provider 共用。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  DemoResourceCatalogSeedPersistence,
  PreparedDemoResourceCatalogSeed,
} from '../application/ports/demoResourceCatalogSeed'
import type { DemoResourceCatalogSeedReceipt } from '../public/participants'
import { createAgentPersistenceValues } from './agentPersistence'
import { runResourceCatalogTransaction } from './resourceCatalogTransaction'
import { createWorkflowPersistenceValues } from './workflowPersistence'

type DemoResourceCatalogOccupiedIdWarning =
  DemoResourceCatalogSeedReceipt['occupiedIdWarnings'][number]

export function createDemoResourceCatalogSeedPersistence(
  db: PersistenceDb,
): DemoResourceCatalogSeedPersistence {
  return Object.freeze({
    async seed(input: PreparedDemoResourceCatalogSeed): Promise<DemoResourceCatalogSeedReceipt> {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const warnings: DemoResourceCatalogOccupiedIdWarning[] = []
        let createdAgent = false
        const createdWorkflowIds: string[] = []

        const { agents, workflows } = tablesOf(transaction)
        const existingAgent = await first(
          transaction
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, input.agent.id)),
        )
        if (existingAgent === undefined) {
          await insertOne(transaction, agents, {
            ...createAgentPersistenceValues({
              id: input.agent.id,
              agent: input.agent.value,
              ownerUserId: input.marker.ownerUserId,
              now: input.marker.offeredAt,
            }),
            visibility: 'public',
          })
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
          const existing = await first(
            transaction
              .select({ name: workflows.name })
              .from(workflows)
              .where(eq(workflows.id, workflow.id)),
          )
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
          await insertOne(transaction, workflows, {
            ...createWorkflowPersistenceValues({
              id: workflow.id,
              workflow: workflow.value,
              ownerUserId: input.marker.ownerUserId,
              now: input.marker.offeredAt,
            }),
            visibility: 'public',
          })
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
