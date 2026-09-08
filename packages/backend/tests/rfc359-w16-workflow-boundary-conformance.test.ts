// RFC-359 AC1: the legacy and neutral Workflow entry points share three
// definition-boundary algorithms; closure traversal and save CAS stay intact.
// These real-database cases first passed against the original implementations.

import { expect, test } from 'bun:test'
import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { users, workflows } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  WORKFLOW_NAME_INVALID_MESSAGE,
  assertCanonicalWorkflowAgentIds,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'
import { createWorkflowValidationPort } from '@/modules/resource-catalog/infrastructure/workflowValidation'
import { DomainError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

const T0 = 1_700_000_000_000
const OWNER = '01AAAAAAAAAAAAAAAAAAAAAA01'
const W1 = '01AAAAAAAAAAAAAAAAAAAAAA11'
const W2 = '01AAAAAAAAAAAAAAAAAAAAAA22'
const ROOT = { id: '01AAAAAAAAAAAAAAAAAAAAAA99', name: 'boundary-root' }

function definition(fields: Record<string, unknown> = {}): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...fields,
  })
}

function child(inputKey = 'topic', outputKey = 'result'): WorkflowDefinition {
  return definition({
    inputs: [{ kind: 'text', key: inputKey, label: inputKey }],
    nodes: [
      { id: 'in', kind: 'input', inputKey },
      {
        id: 'out',
        kind: 'output',
        ports: [{ name: outputKey, bind: { nodeId: 'in', portName: inputKey } }],
      },
    ],
    edges: [
      {
        id: 'in-out',
        source: { nodeId: 'in', portName: inputKey },
        target: { nodeId: 'out', portName: outputKey },
      },
    ],
  })
}

function calling(two = false): WorkflowDefinition {
  return definition({
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
    nodes: [
      { id: 'in', kind: 'input', inputKey: 'topic' },
      { id: 'call-one', kind: 'call-workflow', workflowName: 'shared-child', workflowId: W1 },
      ...(two
        ? [{ id: 'call-two', kind: 'call-workflow', workflowName: 'shared-child', workflowId: W2 }]
        : []),
      {
        id: 'out',
        kind: 'output',
        ports: [
          { name: 'first', bind: { nodeId: 'call-one', portName: 'result' } },
          ...(two ? [{ name: 'second', bind: { nodeId: 'call-two', portName: 'new' } }] : []),
        ],
      },
    ],
    edges: [
      {
        id: 'input-one',
        source: { nodeId: 'in', portName: 'topic' },
        target: { nodeId: 'call-one', portName: 'topic' },
      },
      {
        id: 'one-output',
        source: { nodeId: 'call-one', portName: 'result' },
        target: { nodeId: 'out', portName: 'first' },
      },
      ...(two
        ? [
            {
              id: 'input-two',
              source: { nodeId: 'in', portName: 'topic' },
              target: { nodeId: 'call-two', portName: 'subject' },
            },
            {
              id: 'two-output',
              source: { nodeId: 'call-two', portName: 'new' },
              target: { nodeId: 'out', portName: 'second' },
            },
          ]
        : []),
    ],
  })
}

async function seedWorkflow(db: ProviderNeutralDatabase, id: string, raw: string) {
  await db.insert(workflows).values({
    id,
    name: 'shared-child',
    description: 'original description',
    definition: raw,
    version: 7,
    createdAt: T0,
    updatedAt: T0 + 19,
  })
}

async function readRow(db: ProviderNeutralDatabase, id: string) {
  const row = await db.select().from(workflows).where(eq(workflows.id, id)).get()
  if (row === undefined) throw new Error(`workflow boundary fixture row missing: ${id}`)
  return row
}

function validator(db: ProviderNeutralDatabase) {
  return createWorkflowValidationPort({ db, skillContent: { isAvailable: async () => true } })
}

async function wireError(run: () => unknown) {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) {
      return JSON.parse(JSON.stringify({ status: error.status, ...error.toPayload() }))
    }
    throw error
  }
  throw new Error('expected a workflow boundary DomainError')
}

async function owner(db: ProviderNeutralDatabase) {
  await db.insert(users).values({
    id: OWNER,
    username: 'workflow-boundary-owner',
    displayName: 'Workflow boundary owner',
    createdAt: T0,
    updatedAt: T0,
  })
  const identity = await admitTestDirectAuthority(
    createIdentityAccessRuntime({ db }).directAuthority,
    { source: 'session', userId: OWNER },
  )
  if (identity === null) throw new Error('workflow boundary fixture actor unavailable')
  return identity.actor
}

function repository(db: ProviderNeutralDatabase, events: string[], clock: () => number) {
  return createWorkflowRepository({
    db,
    id: () => W1,
    now: clock,
    semantics: createWorkflowPersistenceSemantics({
      authorization: composeResourceCatalogFor({ db }).authorization,
      events: {
        created: (row) => {
          events.push(`created:${row.version}`)
        },
        updated: (receipt) => {
          events.push(`updated:${receipt.revision.version}`)
        },
        deleted: (_id, version) => {
          events.push(`deleted:${version}`)
        },
      },
    }),
  })
}

describeEachProvider('RFC-359 W16 Workflow definition boundaries', (harness) => {
  test('stored v1–v6 definitions resolve the same real input/output ports without rewriting rows', async () => {
    const rawChild = child()
    const latest = migrateWorkflowDefinitionToLatest(rawChild)
    await seedWorkflow(harness.db, W1, JSON.stringify(latest))
    const port = validator(harness.db)
    const candidate = { definition: calling(), currentWorkflow: ROOT }
    const expected = await port.validate(candidate)
    expect(expected.result).toEqual({ ok: true, issues: [] })
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const raw = JSON.stringify(version === 6 ? latest : { ...rawChild, $schema_version: version })
      await harness.db.update(workflows).set({ definition: raw }).where(eq(workflows.id, W1))
      const before = await readRow(harness.db, W1)
      expect(await port.validate(candidate)).toEqual(expected)
      expect(await readRow(harness.db, W1)).toEqual(before)
      expect(before.definition).toBe(raw)
    }
  })

  test('unreadable stored rows stay absent and later valid content resolves without changing the source bytes', async () => {
    await seedWorkflow(harness.db, W1, '{')
    const port = validator(harness.db)
    const candidate = { definition: calling(), currentWorkflow: ROOT }
    for (const raw of ['{', 'null', '{}', '{"$schema_version":6,"nodes":"wrong","edges":[]}']) {
      await harness.db.update(workflows).set({ definition: raw }).where(eq(workflows.id, W1))
      const before = await readRow(harness.db, W1)
      const result = await port.validate(candidate)
      expect(result.result.ok).toBe(false)
      expect(
        result.result.issues.filter((issue) => issue.code === 'call-workflow-ref-missing'),
      ).toHaveLength(1)
      expect(await readRow(harness.db, W1)).toEqual(before)
    }
    const raw = JSON.stringify(child())
    await harness.db.update(workflows).set({ definition: raw }).where(eq(workflows.id, W1))
    expect((await port.validate(candidate)).result).toEqual({ ok: true, issues: [] })
    expect((await readRow(harness.db, W1)).definition).toBe(raw)
  })

  test('same-name id hints keep distinct ports; a renamed hint falls back to the original name winner', async () => {
    await seedWorkflow(harness.db, W2, JSON.stringify(child('subject', 'new')))
    await seedWorkflow(harness.db, W1, JSON.stringify(child()))
    const port = validator(harness.db)
    const candidate = { definition: calling(true), currentWorkflow: ROOT }
    expect((await port.validate(candidate)).result).toEqual({ ok: true, issues: [] })
    await harness.db.update(workflows).set({ name: 'renamed-child' }).where(eq(workflows.id, W2))
    const renamed = await port.validate(candidate)
    expect(renamed.result.ok).toBe(false)
    expect(renamed.result.issues.map((issue) => issue.code)).toContain('edge-target-port-missing')
    expect(renamed.result.issues.map((issue) => issue.code)).toContain('edge-source-port-missing')
    expect(renamed.result.issues.map((issue) => issue.code)).not.toContain(
      'call-workflow-ref-missing',
    )
  })

  test('canonical node errors preserve sorted details and precede changed-name parsing without writing rows', async () => {
    const actor = await owner(harness.db)
    const events: string[] = []
    let clockCalls = 0
    const repo = repository(harness.db, events, () => {
      clockCalls += 1
      return T0
    })
    const invalid = definition({
      nodes: [
        { id: 'z-node', kind: 'agent-single' },
        { id: 'ignored', kind: 'output' },
        { id: 'a-node', kind: 'agent-single' },
      ],
    })
    const raw = JSON.stringify(invalid)
    const legacy = await wireError(() => assertCanonicalWorkflowAgentIds(invalid))
    expect(legacy).toEqual({
      status: 422,
      ok: false,
      code: 'workflow-agent-id-required',
      message: 'agent-single nodes require a canonical agentId',
      details: { nodeIds: ['a-node', 'z-node'] },
    })
    expect(
      await wireError(() =>
        repo.create(actor, { name: '_invalid', description: '', definition: invalid }),
      ),
    ).toEqual(legacy)
    expect(await harness.db.select().from(workflows).where(eq(workflows.id, W1))).toEqual([])
    expect(clockCalls).toBe(0)
    expect(events).toEqual([])
    const created = await repo.create(actor, {
      name: 'boundary-create',
      description: '',
      definition: definition(),
    })
    const before = await readRow(harness.db, created.id)
    expect(
      await wireError(() =>
        repo.update(actor, created.id, {
          expectedVersion: 1,
          clientMutationId: W2,
          snapshot: { name: '_invalid', description: '', definition: invalid },
        }),
      ),
    ).toEqual(legacy)
    expect(await readRow(harness.db, created.id)).toEqual(before)
    expect(events).toEqual(['created:1'])
    expect(JSON.stringify(invalid)).toBe(raw)
  })

  test('historical names, changed-name errors and outer rollback preserve rows and the existing callback timing', async () => {
    const actor = await owner(harness.db)
    const events: string[] = []
    let now = T0
    const repo = repository(harness.db, events, () => now)
    const created = await repo.create(actor, {
      name: 'boundary-create',
      description: '',
      definition: definition({ $schema_version: 1 }),
    })
    expect(JSON.parse((await readRow(harness.db, created.id)).definition).$schema_version).toBe(6)
    await harness.db
      .update(workflows)
      .set({ name: 'Legacy Name With Spaces' })
      .where(eq(workflows.id, created.id))
    now += 100
    const saved = await repo.update(actor, created.id, {
      expectedVersion: 1,
      clientMutationId: W2,
      snapshot: {
        name: 'Legacy Name With Spaces',
        description: 'saved',
        definition: created.definition,
      },
    })
    expect(saved).toMatchObject({ outcome: 'committed', revision: { version: 2, updatedAt: now } })
    const before = await readRow(harness.db, created.id)
    expect(
      await wireError(() =>
        repo.update(actor, created.id, {
          expectedVersion: 2,
          clientMutationId: W2,
          snapshot: { name: '_invalid', description: 'bad rename', definition: created.definition },
        }),
      ),
    ).toMatchObject({
      status: 422,
      code: 'workflow-name-invalid',
      message: WORKFLOW_NAME_INVALID_MESSAGE,
    })
    expect(await readRow(harness.db, created.id)).toEqual(before)
    expect(events).toEqual(['created:1', 'updated:2'])
    const sentinel = new Error('workflow boundary outer rollback')
    now += 100
    await expect(
      harness.session.transaction(async (tx) => {
        const renamed = await repo.update(actor, created.id, {
          expectedVersion: 2,
          clientMutationId: W2,
          snapshot: {
            name: '新工作流',
            description: 'rolled back',
            definition: created.definition,
          },
        })
        expect(renamed).toMatchObject({
          outcome: 'committed',
          revision: { version: 3, updatedAt: now },
        })
        expect(await readRow(tx, created.id)).toMatchObject({
          name: '新工作流',
          description: 'rolled back',
          version: 3,
        })
        throw sentinel
      }),
    ).rejects.toBe(sentinel)
    expect(await readRow(harness.db, created.id)).toEqual(before)
    // The existing repository callback runs after its nested save returns;
    // an outer rollback restores the row but does not retract that callback.
    expect(events).toEqual(['created:1', 'updated:2', 'updated:3'])
  })
})
