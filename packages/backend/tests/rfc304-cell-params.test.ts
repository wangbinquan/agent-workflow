// RFC-304/RFC-375 — the live parameter reader preserves the exact selected cell projection.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createCapabilityParamRead } from '../src/modules/code-capability/infrastructure/capabilityParamRead'
import { describeEachProvider } from './helpers/eachProvider'

const REPO = 'repo-1'
const NOW = 1_700_000_000_000

const TABLE = JSON.stringify([
  { name: 'triggerLabel', kind: 'string', required: true },
  { name: 'maxAttempts', kind: 'number', min: 1, max: 10 },
  { name: 'strategy', kind: 'enum', options: ['fast', 'thorough'] },
])

describeEachProvider('RFC-304 T47 — resolving a cell’s parameters', (harness) => {
  let db: PersistenceDb

  beforeEach(() => {
    db = harness.db
  })

  const seed = async (over: {
    paramSchemaJson?: string
    paramDefaultsJson?: string
    paramsJson?: string
  }): Promise<void> => {
    const { capabilityTemplates, repoCapabilityConfig } = tablesOf(db)
    await insertOne(db, capabilityTemplates, {
      id: 'binding-1',
      name: 'binding-1',
      paramsJson: over.paramsJson ?? '{}',
      createdAt: NOW,
      updatedAt: NOW,
      capability: 'requirement',
      paramSchemaJson: over.paramSchemaJson ?? TABLE,
      paramDefaultsJson: over.paramDefaultsJson ?? '{}',
    })
    await insertOne(db, repoCapabilityConfig, {
      id: ulid(),
      repoId: REPO,
      capability: 'requirement',
      templateId: 'binding-1',
      enabled: true,
      readiness: 'ready',
      createdAt: NOW,
      updatedAt: NOW,
    })
  }

  test('reads the selected template schema, defaults, and overrides without changing their JSON', async () => {
    await seed({
      paramDefaultsJson: '{"triggerLabel":"aw:implement"}',
      paramsJson: '{"strategy":"thorough"}',
    })
    expect(
      await createCapabilityParamRead(db).find({ repoId: REPO, capability: 'requirement' }),
    ).toEqual({
      paramSchemaJson: TABLE,
      paramDefaultsJson: '{"triggerLabel":"aw:implement"}',
      paramsJson: '{"strategy":"thorough"}',
    })
  })
  test('an absent repository or capability returns no parameter source', async () => {
    await seed({})
    const reader = createCapabilityParamRead(db)
    expect(await reader.find({ repoId: 'repo-elsewhere', capability: 'requirement' })).toBeNull()
    expect(await reader.find({ repoId: REPO, capability: 'mr-review' })).toBeNull()
  })
})
