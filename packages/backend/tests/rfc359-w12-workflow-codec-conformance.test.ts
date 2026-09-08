// RFC-359 W12 —— workflow 的 legacy / 中立投影先在旧实现上对拍，再合成一份。
// 真数据库存量行覆盖 v1–v6、坏行错误、迁移后的详情/修订、普通保存与外层回滚。
// 两个 hash 入口原来处于不同输入阶段：legacy 先迁移，neutral raw hash 直接编码；
// 这条区别也锁住，不能为了去重改变已有输入语义。

import { expect, test } from 'bun:test'
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { users, workflows } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  rowToWorkflowDetail,
  workflowDraftSnapshotOf as legacyDraft,
  workflowRevisionOf as legacyRevision,
  workflowSnapshotHashOf as legacyHash,
  workflowToDetail as legacyDetail,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import {
  workflowDetailOf,
  workflowDraftSnapshotOf,
  workflowFromPersistenceRow,
  workflowRevisionOf,
  workflowSnapshotHashOf,
} from '@/modules/resource-catalog/infrastructure/workflowPersistence'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'
import { DomainError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000
const VERSIONS = [1, 2, 3, 4, 5, 6] as const

function emptyDefinition(version: (typeof VERSIONS)[number] = 6): WorkflowDefinition {
  return { $schema_version: version, inputs: [], nodes: [], edges: [] }
}

async function storedRow(db: ProviderNeutralDatabase, definition: string) {
  const id = ulid()
  await db.insert(workflows).values({
    id,
    name: '  Legacy  工作流  ',
    description: '描述\nsecond line',
    definition,
    version: 7,
    ownerUserId: null,
    visibility: 'public',
    aclRevision: 3,
    builtin: false,
    schemaVersion: 1,
    createdAt: T0,
    updatedAt: T0 + 123,
  })
  return readRow(db, id)
}

async function readRow(db: ProviderNeutralDatabase, id: string) {
  const row = (await db.select().from(workflows).where(eq(workflows.id, id)).limit(1))[0]
  if (row === undefined) throw new Error(`workflow codec fixture row missing: ${id}`)
  return row
}

function domainError(run: () => unknown): DomainError {
  try {
    run()
  } catch (error) {
    if (error instanceof DomainError) return error
    throw error
  }
  throw new Error('expected a workflow codec DomainError')
}

function wireError(error: DomainError): unknown {
  // Zod issue trees can contain Error instances and method references; the API
  // publishes their JSON data, not their caller-specific stacks or functions.
  return JSON.parse(JSON.stringify({ status: error.status, ...error.toPayload() }))
}

async function owner(db: ProviderNeutralDatabase): Promise<DirectAuthenticatedAuthority> {
  const id = ulid()
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    createdAt: T0,
    updatedAt: T0,
  })
  return buildActor({
    source: 'session',
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
  }) as unknown as DirectAuthenticatedAuthority
}

function repositoryFor(db: ProviderNeutralDatabase, now: () => number) {
  const catalog = composeResourceCatalogFor({ db })
  return createWorkflowRepository({
    db,
    now,
    semantics: createWorkflowPersistenceSemantics({ authorization: catalog.authorization }),
  })
}

describeEachProvider('RFC-359 W12 —— workflow codec', (harness) => {
  for (const version of VERSIONS) {
    test(`真实 v${version} 行的完整详情 / 快照 / 修订相同，投影零 SQL 且不改存量行`, async () => {
      const raw = JSON.stringify(emptyDefinition(version))
      const row = Object.freeze(await storedRow(harness.db, raw))
      const before = JSON.stringify(row)
      const recording = harness.recordStatements()
      try {
        const legacy = rowToWorkflowDetail(row)
        const workflow = workflowFromPersistenceRow(row)
        const detail = workflowDetailOf(workflow)
        expect(detail).toEqual(legacy)
        expect(legacyDetail(workflow)).toEqual(detail)
        expect(detail).toEqual({
          id: row.id,
          name: '  Legacy  工作流  ',
          description: '描述\nsecond line',
          definition: emptyDefinition(),
          version: 7,
          ownerUserId: null,
          visibility: 'public',
          builtin: false,
          schemaVersion: 1,
          createdAt: T0,
          updatedAt: T0 + 123,
          snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        })
        expect(workflowDraftSnapshotOf(workflow)).toEqual(legacyDraft(workflow))
        expect(workflowRevisionOf(workflow)).toEqual(legacyRevision(workflow))
        expect(workflowRevisionOf(workflow)).toEqual({
          workflowId: row.id,
          version: 7,
          snapshotHash: detail.snapshotHash,
          updatedAt: T0 + 123,
        })
        expect(JSON.stringify(row)).toBe(before)
        expect(recording.statements).toEqual([])
      } finally {
        recording.stop()
      }
      expect(await readRow(harness.db, row.id)).toEqual(row)
      expect(row.definition).toBe(raw)
      expect(JSON.parse(row.definition)).toHaveProperty('$schema_version', version)
    })
  }

  test('真实 v5 非空图升级端口边，保留节点顺序和既有内容', async () => {
    const raw = JSON.stringify({
      $schema_version: 5,
      nodes: [
        { id: 'writer', kind: 'agent-single', agentId: ulid(), title: '写作' },
        { id: 'rv', kind: 'review', inputSource: { nodeId: 'writer', portName: 'doc' } },
        {
          id: 'out',
          kind: 'output',
          ports: [
            { name: 'report', bind: { nodeId: 'writer', portName: 'doc' } },
            { name: 'notes', bind: { nodeId: 'writer', portName: 'notes' } },
          ],
        },
      ],
      edges: [],
    })
    const row = await storedRow(harness.db, raw)
    const detail = workflowDetailOf(workflowFromPersistenceRow(row))
    expect(detail).toEqual(rowToWorkflowDetail(row))
    expect(detail.definition.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    expect(detail.definition.nodes.map((node) => node.id)).toEqual(['writer', 'rv', 'out'])
    expect(detail.definition.nodes[0]?.title).toBe('写作')
    expect(detail.definition.edges).toEqual([
      {
        id: 'writer_doc_to_rv___review_input__',
        source: { nodeId: 'writer', portName: 'doc' },
        target: { nodeId: 'rv', portName: '__review_input__' },
      },
      {
        id: 'writer_doc_to_out_report',
        source: { nodeId: 'writer', portName: 'doc' },
        target: { nodeId: 'out', portName: 'report' },
      },
      {
        id: 'writer_notes_to_out_notes',
        source: { nodeId: 'writer', portName: 'notes' },
        target: { nodeId: 'out', portName: 'notes' },
      },
    ])
    expect(detail.definition.nodes[1]).not.toHaveProperty('inputSource')
    expect(detail.definition.nodes[2]).not.toHaveProperty('ports')
    expect((await readRow(harness.db, row.id)).definition).toBe(raw)
  })

  test.each([
    ['{', 'stored definition is not JSON'],
    ['null', 'stored definition is invalid'],
    ['{"nodes":"bad"}', 'stored definition is invalid'],
  ] as const)('真实坏行 %s 保持相同 422 错误内容', async (definition, message) => {
    const row = await storedRow(harness.db, definition)
    const legacy = domainError(() => rowToWorkflowDetail(row))
    const neutral = domainError(() => workflowFromPersistenceRow(row))
    expect(wireError(neutral)).toEqual(wireError(legacy))
    expect(wireError(neutral)).toMatchObject({
      ok: false,
      status: 422,
      code: 'workflow-definition-corrupt',
      message,
      details: { workflowId: row.id },
    })
    expect(await readRow(harness.db, row.id)).toEqual(row)
  })

  test('legacy 先迁移再 hash，neutral raw hash 保持原始草稿输入阶段', () => {
    const latestHash = 'b0a1b4c7bec987e752802f012797f83b09e9acac314799be94bd538701492cf2'
    const rawHashes = [
      'cf3a666ae11b138d81691c1cf27299ec708b68ac22a537ec6077de5797cd26b2',
      'b1be4083af8ea2c1abc7abf3e8848dc7b3c181ed0b20c87dc9c0cc5dfb403874',
      'c167f800d553d64f65f6ddde0e763aca4edfbe96002d3b3c2f7eb5110b1359d9',
      '69d83ac0b1f88f0ad17bd8dcd3de059af5436da988abca7e0300ae450e3d4695',
      '98d1c072952a57b284b9fd5ebedd5c59f939ad42eda0becc93958d1a963d9688',
      latestHash,
    ]
    for (const version of VERSIONS) {
      const snapshot = {
        name: 'Codec probe',
        description: 'same frozen row',
        definition: emptyDefinition(version),
      }
      const before = JSON.stringify(snapshot)
      expect(legacyHash(snapshot)).toBe(latestHash)
      expect(workflowSnapshotHashOf(snapshot)).toBe(rawHashes[version - 1]!)
      expect(JSON.stringify(snapshot)).toBe(before)
    }
  })

  test('hash 忽略对象键顺序，保留数组顺序；raw hash 的严格输入边界不改变', () => {
    const snapshot: WorkflowDraftSnapshot = {
      name: 'key order',
      description: '',
      definition: {
        ...emptyDefinition(),
        nodes: [
          { id: 'z', kind: 'input', metadata: { z: 1, a: 2 } },
          { id: 'a', kind: 'input' },
        ],
      },
    }
    const reordered = {
      definition: {
        ...snapshot.definition,
        nodes: [
          { metadata: { a: 2, z: 1 }, kind: 'input' as const, id: 'z' },
          { kind: 'input' as const, id: 'a' },
        ],
      },
      description: '',
      name: 'key order',
    }
    expect(workflowSnapshotHashOf(snapshot)).toBe(workflowSnapshotHashOf(reordered))
    expect(legacyHash(snapshot)).toBe(workflowSnapshotHashOf(snapshot))
    expect(workflowSnapshotHashOf(snapshot)).not.toBe(
      workflowSnapshotHashOf({
        ...snapshot,
        definition: { ...snapshot.definition, nodes: [...snapshot.definition.nodes].reverse() },
      }),
    )
    const withExtra = { ...snapshot, obsolete: true }
    expect(() => workflowSnapshotHashOf(withExtra)).toThrow()
    expect(legacyHash(withExtra)).toBe(legacyHash(snapshot))
  })

  test('真实仓库 create/get/save/replay/stale 的回执与持久化投影一致', async () => {
    let now = T0
    const repository = repositoryFor(harness.db, () => now)
    const actor = await owner(harness.db)
    const created = await repository.create(actor, {
      name: 'codec-save',
      description: 'first',
      definition: emptyDefinition(1),
    })
    expect(created).toEqual(rowToWorkflowDetail(await readRow(harness.db, created.id)))
    expect(await repository.get(created.id)).toEqual(created)
    expect(created).toMatchObject({ version: 1, createdAt: T0, updatedAt: T0 })

    now += 500
    const snapshot = { ...legacyDraft(created), description: 'second' }
    const clientMutationId = ulid()
    const saved = await repository.update(actor, created.id, {
      expectedVersion: 1,
      clientMutationId,
      snapshot,
    })
    const stored = await readRow(harness.db, created.id)
    expect(saved).toEqual({
      outcome: 'committed',
      clientMutationId,
      requestedBaseVersion: 1,
      snapshot,
      revision: legacyRevision(rowToWorkflowDetail(stored)),
    })
    expect(saved.revision).toMatchObject({ version: 2, updatedAt: T0 + 500 })
    expect(stored.createdAt).toBe(T0)

    now += 500
    const replay = await repository.update(actor, created.id, {
      expectedVersion: 1,
      clientMutationId,
      snapshot,
    })
    expect(replay).toEqual({ ...saved, outcome: 'already-current' })
    await expect(
      repository.update(actor, created.id, {
        expectedVersion: 1,
        clientMutationId: ulid(),
        snapshot: { ...snapshot, description: 'stale different bytes' },
      }),
    ).rejects.toMatchObject({
      code: 'resource-operation-stale',
      details: { current: saved.revision },
    })
    expect(await readRow(harness.db, created.id)).toEqual(stored)
    expect(await repository.get(created.id)).toEqual(rowToWorkflowDetail(stored))
  })

  test('真实外层事务回滚带走仓库保存，codec 不铸额外版本或时间戳', async () => {
    let now = T0
    const repository = repositoryFor(harness.db, () => now)
    const actor = await owner(harness.db)
    const created = await repository.create(actor, {
      name: 'codec-rollback',
      description: 'kept',
      definition: emptyDefinition(),
    })
    const before = await readRow(harness.db, created.id)
    const sentinel = new Error('codec outer rollback')
    now += 999
    await expect(
      harness.session.transaction(async () => {
        const saved = await repository.update(actor, created.id, {
          expectedVersion: 1,
          clientMutationId: ulid(),
          snapshot: { ...legacyDraft(created), description: 'rolled back' },
        })
        const inTransaction = await readRow(harness.db, created.id)
        expect(inTransaction).toMatchObject({ version: 2, updatedAt: T0 + 999 })
        expect(saved.revision).toEqual(legacyRevision(rowToWorkflowDetail(inTransaction)))
        throw sentinel
      }),
    ).rejects.toBe(sentinel)
    expect(await readRow(harness.db, created.id)).toEqual(before)
    expect(await repository.get(created.id)).toEqual(created)
  })
})
