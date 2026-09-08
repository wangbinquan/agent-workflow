// RFC-359 AC1: one MCP insert/update atom, with the existing id-only and
// captured-row match contracts and transactional runtime-test invalidation.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import ts from 'typescript'
import {
  PackageImportReceiptSchema,
  PackagePreviewSchema,
  type CreateMcp,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { mcps, mcpRuntimeTestSessions, resourceBundleApplies, users } from '@/db/schema'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { McpCreateRecord } from '@/modules/resource-catalog/application/mcps/ports'
import type { ResourcePackageImportDecision } from '@/modules/resource-catalog/application/package/ports'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import {
  commitLegacyMcpCreateInTx,
  commitLegacyMcpUpdateInTx,
  mcpConfigHash,
  mcpFromPersistenceRow,
  updateMcpRowInTx,
} from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import { createMcpRepository } from '@/modules/resource-catalog/infrastructure/mcpRepository'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { composeSqliteResourcePackageCatalogForTest } from './helpers/resourcePackageProvider'

const OWNER = 'mcp-publication-owner'
const T0 = 1_700_000_000_000
const HASH = 'a'.repeat(64)
const utf8 = (value: string) => new TextEncoder().encode(value)
const localInput: CreateMcp = {
  name: 'mcp-example',
  description: 'original',
  type: 'local',
  config: { command: ['node', 'mcp.js'], env: { MODE: 'one' } },
  enabled: true,
}
const remoteInput: CreateMcp = {
  name: 'mcp-remote',
  description: 'remote',
  type: 'remote',
  config: { url: 'https://example.test/mcp' },
  enabled: false,
}
function record(id: string, input = localInput): McpCreateRecord {
  return {
    id,
    input: { ...input, name: id },
    ownerUserId: OWNER,
    visibility: 'private',
    aclRevision: 0,
    now: T0,
  }
}
function sessionInput(mcpId: string, busy: boolean): typeof mcpRuntimeTestSessions.$inferInsert {
  return {
    id: `session-${mcpId}`,
    mcpId,
    ownerUserId: OWNER,
    clientCreateId: `create-${mcpId}`,
    clientCreateDigest: HASH,
    status: 'active',
    mcpConfigHash: HASH,
    runtimeRowId: 'runtime-mcp-test',
    runtimeName: 'mcp-test',
    runtimeProtocol: 'opencode',
    runtimeSnapshotJson: '{}',
    runtimeBinaryPath: '/unused/mcp-test',
    runtimeSessionId: `native-${mcpId}`,
    nativeSessionState: 'ready',
    inFlightTurnId: busy ? 'turn-in-flight' : null,
    turnSeq: 3,
    sessionVersion: 7,
    idleDeadlineAt: busy ? null : T0 + 60_000,
    scratchRoot: `/unused/${mcpId}`,
    cleanupState: 'not-started',
    createdAt: T0,
    updatedAt: T0,
  }
}
function mcpPackage(revision: number): Uint8Array {
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: mcp-example
  type: mcp
  name: package-mcp
resources:
  - slug: mcp-example
    type: mcp
    name: package-mcp
requirements:
  executables: [node]
  mcpKinds: [local]
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
              kind: 'mcp-create',
              slug: 'mcp-example',
              payload: {
                ...localInput,
                name: 'package-mcp',
                description: `revision ${revision}`,
                config: {
                  command: ['node', `mcp-${revision}.js`],
                  env: { MODE: String(revision) },
                },
                enabled: revision === 1,
              },
            },
          ],
          rootRef: 'local:mcp-example',
        }),
      ),
    },
  ])
}

describeEachProvider('RFC-359 MCP shared mutation atoms', (harness) => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDirSync(root)
  })
  async function seedOwner() {
    await harness.db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'MCP Owner',
      role: 'admin',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    })
  }
  function repository() {
    return createMcpRepository({ db: harness.db, lifecycle: createMcpTransactionLifecycle() })
      .repository
  }
  async function stored(id: string) {
    return (await harness.db.select().from(mcps).where(eq(mcps.id, id)).limit(1))[0]
  }
  async function session(mcpId: string) {
    return (
      await harness.db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.mcpId, mcpId))
        .limit(1)
    )[0]
  }

  for (const input of [localInput, remoteInput]) {
    test(`repository ${input.type} create preserves every stored column and supplied clock`, async () => {
      await seedOwner()
      const value = record(`create-${input.type}`, input)
      const created = await repository().create(value)
      expect(created).toEqual({
        ...value.input,
        id: value.id,
        ownerUserId: OWNER,
        visibility: 'private',
        aclRevision: 0,
        schemaVersion: 1,
        createdAt: T0,
        updatedAt: T0,
      })
      expect(await stored(value.id)).toEqual({
        ...created,
        ownerUserId: OWNER,
        visibility: 'private',
        aclRevision: 0,
        config: JSON.stringify(value.input.config),
      })
      expect(await repository().get(value.id)).toEqual(created)
    })
  }

  test('repository partial update omits absent fields and keeps its captured clock', async () => {
    await seedOwner()
    const original = await repository().create(record('partial-mcp'))
    const changed = await repository().update({
      id: original.id,
      expectedConfigHash: mcpConfigHash(original),
      set: { description: 'metadata only', updatedAt: T0 + 41 },
    })
    expect(changed).toEqual({ ...original, description: 'metadata only', updatedAt: T0 + 41 })
    expect(await stored(original.id)).toEqual({
      ...changed,
      ownerUserId: OWNER,
      visibility: 'private',
      aclRevision: 0,
      config: JSON.stringify(original.config),
    })
  })

  for (const busy of [false, true]) {
    for (const enabled of [true, false]) {
      test(`repository mutation invalidates ${busy ? 'busy' : 'idle'} sessions when ${enabled ? 'config changes' : 'disabled'}`, async () => {
        await seedOwner()
        const original = await repository().create(record('session-mcp'))
        await harness.db.insert(mcpRuntimeTestSessions).values(sessionInput(original.id, busy))
        const config = { command: ['node', 'updated.js'], env: { MODE: 'two' } }
        const changed = await repository().update({
          id: original.id,
          expectedConfigHash: mcpConfigHash(original),
          set: { config, enabled, updatedAt: T0 + 42 },
        })
        expect(changed).toEqual({
          ...original,
          type: 'local',
          config,
          enabled,
          updatedAt: T0 + 42,
        })
        expect(await session(original.id)).toMatchObject({
          status: enabled && busy ? 'active' : 'ending',
          endReason: enabled ? (busy ? null : 'mcp-config-changed') : 'mcp-disabled',
          continuationBlockedReason: enabled ? 'mcp-config-changed' : null,
          inFlightTurnId: busy ? 'turn-in-flight' : null,
          idleDeadlineAt: null,
          sessionVersion: 8,
          turnSeq: 3,
          createdAt: T0,
          updatedAt: T0 + 42,
        })
      })
    }
  }

  test('repository stale and missing errors leave the current row intact', async () => {
    await seedOwner()
    const original = await repository().create(record('stale-mcp'))
    const current = await repository().update({
      id: original.id,
      expectedConfigHash: mcpConfigHash(original),
      set: { description: 'winner', updatedAt: T0 + 1 },
    })
    await expect(
      repository().update({
        id: original.id,
        expectedConfigHash: mcpConfigHash(original),
        set: { description: 'loser', updatedAt: T0 + 2 },
      }),
    ).rejects.toThrow('the MCP changed before saving; reload and retry')
    expect(await repository().get(original.id)).toEqual(current)
    await expect(
      repository().update({
        id: 'missing',
        expectedConfigHash: mcpConfigHash(original),
        set: { updatedAt: T0 + 3 },
      }),
    ).rejects.toThrow('mcp not found')
    expect(await repository().list()).toEqual([current])
  })

  test('repository create, update and session invalidation roll back with the outer transaction', async () => {
    await seedOwner()
    const currentRepository = repository()
    const original = await currentRepository.create(record('rollback-mcp'))
    await harness.db.insert(mcpRuntimeTestSessions).values(sessionInput(original.id, false))
    const beforeSession = await session(original.id)
    await expect(
      harness.session.transaction(async (tx) => {
        // Re-entry is keyed by the root client; observe uncommitted rows through the handle.
        await currentRepository.create(record('uncommitted-mcp'))
        await currentRepository.update({
          id: original.id,
          expectedConfigHash: mcpConfigHash(original),
          set: { enabled: false, updatedAt: T0 + 9 },
        })
        expect((await tx.select().from(mcpRuntimeTestSessions))[0]).toMatchObject({
          status: 'ending',
          sessionVersion: 8,
          updatedAt: T0 + 9,
        })
        throw new Error('abort MCP transaction')
      }),
    ).rejects.toThrow('abort MCP transaction')
    expect(await currentRepository.list()).toEqual([original])
    expect(await session(original.id)).toEqual(beforeSession)
  })

  test('a session transition error rolls back an already-written repository row', async () => {
    await seedOwner()
    const original = await repository().create(record('transition-error-mcp'))
    await harness.db.insert(mcpRuntimeTestSessions).values(sessionInput(original.id, true))
    const beforeSession = await session(original.id)
    const lifecycle = createMcpTransactionLifecycle()
    const failing = createMcpRepository({
      db: harness.db,
      lifecycle: {
        ...lifecycle,
        async transitionMutation(tx, input) {
          await lifecycle.transitionMutation(tx, input)
          throw new Error('fail after durable transition')
        },
      },
    }).repository
    await expect(
      failing.update({
        id: original.id,
        expectedConfigHash: mcpConfigHash(original),
        set: { description: 'uncommitted', updatedAt: T0 + 1 },
      }),
    ).rejects.toThrow('fail after durable transition')
    expect(await repository().get(original.id)).toEqual(original)
    expect(await session(original.id)).toEqual(beforeSession)
  })

  async function packageFixture() {
    await seedOwner()
    const appHome = mkdtempSync(join(tmpdir(), 'aw-mcp-publication-'))
    roots.push(appHome)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'MCP Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    })
    const context = {
      authority: new AuthorityClaimRegistry().mintLocalAuthority({
        userId: OWNER,
        source: 'system',
      }),
      operationId: 'mcp-publication',
      correlationId: 'mcp-publication',
      now: T0,
    }
    const box = createSecretBoxFromKey(randomBytes(32))
    const compose = (): ComposedResourcePackageCatalog => {
      if (harness.capabilities.isolation === 'exclusive')
        return composeSqliteResourcePackageCatalogForTest({
          db: harness.db as DbClient,
          appHome,
          box,
        })
      const db = harness.db as PostgresqlDatabaseClient
      const provider = composePostgresqlResourcePackageProvider({
        db,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db }),
        pluginInstaller: {
          plannedGenerationDirectory() {
            throw new Error('MCP publication must not install plugins')
          },
          async install() {
            throw new Error('MCP publication must not install plugins')
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
    const preview = async (bytes: Uint8Array) => {
      const result = await catalog.operations.inspect.invoke(
        context,
        catalog.transport.stageInspect(actor, bytes),
      )
      return PackagePreviewSchema.parse(
        JSON.parse((await catalog.operations.getPreview.invoke(context, result)).document),
      )
    }
    const apply = async (
      bytes: Uint8Array,
      previewToken: string,
      decision: ResourcePackageImportDecision,
      target = catalog,
    ) => {
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
      return PackageImportReceiptSchema.parse(
        JSON.parse((await target.operations.getReceipt.invoke(context, result)).document),
      )
    }
    return { preview, apply, compose }
  }

  test('real package create and overwrite persist MCP metadata, session invalidation and replay receipts', async () => {
    const f = await packageFixture()
    const createBytes = mcpPackage(1)
    const createPreview = await f.preview(createBytes)
    const createDecision = { localSlug: 'mcp-example', action: 'new' as const }
    const receipt = await f.apply(createBytes, createPreview.previewToken, createDecision)
    expect(receipt.root).toBeDefined()
    if (receipt.root === undefined) throw new Error('MCP receipt root missing')
    const original = await repository().get(receipt.root.resourceId)
    expect(original).toMatchObject({
      name: 'package-mcp',
      description: 'revision 1',
      enabled: true,
      type: 'local',
      config: { command: ['node', 'mcp-1.js'], env: { MODE: '1' } },
      schemaVersion: 1,
    })
    if (original === null) throw new Error('created MCP missing')
    await harness.db.insert(mcpRuntimeTestSessions).values(sessionInput(original.id, false))
    expect(receipt.applied).toEqual([
      {
        opId: 'op-1',
        resourceType: 'mcp',
        resourceId: original.id,
        action: 'create',
        name: 'package-mcp',
      },
    ])
    expect(
      await f.apply(createBytes, createPreview.previewToken, createDecision, f.compose()),
    ).toEqual(receipt)
    const updateBytes = mcpPackage(2)
    const updatePreview = await f.preview(updateBytes)
    const updateDecision = {
      localSlug: 'mcp-example',
      action: 'overwrite' as const,
      targetId: original.id,
    }
    const updatedReceipt = await f.apply(updateBytes, updatePreview.previewToken, updateDecision)
    const changed = await repository().get(original.id)
    expect(changed).toMatchObject({
      id: original.id,
      name: original.name,
      description: 'revision 2',
      enabled: false,
      config: { command: ['node', 'mcp-2.js'], env: { MODE: '2' } },
      createdAt: original.createdAt,
      schemaVersion: original.schemaVersion,
    })
    expect(changed!.updatedAt).toBeGreaterThan(original.updatedAt)
    expect(updatedReceipt.applied).toEqual([{ ...receipt.applied[0]!, action: 'update' }])
    expect(await session(original.id)).toMatchObject({
      status: 'ending',
      endReason: 'mcp-disabled',
      sessionVersion: 8,
      updatedAt: changed!.updatedAt,
    })
    expect(
      await f.apply(updateBytes, updatePreview.previewToken, updateDecision, f.compose()),
    ).toEqual(updatedReceipt)
    expect(await repository().list()).toHaveLength(1)
    expect((await harness.db.select().from(resourceBundleApplies)).map((row) => row.state)).toEqual(
      ['committed', 'committed'],
    )
  })
})

// These assertions first passed against the synchronous SQLite helpers. Keep
// them on the real database session after converting their callers to await.
describeEachProvider('RFC-359 legacy MCP mutation preservation', (harness) => {
  const localInput = {
    name: 'legacy-mcp',
    description: 'original',
    type: 'local' as const,
    config: { command: ['node', 'mcp.js'], env: { MODE: 'one' } },
    enabled: true,
  }
  const prepared = {
    id: 'legacy-mcp',
    input: localInput,
    initialAcl: { ownerUserId: OWNER, visibility: 'private' as const, aclRevision: 0 as const },
    now: T0,
  }
  async function stored() {
    return (await harness.db.select().from(mcps).limit(1))[0]!
  }
  async function session() {
    return (await harness.db.select().from(mcpRuntimeTestSessions).limit(1))[0]!
  }
  async function fixture(ownerUserId: string | null = OWNER, busy?: boolean) {
    await harness.db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'MCP Owner',
      role: 'admin',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    })
    await harness.session.transaction((tx) =>
      commitLegacyMcpCreateInTx(tx, {
        ...prepared,
        initialAcl: { ...prepared.initialAcl, ownerUserId },
      }),
    )
    if (busy !== undefined)
      await harness.db.insert(mcpRuntimeTestSessions).values({
        ...sessionInput(prepared.id, busy),
        id: 'legacy-session',
        clientCreateId: 'legacy-create',
        runtimeSessionId: 'native-mcp',
        scratchRoot: '/unused/mcp',
      })
  }
  for (const ownerUserId of [OWNER, null])
    test(`legacy create preserves nullable metadata ${ownerUserId === null ? 'null' : 'value'} and captured timestamps`, async () => {
      await fixture(ownerUserId)
      expect(await stored()).toEqual({
        id: prepared.id,
        ...localInput,
        config: JSON.stringify(localInput.config),
        ownerUserId,
        visibility: 'private',
        aclRevision: 0,
        schemaVersion: 1,
        createdAt: T0,
        updatedAt: T0,
      })
    })
  for (const busy of [false, true])
    for (const enabled of [true, false])
      test(`legacy mutation preserves ${busy ? 'busy' : 'idle'} ${enabled ? 'config' : 'disable'} session state and version`, async () => {
        await fixture(OWNER, busy)
        const original = await stored()
        await harness.session.transaction((tx) =>
          commitLegacyMcpUpdateInTx(tx, {
            id: prepared.id,
            set: { description: 'legacy changed', enabled, updatedAt: T0 + 42 },
          }),
        )
        expect(await stored()).toEqual({
          ...original,
          description: 'legacy changed',
          enabled,
          updatedAt: T0 + 42,
        })
        expect(await session()).toMatchObject({
          status: enabled && busy ? 'active' : 'ending',
          endReason: enabled ? (busy ? null : 'mcp-config-changed') : 'mcp-disabled',
          continuationBlockedReason: enabled ? 'mcp-config-changed' : null,
          inFlightTurnId: busy ? 'turn-in-flight' : null,
          idleDeadlineAt: null,
          sessionVersion: 8,
          turnSeq: 3,
          createdAt: T0,
          updatedAt: T0 + 42,
        })
      })
  test('legacy stale config and missing errors retain their original messages and rows', async () => {
    await fixture()
    const original = await stored()
    const expectedConfigHash = mcpConfigHash(mcpFromPersistenceRow(original))
    await harness.db.update(mcps).set({ description: 'winner' }).where(eq(mcps.id, prepared.id))
    const current = await stored()
    await expect(
      harness.session.transaction((tx) =>
        commitLegacyMcpUpdateInTx(tx, {
          id: prepared.id,
          expectedConfigHash,
          set: { description: 'loser' },
        }),
      ),
    ).rejects.toThrow('the MCP changed; reload before saving')
    expect(await stored()).toEqual(current)
    await expect(
      harness.session.transaction((tx) =>
        commitLegacyMcpUpdateInTx(tx, { id: 'missing', set: { updatedAt: T0 + 1 } }),
      ),
    ).rejects.toThrow('mcp not found')
    expect(await harness.db.select().from(mcps)).toEqual([current])
  })
  test('legacy create, update and session invalidation share the outer rollback', async () => {
    await fixture(OWNER, false)
    const original = await stored()
    const beforeSession = await session()
    await expect(
      harness.session.transaction(async (tx) => {
        await commitLegacyMcpCreateInTx(tx, {
          ...prepared,
          id: 'uncommitted-mcp',
          input: { ...localInput, name: 'uncommitted-mcp' },
        })
        await commitLegacyMcpUpdateInTx(tx, {
          id: prepared.id,
          set: { enabled: false, updatedAt: T0 + 9 },
        })
        expect((await tx.select().from(mcpRuntimeTestSessions))[0]).toMatchObject({
          status: 'ending',
          sessionVersion: 8,
          updatedAt: T0 + 9,
        })
        throw new Error('abort legacy MCP writes')
      }),
    ).rejects.toThrow('abort legacy MCP writes')
    expect(await harness.db.select().from(mcps)).toEqual([original])
    expect(await session()).toEqual(beforeSession)
  })
  test('legacy transition failure rolls back its MCP row and session', async () => {
    await fixture(OWNER, false)
    const original = await stored()
    const beforeSession = await session()
    const sqlite = harness.capabilities.isolation === 'exclusive'
    const create = sqlite
      ? [
          "CREATE TRIGGER fail_mcp_transition BEFORE UPDATE ON mcp_runtime_test_sessions BEGIN SELECT RAISE(ABORT, 'forced MCP transition failure'); END;",
        ]
      : [
          "CREATE FUNCTION agent_workflow.fail_mcp_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced MCP transition failure'; END; $$;",
          'CREATE TRIGGER fail_mcp_transition BEFORE UPDATE ON agent_workflow.mcp_runtime_test_sessions FOR EACH ROW EXECUTE FUNCTION agent_workflow.fail_mcp_transition();',
        ]
    const drop = sqlite
      ? ['DROP TRIGGER fail_mcp_transition']
      : [
          'DROP TRIGGER fail_mcp_transition ON agent_workflow.mcp_runtime_test_sessions',
          'DROP FUNCTION agent_workflow.fail_mcp_transition()',
        ]
    for (const statement of create) await harness.executeFixtureDdl(statement)
    try {
      await expect(
        harness.session.transaction((tx) =>
          commitLegacyMcpUpdateInTx(tx, {
            id: prepared.id,
            set: { enabled: false, updatedAt: T0 + 2 },
          }),
        ),
      ).rejects.toThrow('forced MCP transition failure')
      expect(await stored()).toEqual(original)
      expect(await session()).toEqual(beforeSession)
    } finally {
      for (const statement of drop) await harness.executeFixtureDdl(statement)
    }
  })
  test('legacy omitted update clock preserves the MCP timestamp and samples lifecycle fallback now', async () => {
    await fixture(OWNER, false)
    const clock = spyOn(Date, 'now').mockReturnValue(T0 + 77)
    try {
      const original = await stored()
      await harness.session.transaction((tx) =>
        commitLegacyMcpUpdateInTx(tx, { id: prepared.id, set: { description: 'fallback clock' } }),
      )
      expect(await stored()).toEqual({ ...original, description: 'fallback clock' })
      expect(await session()).toMatchObject({
        status: 'ending',
        sessionVersion: 8,
        updatedAt: T0 + 77,
      })
    } finally {
      clock.mockRestore()
    }
  })

  for (const ownerUserId of [OWNER, null])
    test(`captured-row match accepts unchanged nullable metadata ${ownerUserId === null ? 'null' : 'value'}`, async () => {
      await fixture(ownerUserId)
      const original = await stored()
      const set = { description: 'captured publication', enabled: false, updatedAt: T0 + 1 }
      const changed = await harness.session.transaction((tx) =>
        updateMcpRowInTx(tx, { kind: 'captured-row', row: original }, set),
      )
      expect(changed).toEqual([{ ...original, ...set }])
      expect(await stored()).toEqual({ ...original, ...set })
    })

  const changes: readonly (readonly [string, Partial<typeof mcps.$inferInsert>])[] = [
    ['id', { id: 'different-id' }],
    ['name', { name: 'different-name' }],
    ['description', { description: 'newer description' }],
    ['type', { type: 'remote' }],
    ['config', { config: '{"command":["node","newer.js"]}' }],
    ['enabled', { enabled: false }],
    ['ownerUserId', { ownerUserId: null }],
    ['visibility', { visibility: 'public' }],
    ['aclRevision', { aclRevision: 1 }],
    ['schemaVersion', { schemaVersion: 2 }],
    ['createdAt', { createdAt: T0 + 12 }],
    ['updatedAt', { updatedAt: T0 + 13 }],
  ]
  for (const [field, newer] of changes)
    test(`captured-row match rejects changed ${field} without writing any other column`, async () => {
      await fixture()
      const original = await stored()
      await harness.db.update(mcps).set(newer).where(eq(mcps.id, original.id))
      const changed = await harness.session.transaction((tx) =>
        updateMcpRowInTx(
          tx,
          { kind: 'captured-row', row: original },
          { description: 'loser', updatedAt: T0 + 99 },
        ),
      )
      expect(changed).toEqual([])
      expect(await stored()).toEqual({ ...original, ...newer })
    })
  test('captured-row match rejects null metadata becoming a value', async () => {
    await fixture(null)
    const original = await stored()
    await harness.db.update(mcps).set({ ownerUserId: OWNER }).where(eq(mcps.id, original.id))
    const changed = await harness.session.transaction((tx) =>
      updateMcpRowInTx(tx, { kind: 'captured-row', row: original }, { description: 'loser' }),
    )
    expect(changed).toEqual([])
    expect(await stored()).toEqual({ ...original, ownerUserId: OWNER })
  })
  test('id match preserves the established update of a newer row', async () => {
    await fixture()
    const original = await stored()
    await harness.db
      .update(mcps)
      .set({ description: 'newer description' })
      .where(eq(mcps.id, original.id))
    const set = { enabled: false, updatedAt: T0 + 42 }
    const changed = await harness.session.transaction((tx) =>
      updateMcpRowInTx(tx, { kind: 'id', id: original.id }, set),
    )
    expect(changed).toEqual([{ ...original, description: 'newer description', ...set }])
    expect(await stored()).toEqual({ ...original, description: 'newer description', ...set })
  })
})

test('MCP create and update have one SQL atom and retain separate rename', () => {
  const paths = [
    'mcpPersistence.ts',
    'mcpRepository.ts',
    'aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
  ]
  let inserts = 0,
    updates = 0,
    capturedPredicates = 0
  for (const path of paths) {
    const file = join(import.meta.dir, '../src/modules/resource-catalog/infrastructure', path)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'fullMcpRowWhere')
        capturedPredicates += 1
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === 'mcps'
      ) {
        if (node.expression.name.text === 'insert') inserts += 1
        if (node.expression.name.text === 'update') updates += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect({ inserts, updates, capturedPredicates }).toEqual({
    inserts: 1,
    updates: 2,
    capturedPredicates: 1,
  })
})

test('all four legacy MCP commits and all four delegates await database completion', () => {
  const paths = [
    'modules/resource-catalog/infrastructure/aggregateAdapters/legacyResourcePackageMutationParticipants.ts',
    'modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts',
    'services/bundle/legacyResourcePackageMutationDependencies.ts',
    'modules/resource-catalog/composition/legacyIntentApplyResourceDependencies.ts',
  ]
  const results = paths.map((path) => {
    const file = join(import.meta.dir, '../src', path)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const calls: string[] = [],
      unawaited: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : ''
        if (/^commit(?:Legacy)?Mcp(?:Create|Update)InTx$/.test(name)) {
          calls.push(name)
          if (!ts.isAwaitExpression(node.parent)) unawaited.push(name)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return { calls, unawaited }
  })
  expect(results).toEqual([
    { calls: ['commitMcpCreateInTx', 'commitMcpUpdateInTx'], unawaited: [] },
    { calls: ['commitMcpCreateInTx', 'commitMcpUpdateInTx'], unawaited: [] },
    { calls: ['commitLegacyMcpCreateInTx', 'commitLegacyMcpUpdateInTx'], unawaited: [] },
    { calls: ['commitLegacyMcpCreateInTx', 'commitLegacyMcpUpdateInTx'], unawaited: [] },
  ])
})
