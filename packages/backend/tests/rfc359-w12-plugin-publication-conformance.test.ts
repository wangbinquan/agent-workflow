// RFC-359 AC1: legacy publication, the neutral repository and PostgreSQL package
// mutation share the same insert/CAS atoms. Preserve real package publication,
// transaction rollback and the captured-row behavior established before merging.
// RFC-401 A2: the neutral repository and the package arm both publish through the one plugin
// mutation participant; a package overwrite that keeps the spec no longer reinstalls.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import ts from 'typescript'
import { PackageImportReceiptSchema, PackagePreviewSchema } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { PluginCreateRecord } from '@/modules/resource-catalog/application/plugins/ports'
import type { ResourcePackageImportDecision } from '@/modules/resource-catalog/application/package/ports'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import {
  commitLegacyPluginCreateInTx,
  commitLegacyPluginPublishInTx,
  pluginConfigHash,
  type LegacyPreparedPluginCreate,
  type PluginPersistenceRow,
} from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { createPluginRepository } from '@/modules/resource-catalog/infrastructure/pluginRepository'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createResourcePackageAtomicApplyOperations } from '@/modules/resource-catalog/infrastructure/resourcePackageAtomicApply'
import {
  installPlugin,
  plannedGenerationDir,
} from '@/modules/resource-catalog/infrastructure/local/filePluginInstallation'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/modules/resource-catalog/composition/resourcePackageExecution'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'rfc359-plugin-publication-owner'
const T0 = 1_700_000_000_000
const utf8 = (value: string) => new TextEncoder().encode(value)

function pluginPackage(spec: string, revision: number): Uint8Array {
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: plugin-example
  type: plugin
  name: package-plugin
resources:
  - slug: plugin-example
    type: plugin
    name: package-plugin
requirements:
  pluginSources:
    - name: package-plugin
      spec: ${JSON.stringify(spec)}
      sourceKind: file
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
              kind: 'plugin-create',
              slug: 'plugin-example',
              payload: {
                name: 'package-plugin',
                spec,
                sourceKind: 'file',
                options: { revision, nested: { enabled: revision === 1 } },
                description: `revision ${revision}`,
                enabled: revision === 1,
              },
            },
          ],
          rootRef: 'local:plugin-example',
        }),
      ),
    },
  ])
}

function record(id: string, cachedPath: string): PluginCreateRecord {
  return {
    id,
    name: id,
    spec: `file:${cachedPath}`,
    options: { revision: 1 },
    description: 'original',
    enabled: true,
    sourceKind: 'file',
    cachedPath,
    resolvedVersion: null,
    ownerUserId: OWNER,
    visibility: 'private',
    aclRevision: 0,
    now: T0,
  }
}

describeEachProvider('RFC-359 plugin publication through shared mutation atoms', (harness) => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDirSync(root)
  })

  async function fixture() {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-plugin-publication-'))
    roots.push(appHome)
    const source = (name: string, content: string) => {
      const dir = join(appHome, name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'index.js'), content)
      return realpathSync(dir)
    }
    const first = source('first-plugin', 'export const revision = 1\n')
    const second = source('second-plugin', 'export const revision = 2\n')
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Plugin Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    })
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, { ...actor.user, createdAt: T0, updatedAt: T0 })
    const context = {
      authority: new AuthorityClaimRegistry().mintLocalAuthority({
        userId: OWNER,
        source: 'system',
      }),
      operationId: 'plugin-publication-test',
      correlationId: 'plugin-publication-test',
      now: T0,
    }
    const box = createSecretBoxFromKey(randomBytes(32))
    /** Every package installation, by spec (RFC-401 A2: an overwrite keeping the spec does not install). */
    const installs: string[] = []

    function compose(): ComposedResourcePackageCatalog {
      // RFC-359 —— 两台 apply 引擎合一后不再按引擎分叉：两个 provider 装同一条组合根。
      const db = harness.db
      const provider = composePostgresqlResourcePackageProvider({
        db,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db }),
        pluginInstaller: {
          plannedGenerationDirectory(input) {
            return plannedGenerationDir(
              input.pluginId,
              input.spec,
              input.generationId,
              input.pluginsDir,
            )
          },
          async install(input) {
            installs.push(input.spec)
            const installed = await installPlugin(input.pluginId, input.spec, {
              generationId: input.generationId,
              pluginsDir: input.pluginsDir,
            })
            return {
              cachedPath: installed.cachedPath,
              resolvedVersion: installed.resolvedVersion,
              sourceKind: installed.sourceKind,
              generationDirectory: installed.generationDir,
            }
          },
        },
      })
      return composePostgresqlResourcePackageCatalog({
        provider,
        execution: createPostgresqlResourcePackageExecutionAdapter({
          box,
          provider,
          atomicApply: createResourcePackageAtomicApplyOperations({ db, box }),
        }),
      })
    }

    const catalog = compose()
    const preview = async (bytes: Uint8Array) => {
      const result = await catalog.operations.inspect.invoke(
        context,
        catalog.transport.stageInspect(actor, bytes),
      )
      const view = await catalog.operations.getPreview.invoke(context, result)
      return PackagePreviewSchema.parse(JSON.parse(view.document))
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
      const view = await target.operations.getReceipt.invoke(context, result)
      return PackageImportReceiptSchema.parse(JSON.parse(view.document))
    }
    return { first, second, preview, apply, compose, installs }
  }

  test('real package create and overwrite publish file metadata and replay their committed receipts', async () => {
    const f = await fixture()
    const createBytes = pluginPackage(`file:${f.first}`, 1)
    const createPreview = await f.preview(createBytes)
    const createDecision = { localSlug: 'plugin-example', action: 'new' as const }
    const createdReceipt = await f.apply(createBytes, createPreview.previewToken, createDecision)
    const repository = createPluginRepository({ db: harness.db }).repository
    expect(createdReceipt.root).toBeDefined()
    if (createdReceipt.root === undefined) throw new Error('created plugin receipt root missing')
    const created = await repository.get(createdReceipt.root.resourceId)
    expect(created).toMatchObject({
      name: 'package-plugin',
      spec: `file:${f.first}`,
      options: { revision: 1, nested: { enabled: true } },
      description: 'revision 1',
      enabled: true,
      sourceKind: 'file',
      cachedPath: f.first,
      schemaVersion: 1,
    })
    if (created === null) throw new Error('created plugin missing')
    expect(createdReceipt.applied).toEqual([
      {
        opId: 'op-1',
        resourceType: 'plugin',
        resourceId: created.id,
        action: 'create',
        name: 'package-plugin',
      },
    ])
    expect(
      await f.apply(createBytes, createPreview.previewToken, createDecision, f.compose()),
    ).toEqual(createdReceipt)

    const updateBytes = pluginPackage(`file:${f.second}`, 2)
    const updatePreview = await f.preview(updateBytes)
    const updateDecision = {
      localSlug: 'plugin-example',
      action: 'overwrite' as const,
      targetId: created.id,
    }
    const updatedReceipt = await f.apply(updateBytes, updatePreview.previewToken, updateDecision)
    const updated = await repository.get(created.id)
    expect(updated).toMatchObject({
      id: created.id,
      name: created.name,
      spec: `file:${f.second}`,
      options: { revision: 2, nested: { enabled: false } },
      description: 'revision 2',
      enabled: false,
      sourceKind: 'file',
      cachedPath: f.second,
      createdAt: created.createdAt,
      schemaVersion: created.schemaVersion,
    })
    expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(updatedReceipt.applied).toEqual([{ ...createdReceipt.applied[0]!, action: 'update' }])
    expect(
      await f.apply(updateBytes, updatePreview.previewToken, updateDecision, f.compose()),
    ).toEqual(updatedReceipt)
    expect(await repository.list()).toHaveLength(1)
    const { resourceBundleApplies } = tablesOf(harness.db)
    const journals = await harness.db.select().from(resourceBundleApplies)
    expect(journals).toHaveLength(2)
    expect(journals.map((row) => row.state)).toEqual(['committed', 'committed'])
    expect(readFileSync(join(f.first, 'index.js'), 'utf8')).toBe('export const revision = 1\n')
    expect(readFileSync(join(f.second, 'index.js'), 'utf8')).toBe('export const revision = 2\n')
  })

  // RFC-401 A2（proposal §5 第 10 项，用户 2026-11-02 确认）：覆盖保持规格不变就不重新安装、installedAt 不动，
  // 只更新选项 / 描述 / 启用；此前资源包每次覆盖都重新安装并推进 installedAt。重新解析版本由显式 upgrade 表达。
  test('a package overwrite that keeps the spec does not reinstall the plugin', async () => {
    const f = await fixture()
    const createBytes = pluginPackage(`file:${f.first}`, 1)
    const createPreview = await f.preview(createBytes)
    const created = await f.apply(createBytes, createPreview.previewToken, {
      localSlug: 'plugin-example',
      action: 'new',
    })
    const repository = createPluginRepository({ db: harness.db }).repository
    const before = await repository.get(created.root!.resourceId)
    expect(f.installs).toEqual([`file:${f.first}`])

    const sameSpecBytes = pluginPackage(`file:${f.first}`, 2)
    const sameSpecPreview = await f.preview(sameSpecBytes)
    await f.apply(sameSpecBytes, sameSpecPreview.previewToken, {
      localSlug: 'plugin-example',
      action: 'overwrite',
      targetId: before!.id,
    })
    const after = await repository.get(before!.id)
    expect(f.installs).toEqual([`file:${f.first}`])
    expect(after).toMatchObject({
      spec: before!.spec,
      sourceKind: before!.sourceKind,
      cachedPath: before!.cachedPath,
      resolvedVersion: before!.resolvedVersion,
      installedAt: before!.installedAt,
      description: 'revision 2',
      options: { revision: 2, nested: { enabled: false } },
      enabled: false,
    })
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt)

    const newSpecBytes = pluginPackage(`file:${f.second}`, 2)
    const newSpecPreview = await f.preview(newSpecBytes)
    await f.apply(newSpecBytes, newSpecPreview.previewToken, {
      localSlug: 'plugin-example',
      action: 'overwrite',
      targetId: before!.id,
    })
    expect(f.installs).toEqual([`file:${f.first}`, `file:${f.second}`])
    expect((await repository.get(before!.id))!.installedAt).toBeGreaterThan(before!.installedAt)
  })

  test('create and publication stay in the outer transaction and roll back together', async () => {
    const f = await fixture()
    const repository = createPluginRepository({ db: harness.db }).repository
    const original = await repository.create(record('existing-plugin', f.first))
    await expect(
      databaseSessionFor(harness.db).transaction(async (transaction) => {
        // Re-entry is keyed by the root client; observe uncommitted rows through the handle.
        await repository.create(record('rolled-back-plugin', f.second))
        const published = await repository.publish({
          id: original.id,
          expectedConfigHash: pluginConfigHash(original),
          patch: {
            spec: `file:${f.second}`,
            options: { revision: 2 },
            description: 'uncommitted',
            enabled: false,
          },
          installation: { sourceKind: 'file', cachedPath: f.second, resolvedVersion: 'revision-2' },
          nextInstalledAt: () => T0 + 2,
          nextUpdatedAt: () => T0 + 3,
        })
        expect(published).toMatchObject({ cachedPath: f.second, updatedAt: T0 + 3 })
        const { plugins } = tablesOf(transaction)
        expect(await transaction.select().from(plugins)).toHaveLength(2)
        throw new Error('abort after plugin writes')
      }),
    ).rejects.toThrow('abort after plugin writes')
    expect(await repository.get(original.id)).toEqual(original)
    expect(await repository.get('rolled-back-plugin')).toBeNull()
    expect(readFileSync(join(f.first, 'index.js'), 'utf8')).toBe('export const revision = 1\n')
    expect(readFileSync(join(f.second, 'index.js'), 'utf8')).toBe('export const revision = 2\n')
  })

  test('a stale publication leaves all current metadata unchanged', async () => {
    const f = await fixture()
    const repository = createPluginRepository({ db: harness.db }).repository
    const original = await repository.create(record('stale-plugin', f.first))
    const { plugins } = tablesOf(harness.db)
    await harness.db
      .update(plugins)
      .set({ description: 'newer', updatedAt: T0 + 1 })
      .where(eq(plugins.id, original.id))
    const current = await repository.get(original.id)
    await expect(
      repository.publish({
        id: original.id,
        expectedConfigHash: pluginConfigHash(original),
        patch: {
          spec: `file:${f.second}`,
          options: { revision: 2 },
          description: 'stale publication',
          enabled: false,
        },
        installation: { sourceKind: 'file', cachedPath: f.second, resolvedVersion: null },
        nextInstalledAt: () => T0 + 2,
        nextUpdatedAt: () => T0 + 2,
      }),
    ).rejects.toThrow('plugin changed since this operation was prepared; reload and retry')
    expect(await repository.get(original.id)).toEqual(current)
  })

  test('metadata-only publication keeps its generation and explicit timestamps', async () => {
    const f = await fixture()
    const repository = createPluginRepository({ db: harness.db }).repository
    const original = await repository.create(record('metadata-only-plugin', f.first))
    const published = await repository.publish({
      id: original.id,
      expectedConfigHash: pluginConfigHash(original),
      patch: {
        spec: original.spec,
        options: { revision: 2 },
        description: 'metadata only',
        enabled: original.enabled,
      },
      // RFC-401 A2：规格不变、没有新安装，沿用当前安装与 installedAt。
      installation: null,
      nextInstalledAt: () => {
        throw new Error('metadata-only publication must keep installedAt')
      },
      nextUpdatedAt: () => T0 + 99,
    })
    expect(published).toEqual({
      ...original,
      options: { revision: 2 },
      description: 'metadata only',
      updatedAt: T0 + 99,
    })
    expect(await repository.get(original.id)).toEqual(published)
    expect(readFileSync(join(f.first, 'index.js'), 'utf8')).toBe('export const revision = 1\n')
  })
})

describeEachProvider('RFC-359 captured-row publication preserves the old contract', (harness) => {
  const prepared: LegacyPreparedPluginCreate = {
    id: 'captured-plugin',
    parsed: {
      name: 'captured-plugin',
      spec: 'file:/original',
      options: { n: 1 },
      description: 'original',
      enabled: true,
    },
    initialAcl: { ownerUserId: 'plugin-owner', visibility: 'private', aclRevision: 0 },
    install: { sourceKind: 'file', cachedPath: '/original', resolvedVersion: null },
    now: 1700000000000,
  }
  const publication = {
    spec: 'file:/published',
    optionsJson: '{"n":2}',
    description: 'published',
    enabled: false,
    sourceKind: 'file' as const,
    cachedPath: '/published',
    resolvedVersion: 'version-2',
    installedAt: prepared.now + 1,
    updatedAt: prepared.now + 2,
  }

  async function fixture(input = prepared) {
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      id: 'plugin-owner',
      username: 'plugin-owner',
      displayName: 'Plugin Owner',
      role: 'user',
      status: 'active',
      createdAt: prepared.now,
      updatedAt: prepared.now,
    })
    await harness.session.transaction((tx) => commitLegacyPluginCreateInTx(tx, input))
    return readRow()
  }

  async function readRow(): Promise<PluginPersistenceRow> {
    const { plugins } = tablesOf(harness.db)
    const [row] = await harness.db
      .select()
      .from(plugins)
      .where(eq(plugins.id, prepared.id))
      .limit(1)
    if (row === undefined) throw new Error('captured plugin missing')
    return row
  }

  test('old captured-row publication preserves explicit null fields and exact timestamps', async () => {
    const original = await fixture()
    const published = await harness.session.transaction((tx) =>
      commitLegacyPluginPublishInTx(tx, original, publication),
    )
    expect(original.resolvedVersion).toBeNull()
    const { optionsJson, ...publishedFields } = publication
    expect(published).toMatchObject({
      id: prepared.id,
      name: prepared.parsed.name,
      createdAt: prepared.now,
      options: JSON.parse(optionsJson),
      ...publishedFields,
    })
    expect(await readRow()).toEqual({ ...original, ...publication })
  })

  test.each([
    { description: 'newer description' },
    { cachedPath: '/newer-path' },
    { resolvedVersion: 'newer-version' },
    { installedAt: prepared.now + 99 },
  ])('old captured-row publication rejects a changed non-clock field %p', async (newer) => {
    const original = await fixture()
    const { plugins } = tablesOf(harness.db)
    await harness.db.update(plugins).set(newer).where(eq(plugins.id, prepared.id))
    await expect(
      harness.session.transaction((tx) => commitLegacyPluginPublishInTx(tx, original, publication)),
    ).rejects.toThrow(
      "plugin 'captured-plugin' changed while the operation was running; reload and retry",
    )
    expect(await readRow()).toEqual({ ...original, ...newer })
  })

  test('old captured-row publication keeps its missing-row error', async () => {
    const original = await fixture()
    const { plugins } = tablesOf(harness.db)
    await harness.db.delete(plugins).where(eq(plugins.id, prepared.id))
    await expect(
      harness.session.transaction((tx) => commitLegacyPluginPublishInTx(tx, original, publication)),
    ).rejects.toThrow(
      "plugin 'captured-plugin' changed while the operation was running; reload and retry",
    )
    expect(await harness.db.select().from(plugins)).toEqual([])
  })

  test('old create and publication both roll back with the containing transaction', async () => {
    const original = await fixture()
    await expect(
      harness.session.transaction(async (tx) => {
        await commitLegacyPluginCreateInTx(tx, {
          ...prepared,
          id: 'second-plugin',
          parsed: { ...prepared.parsed, name: 'second-plugin' },
        })
        await commitLegacyPluginPublishInTx(tx, original, publication)
        throw new Error('abort legacy writes')
      }),
    ).rejects.toThrow('abort legacy writes')
    const { plugins } = tablesOf(harness.db)
    expect(await harness.db.select().from(plugins)).toEqual([original])
  })

  test.each([null, 'initial-version'])(
    'captured-row publication matches null owner and resolvedVersion=%p',
    async (resolvedVersion) => {
      const original = await fixture({
        ...prepared,
        initialAcl: { ...prepared.initialAcl, ownerUserId: null },
        install: { ...prepared.install, resolvedVersion },
      })
      await harness.session.transaction((tx) =>
        commitLegacyPluginPublishInTx(tx, original, publication),
      )
      expect(await readRow()).toEqual({ ...original, ...publication })
    },
  )

  test.each([
    { originalOwner: null, newerOwner: 'plugin-owner' },
    { originalOwner: 'plugin-owner', newerOwner: null },
  ])('captured-row publication rejects owner nullability change %p', async (owners) => {
    const original = await fixture({
      ...prepared,
      initialAcl: { ...prepared.initialAcl, ownerUserId: owners.originalOwner },
    })
    const { plugins } = tablesOf(harness.db)
    await harness.db
      .update(plugins)
      .set({ ownerUserId: owners.newerOwner })
      .where(eq(plugins.id, prepared.id))
    await expect(
      harness.session.transaction((tx) => commitLegacyPluginPublishInTx(tx, original, publication)),
    ).rejects.toThrow(
      "plugin 'captured-plugin' changed while the operation was running; reload and retry",
    )
    expect(await readRow()).toEqual({ ...original, ownerUserId: owners.newerOwner })
  })
})

test('plugin mutation SQL has one insert and one shared publication algorithm', () => {
  const roots = [
    'pluginPersistence.ts',
    'pluginRepository.ts',
    'aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
  ]
  let inserts = 0
  let updates = 0
  let capturedPredicates = 0
  for (const path of roots) {
    const file = join(import.meta.dir, '../src/modules/resource-catalog/infrastructure', path)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'fullPluginRowWhere') {
        capturedPredicates += 1
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === 'plugins'
      ) {
        if (node.expression.name.text === 'insert') inserts += 1
        if (node.expression.name.text === 'update') updates += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  // The repository keeps its separate rename mutation. Creation/publication
  // execute shared SQL, while all three callers share the captured-row predicate.
  expect({ inserts, updates, capturedPredicates }).toEqual({
    inserts: 1,
    updates: 2,
    capturedPredicates: 1,
  })
})

test('intent apply 侧的插件写点在返回前 await 到数据库落库', () => {
  // RFC-359 —— 判据：写必须被 `await` 到落库。drizzle 的查询构建器是**惰性** `QueryPromise`，既不 `.run()` 也不
  // `await` 的写在两个引擎上都一条都不会发生——漏掉 await 不会让任何行为用例变红，只会让那次写悄悄不发生。
  //
  // RFC-401 A2 —— intent apply 的插件写点不再在 `intentApplyResourcePorts.ts` 里直接写表，而是交给唯一的写入
  // 参与者（`pluginMutationParticipant.ts`），后者经共享的行写入原语落库。判据随写点搬过去：提交臂里没有直接写表，参与者对
  // 原语的调用逐个 `await`，原语自己的写也 `await`。
  const infrastructure = join(import.meta.dir, '../src/modules/resource-catalog/infrastructure')
  const ports = readFileSync(
    join(infrastructure, 'aggregateAdapters/intentApplyResourcePorts.ts'),
    'utf8',
  )
  expect(ports).not.toMatch(/\.(?:insert|update)\(plugins\)/)
  const participantFile = join(infrastructure, 'pluginMutationParticipant.ts')
  const participant = ts.createSourceFile(
    participantFile,
    readFileSync(participantFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const calls: string[] = []
  const unawaited: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['insertPluginRowInTx', 'publishPluginRowInTx'].includes(node.expression.text)
    ) {
      calls.push(node.expression.text)
      if (!ts.isAwaitExpression(node.parent)) unawaited.push(node.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(participant)
  expect({ calls: [...new Set(calls)].sort(), unawaited }).toEqual({
    calls: ['insertPluginRowInTx', 'publishPluginRowInTx'],
    unawaited: [],
  })
})
