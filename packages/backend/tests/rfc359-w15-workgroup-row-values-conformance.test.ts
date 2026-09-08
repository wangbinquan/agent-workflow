// RFC-359 AC1: preserve real Workgroup create/copy/save and package writes
// while sharing their member, leader and content-field constructors.

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  CreateAgentSchema,
  CreateWorkgroupSchema,
  PackageImportReceiptSchema,
  PackagePreviewSchema,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, resourceBundleApplies, users, workgroupMembers, workgroups } from '@/db/schema'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { ResourcePackageImportDecision } from '@/modules/resource-catalog/application/package/ports'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import { workgroupRepositoryDependencies } from '@/modules/resource-catalog/composition/workgroupOperations'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import {
  resolveWorkgroupLeaderMemberId,
  workgroupContentPersistenceValues,
  workgroupMemberPersistenceValues,
} from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import { createWorkgroupRepository } from '@/modules/resource-catalog/infrastructure/workgroupRepository'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { encodeZip } from '@/util/zip'
import { ValidationError } from '@/util/errors'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { composeSqliteResourcePackageCatalogForTest } from './helpers/resourcePackageProvider'

const OWNER = 'workgroup-row-owner'
const HUMAN = 'workgroup-row-human'
const A = 'workgroup-agent-a'
const B = 'workgroup-agent-b'
const T0 = 1_700_000_000_000
const initial = { ownerUserId: OWNER, visibility: 'private' as const, aclRevision: 0 as const }

async function seed(db: ProviderNeutralDatabase) {
  const actor = buildActor({
    user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'admin', status: 'active' },
    source: 'daemon',
  })
  await db.insert(users).values([
    { ...actor.user, createdAt: T0, updatedAt: T0 },
    { id: HUMAN, username: HUMAN, displayName: 'Human', createdAt: T0, updatedAt: T0 },
  ])
  for (const [id, name] of [
    [A, 'original-agent-a'],
    [B, 'original-agent-b'],
  ] as const) {
    await db.insert(agents).values(
      createAgentPersistenceValues({
        id,
        agent: CreateAgentSchema.parse({ name }),
        ownerUserId: OWNER,
        now: T0,
      }),
    )
  }
  return { actor, authority: actor as unknown as WorkgroupOperationContext }
}

function document(mode: WorkgroupDraftSnapshot['mode'] = 'leader_worker') {
  return CreateWorkgroupSchema.parse({
    name: `row-team-${mode}`,
    description: 'original description',
    instructions: 'coordinate exact rows',
    mode,
    outputContract: 'discussion',
    ...(mode === 'leader_worker' ? { leaderDisplayName: 'Lead' } : {}),
    switches: { shareOutputs: false, directMessages: true, blackboard: false },
    maxRounds: 12,
    completionGate: true,
    clarifyBudget: 0,
    fanOut: false,
    members: [
      { memberType: 'agent', agentId: B, displayName: 'Peer', roleDesc: 'second agent' },
      { memberType: 'agent', agentId: A, displayName: 'Lead', roleDesc: 'first agent' },
      ...(mode === 'dynamic_workflow'
        ? []
        : [{ memberType: 'human', userId: HUMAN, displayName: 'Human', roleDesc: 'review' }]),
    ],
  })
}

async function physical(db: ProviderNeutralDatabase, id: string) {
  return {
    row: await db.select().from(workgroups).where(eq(workgroups.id, id)).get(),
    members: await db
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, id))
      .orderBy(workgroupMembers.sortOrder)
      .all(),
  }
}

function packageBytes(revision: number): Uint8Array {
  const input = document('leader_worker')
  const utf8 = (value: string) => new TextEncoder().encode(value)
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: row-team
  type: workgroup
  name: package-row-team
resources:
  - slug: row-team
    type: workgroup
    name: package-row-team
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'workgroup-create',
              slug: 'row-team',
              payload: {
                ...input,
                name: 'package-row-team',
                description: `package revision ${revision}`,
                members: [
                  {
                    memberType: 'agent',
                    agentRef: `external:${revision === 1 ? B : A}`,
                    displayName: 'Peer',
                    roleDesc: 'second agent',
                    sortOrder: 0,
                  },
                  {
                    memberType: 'agent',
                    agentRef: `external:${revision === 1 ? A : B}`,
                    displayName: 'Lead',
                    roleDesc: 'first agent',
                    sortOrder: 1,
                  },
                ],
              },
            },
          ],
          rootRef: 'local:row-team',
        }),
      ),
    },
  ])
}

describeEachProvider('RFC-359 Workgroup row constructors through real writers', (harness) => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDirSync(root)
  })

  function repository() {
    let ids = 0
    let clocks = 0
    return {
      ...createWorkgroupRepository(
        harness.db,
        workgroupRepositoryDependencies({
          db: harness.db,
          id: () => `row-member-${++ids}`,
          now: () => T0 + 100 + ++clocks,
        }),
      ),
      calls: () => ({ ids, clocks }),
    }
  }

  for (const mode of ['leader_worker', 'free_collab', 'dynamic_workflow'] as const) {
    test(`${mode}: create and copy preserve every row field, original member order and ID consumption`, async () => {
      const { authority } = await seed(harness.db)
      const f = repository()
      const input = document(mode)
      const created = await f.repository.create({
        authority,
        id: 'row-workgroup',
        document: input,
        initialAcl: initial,
        now: T0 + 1,
      })
      const before = await physical(harness.db, created.id)
      if (before.row === undefined) throw new Error('created workgroup row missing')
      expect(before.row).toEqual({
        id: created.id,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        mode,
        outputContract: 'discussion',
        leaderMemberId: mode === 'leader_worker' ? 'row-member-2' : null,
        shareOutputs: false,
        directMessages: true,
        blackboard: false,
        maxRounds: 12,
        completionGate: true,
        clarifyBudget: 0,
        fanOut: false,
        version: 1,
        ...initial,
        schemaVersion: 1,
        createdAt: T0 + 1,
        updatedAt: T0 + 1,
      })
      expect(before.members).toEqual(
        input.members.map((member, index) => ({
          id: `row-member-${index + 1}`,
          workgroupId: created.id,
          memberType: member.memberType,
          agentName: index === 0 ? 'original-agent-b' : index === 1 ? 'original-agent-a' : null,
          agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
          userId: member.memberType === 'human' ? (member.userId ?? null) : null,
          displayName: member.displayName,
          roleDesc: member.roleDesc,
          sortOrder: index,
          createdAt: T0 + 1,
        })),
      )
      expect(f.calls()).toEqual({ ids: input.members.length, clocks: 0 })

      await harness.db.update(agents).set({ name: 'renamed-agent-a' }).where(eq(agents.id, A))
      const copied = await f.repository.copy({
        authority,
        request: {
          id: created.id,
          copy: { expectedVersion: 1, expectedSnapshotHash: created.snapshotHash },
        },
        id: 'copied-row-workgroup',
        initialAcl: initial,
        now: T0 + 2,
      })
      const after = await physical(harness.db, copied.id)
      expect(after.row).toEqual({
        ...before.row,
        id: copied.id,
        name: copied.name,
        leaderMemberId: mode === 'leader_worker' ? `row-member-${input.members.length + 2}` : null,
        createdAt: T0 + 2,
        updatedAt: T0 + 2,
      })
      expect(after.members).toEqual(
        before.members.map((member, index) => ({
          ...member,
          id: `row-member-${input.members.length + index + 1}`,
          workgroupId: copied.id,
          agentName: member.agentId === A ? 'renamed-agent-a' : member.agentName,
          createdAt: T0 + 2,
        })),
      )
      expect(copied.name).not.toBe(created.name)
      expect(await physical(harness.db, created.id)).toEqual(before)
      expect(f.calls()).toEqual({ ids: input.members.length * 2, clocks: 0 })
    })
  }

  test('config-only save and replay retain physical members; roster replacement mints in submitted order', async () => {
    const { authority } = await seed(harness.db)
    const f = repository()
    const created = await f.repository.create({
      authority,
      id: 'row-workgroup',
      document: document(),
      initialAcl: initial,
      now: T0,
    })
    const before = await physical(harness.db, created.id)
    if (before.row === undefined) throw new Error('created workgroup row missing')
    const snapshot = { ...f.projection.snapshotOf(created), description: 'config-only' }
    const saved = await f.repository.save(authority, {
      id: created.id,
      update: { expectedVersion: 1, clientMutationId: 'config-save', snapshot },
    })
    expect(saved.receipt.outcome).toBe('committed')
    expect(await physical(harness.db, created.id)).toEqual({
      row: { ...before.row, description: 'config-only', version: 2, updatedAt: T0 + 101 },
      members: before.members,
    })
    expect(f.calls()).toEqual({ ids: 3, clocks: 1 })
    const replay = await f.repository.save(authority, {
      id: created.id,
      update: { expectedVersion: 1, clientMutationId: 'config-replay', snapshot },
    })
    expect(replay.receipt.outcome).toBe('already-current')
    expect(f.calls()).toEqual({ ids: 3, clocks: 1 })
    const replacement = { ...snapshot, members: [...snapshot.members].reverse() }
    const replaced = await f.repository.save(authority, {
      id: created.id,
      update: { expectedVersion: 2, clientMutationId: 'roster-save', snapshot: replacement },
    })
    expect(replaced.receipt.outcome).toBe('committed')
    const after = await physical(harness.db, created.id)
    expect(after.row).toEqual({
      ...before.row,
      description: 'config-only',
      version: 3,
      leaderMemberId: 'row-member-5',
      updatedAt: T0 + 102,
    })
    expect(after.members).toEqual(
      [...before.members].reverse().map((member, index) => ({
        ...member,
        id: `row-member-${index + 4}`,
        sortOrder: index,
        createdAt: T0 + 102,
      })),
    )
    expect(f.calls()).toEqual({ ids: 6, clocks: 2 })
  })

  test('created and replaced group/member rows remain inside the real outer transaction', async () => {
    const { authority } = await seed(harness.db)
    const f = repository()
    const failure = new Error('workgroup-row-rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        await f.repository.create({
          authority,
          id: 'rolled-back-workgroup',
          document: document(),
          initialAcl: initial,
          now: T0,
        })
        const inside = await physical(tx, 'rolled-back-workgroup')
        expect(inside.row?.version).toBe(1)
        expect(inside.members.map((member) => member.id)).toEqual([
          'row-member-1',
          'row-member-2',
          'row-member-3',
        ])
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await physical(harness.db, 'rolled-back-workgroup')).toEqual({
      row: undefined,
      members: [],
    })
    const created = await f.repository.create({
      authority,
      id: 'retained-workgroup',
      document: document(),
      initialAcl: initial,
      now: T0,
    })
    const before = await physical(harness.db, created.id)
    await expect(
      harness.session.transaction(async (tx) => {
        const snapshot = f.projection.snapshotOf(created)
        await f.repository.save(authority, {
          id: created.id,
          update: {
            expectedVersion: 1,
            clientMutationId: 'rollback-roster',
            snapshot: {
              ...snapshot,
              members: [...snapshot.members].reverse(),
            },
          },
        })
        const inside = await physical(tx, created.id)
        expect(inside.row?.version).toBe(2)
        expect(inside.members.map((member) => member.id)).toEqual([
          'row-member-7',
          'row-member-8',
          'row-member-9',
        ])
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await physical(harness.db, created.id)).toEqual(before)
    expect(f.calls()).toEqual({ ids: 9, clocks: 1 })
  })

  test('real package create, overwrite and replay preserve full member rows and refresh labels', async () => {
    const { actor } = await seed(harness.db)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-workgroup-row-package-'))
    roots.push(appHome)
    const box = createSecretBoxFromKey(randomBytes(32))
    const context = {
      authority: new AuthorityClaimRegistry().mintLocalAuthority({
        userId: OWNER,
        source: 'system',
      }),
      operationId: 'workgroup-package-test',
      correlationId: 'workgroup-package-test',
      now: T0,
    }
    function compose(): ComposedResourcePackageCatalog {
      // The selected clients are real. The two factories retain different mutation sessions.
      if (harness.capabilities.isolation === 'exclusive') {
        return composeSqliteResourcePackageCatalogForTest({
          db: harness.db as DbClient,
          appHome,
          box,
        })
      }
      const db = harness.db as PostgresqlDatabaseClient
      const provider = composePostgresqlResourcePackageProvider({
        db,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db }),
        pluginInstaller: {
          plannedGenerationDirectory() {
            throw new Error('workgroup fixture has no plugin installation')
          },
          async install() {
            throw new Error('workgroup fixture has no plugin installation')
          },
        },
      })
      return composePostgresqlResourcePackageCatalog({
        provider,
        execution: createPostgresqlResourcePackageExecutionAdapter({
          box,
          provider,
          atomicApply: createPostgresqlResourcePackageAtomicApplyOperations({ db, box }),
        }),
      })
    }
    const catalog = compose()
    async function preview(bytes: Uint8Array) {
      const result = await catalog.operations.inspect.invoke(
        context,
        catalog.transport.stageInspect(actor, bytes),
      )
      const view = await catalog.operations.getPreview.invoke(context, result)
      return PackagePreviewSchema.parse(JSON.parse(view.document))
    }
    async function apply(
      bytes: Uint8Array,
      previewToken: string,
      decision: ResourcePackageImportDecision,
      target = catalog,
    ) {
      const result = await target.operations.apply.invoke(
        context,
        target.transport.stageApply(actor, {
          bytes,
          previewToken,
          decisions: [decision],
          humanMemberMappings: [],
          secretInputs: [],
        }),
      )
      const view = await target.operations.getReceipt.invoke(context, result)
      return PackageImportReceiptSchema.parse(JSON.parse(view.document))
    }
    const bytes = packageBytes(1)
    const prepared = await preview(bytes)
    const decision = { localSlug: 'row-team', action: 'new' as const }
    const receipt = await apply(bytes, prepared.previewToken, decision)
    if (receipt.root === undefined) throw new Error('workgroup root missing')
    const id = receipt.root.resourceId
    const before = await physical(harness.db, id)
    if (before.row === undefined) throw new Error('created package workgroup missing')
    expect(before.row).toEqual({
      id,
      name: 'package-row-team',
      description: 'package revision 1',
      instructions: 'coordinate exact rows',
      mode: 'leader_worker',
      outputContract: 'discussion',
      leaderMemberId: before.members[1]!.id,
      shareOutputs: false,
      directMessages: true,
      blackboard: false,
      maxRounds: 12,
      completionGate: true,
      clarifyBudget: 0,
      fanOut: false,
      version: 1,
      ...initial,
      schemaVersion: 1,
      createdAt: before.row.createdAt,
      updatedAt: before.row.createdAt,
    })
    expect(before.members).toEqual(
      [B, A].map((agentId, index) => ({
        id: before.members[index]!.id,
        workgroupId: id,
        memberType: 'agent',
        agentId,
        agentName: index === 0 ? 'original-agent-b' : 'original-agent-a',
        userId: null,
        displayName: index === 0 ? 'Peer' : 'Lead',
        roleDesc: index === 0 ? 'second agent' : 'first agent',
        sortOrder: index,
        createdAt: before.row!.createdAt,
      })),
    )
    expect(new Set(before.members.map((member) => member.id)).size).toBe(2)
    expect(await apply(bytes, prepared.previewToken, decision, compose())).toEqual(receipt)
    expect(await physical(harness.db, id)).toEqual(before)
    await harness.db.update(agents).set({ name: 'renamed-agent-a' }).where(eq(agents.id, A))
    const updateBytes = packageBytes(2)
    const updatePreview = await preview(updateBytes)
    const updateDecision = { localSlug: 'row-team', action: 'overwrite' as const, targetId: id }
    const updatedReceipt = await apply(updateBytes, updatePreview.previewToken, updateDecision)
    const after = await physical(harness.db, id)
    if (after.row === undefined) throw new Error('updated package workgroup missing')
    expect(after.row).toEqual({
      ...before.row,
      description: 'package revision 2',
      version: 2,
      leaderMemberId: after.members[1]!.id,
      updatedAt: after.row.updatedAt,
    })
    expect(after.row.updatedAt).toBeGreaterThan(before.row.updatedAt)
    expect(after.members).toEqual(
      [A, B].map((agentId, index) => ({
        id: after.members[index]!.id,
        workgroupId: id,
        memberType: 'agent',
        agentId,
        agentName: index === 0 ? 'renamed-agent-a' : 'original-agent-b',
        userId: null,
        displayName: index === 0 ? 'Peer' : 'Lead',
        roleDesc: index === 0 ? 'second agent' : 'first agent',
        sortOrder: index,
        createdAt: after.row!.updatedAt,
      })),
    )
    expect(new Set([...before.members, ...after.members].map((member) => member.id)).size).toBe(4)
    expect(updatedReceipt.applied).toEqual([{ ...receipt.applied[0]!, action: 'update' }])
    expect(await apply(updateBytes, updatePreview.previewToken, updateDecision, compose())).toEqual(
      updatedReceipt,
    )
    expect(await physical(harness.db, id)).toEqual(after)
    expect((await harness.db.select().from(resourceBundleApplies)).map((row) => row.state)).toEqual(
      ['committed', 'committed'],
    )
  })
})

test('member construction preserves sparse arrays, callback receivers and per-member failure order', () => {
  const sparse = [...document().members]
  delete sparse[0]
  const counter = {
    calls: 0,
    next() {
      return `sparse-${++this.calls}`
    },
  }
  const names = new Map([[A, 'current-agent-a']])
  const rows = workgroupMemberPersistenceValues('sparse-group', sparse, T0, names, () =>
    counter.next(),
  )
  expect(Object.keys(rows)).toEqual(['1', '2'])
  expect(rows.length).toBe(3)
  expect(rows[1]).toMatchObject({ id: 'sparse-1', sortOrder: 1, agentName: 'current-agent-a' })
  expect(rows[2]).toMatchObject({ id: 'sparse-2', sortOrder: 2, agentId: null, userId: HUMAN })
  expect(counter.calls).toBe(2)
  const failure = new Error('member-display-name-failed')
  const trace: string[] = []
  const member = {
    memberType: 'agent' as const,
    agentId: A,
    get displayName(): string {
      trace.push('displayName')
      throw failure
    },
    get roleDesc(): string {
      trace.push('roleDesc')
      return 'unreached'
    },
  }
  let caught: unknown
  try {
    workgroupMemberPersistenceValues('failure-group', [member], T0, names, () => {
      trace.push('id')
      return 'consumed-before-failure'
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
  expect(trace).toEqual(['id', 'displayName'])
})

test('leader selection keeps first-match semantics and the original error', () => {
  const members = [
    { id: 'human-first', workgroupId: 'g', memberType: 'human' as const, displayName: 'Same' },
    { id: 'agent-second', workgroupId: 'g', memberType: 'agent' as const, displayName: 'Same' },
  ]
  expect(
    resolveWorkgroupLeaderMemberId({ mode: 'free_collab', leaderDisplayName: 'Same' }, members),
  ).toBeNull()
  expect(resolveWorkgroupLeaderMemberId({ mode: 'leader_worker' }, members)).toBeNull()
  let caught: unknown
  try {
    resolveWorkgroupLeaderMemberId({ mode: 'leader_worker', leaderDisplayName: 'Same' }, members)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ValidationError)
  expect(caught).toMatchObject({
    code: 'workgroup-leader-invalid',
    message: 'leaderDisplayName must match an agent member',
  })
  expect(
    resolveWorkgroupLeaderMemberId(
      { mode: 'leader_worker', leaderDisplayName: 'Same' },
      [...members].reverse(),
    ),
  ).toBe('agent-second')
})

test('content fields preserve default values and do not evaluate caller-owned trailing fields', () => {
  const input = document()
  const trace: string[] = []
  const source = {
    id: 'content-group',
    document: { ...input, clarifyBudget: undefined, fanOut: undefined },
    leaderMemberId: 'lead',
    get now() {
      trace.push('now')
      throw new Error('caller clock evaluated')
    },
  }
  const encoded = workgroupContentPersistenceValues(source)
  expect(Object.keys(encoded)).toEqual([
    'id',
    'name',
    'description',
    'instructions',
    'mode',
    'outputContract',
    'leaderMemberId',
    'shareOutputs',
    'directMessages',
    'blackboard',
    'maxRounds',
    'completionGate',
    'clarifyBudget',
    'fanOut',
    'version',
  ])
  expect(encoded).toMatchObject({ clarifyBudget: 3, fanOut: false, version: 1 })
  expect(trace).toEqual([])
  const failure = new Error('name-before-output-contract')
  const failedInput = {
    id: 'bad-content-group',
    document: {
      ...input,
      get name(): string {
        trace.push('name')
        throw failure
      },
      get outputContract() {
        trace.push('outputContract')
        return input.outputContract
      },
    },
    leaderMemberId: 'lead',
  }
  let caught: unknown
  try {
    workgroupContentPersistenceValues(failedInput)
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
  expect(trace).toEqual(['name'])
})
