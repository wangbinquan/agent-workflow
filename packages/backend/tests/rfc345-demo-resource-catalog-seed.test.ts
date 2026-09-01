import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDemoResourceCatalogSeedParticipant } from '../src/modules/resource-catalog/application/demoResourceCatalogSeed'
import type { DemoResourceCatalogSeedPersistence } from '../src/modules/resource-catalog/application/ports/demoResourceCatalogSeed'

const root = join(import.meta.dir, '..')

describe('RFC-345 provider-owned demo Resource Catalog seed', () => {
  test('normalizes one Agent and exactly two Workflows into a closed persistence request', async () => {
    let observed: Parameters<DemoResourceCatalogSeedPersistence['seed']>[0] | undefined
    const participant = createDemoResourceCatalogSeedParticipant({
      async seed(input) {
        observed = input
        return {
          createdAgent: true,
          createdWorkflowIds: input.workflows.map((workflow) => workflow.id),
          occupiedIdWarnings: [],
        }
      },
    })
    const definition = {
      $schema_version: 2 as const,
      inputs: [],
      nodes: [],
      edges: [],
      outputs: [],
    }

    const receipt = await participant.seed({
      marker: {
        kind: 'initial-demo-offer',
        ownerUserId: '__system__',
        offeredAt: 1_700_000_000_000,
      },
      agent: {
        id: 'demo-agent',
        name: '[demo] reviewer',
        description: 'sample',
        outputs: ['findings'],
        syncOutputsOnIterate: true,
        readonly: true,
        bodyMd: 'review',
      },
      workflows: [
        { id: 'demo-workflow-review', name: '[demo] Review', description: 'sample', definition },
        { id: 'demo-workflow-ask', name: '[demo] Ask', description: 'sample', definition },
      ],
    })

    expect(receipt.createdWorkflowIds).toEqual(['demo-workflow-review', 'demo-workflow-ask'])
    expect(observed?.agent.value.frontmatterExtra).toEqual({ readonly: true })
    expect(observed?.agent.value.permission).toEqual({})
    expect(observed?.workflows).toHaveLength(2)
  })

  test('rejects a seed shape that is not the reviewed Agent plus two Workflows', async () => {
    const participant = createDemoResourceCatalogSeedParticipant({
      seed: async () => ({
        createdAgent: false,
        createdWorkflowIds: [],
        occupiedIdWarnings: [],
      }),
    })

    await expect(
      participant.seed({
        marker: { kind: 'initial-demo-offer', ownerUserId: '__system__', offeredAt: 1 },
        agent: {
          id: 'demo-agent',
          name: '[demo] reviewer',
          description: 'sample',
          outputs: [],
          syncOutputsOnIterate: true,
          readonly: true,
          bodyMd: 'review',
        },
        workflows: [],
      }),
    ).rejects.toThrow('requires exactly two workflows')
  })

  test('keeps provider mechanics private and supplies real SQLite and PostgreSQL factories', () => {
    const publicParticipants = readFileSync(
      join(root, 'src/modules/resource-catalog/public/participants.ts'),
      'utf8',
    )
    const composition = readFileSync(
      join(root, 'src/modules/resource-catalog/composition/demoResourceCatalogSeed.ts'),
      'utf8',
    )
    const sqlite = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/sqliteDemoResourceCatalogSeed.ts'),
      'utf8',
    )
    const postgresql = readFileSync(
      join(
        root,
        'src/modules/resource-catalog/infrastructure/postgresqlDemoResourceCatalogSeed.ts',
      ),
      'utf8',
    )

    expect(publicParticipants).toContain('export interface DemoResourceCatalogSeedParticipant')
    expect(publicParticipants).toContain('readonly occupiedIdWarnings:')
    expect(publicParticipants).not.toContain('DemoResourceCatalogSeedParticipant extends DbClient')
    expect(composition).toContain('composeSqliteDemoResourceCatalogSeedParticipant')
    expect(composition).toContain('composePostgresqlDemoResourceCatalogSeedParticipant')
    expect(sqlite).toContain('dbTxSync(db, (transaction) =>')
    expect(postgresql).toContain(
      'runPostgresqlResourceCatalogTransaction(db, async (transaction) =>',
    )
    expect(postgresql).not.toContain('createSqliteDemoResourceCatalogSeedPersistence')
  })
})
