// RFC-359 AC1: legacy publication, the neutral repository and PostgreSQL package
// mutation share the same insert/CAS atoms. Preserve real package publication,
// transaction rollback and the captured-row behavior established before merging.

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
import { plugins, resourceBundleApplies, users } from '@/db/schema'
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
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
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
    await harness.db.insert(users).values({ ...actor.user, createdAt: T0, updatedAt: T0 })
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
    return { first, second, preview, apply, compose }
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
    const journals = await harness.db.select().from(resourceBundleApplies)
    expect(journals).toHaveLength(2)
    expect(journals.map((row) => row.state)).toEqual(['committed', 'committed'])
    expect(readFileSync(join(f.first, 'index.js'), 'utf8')).toBe('export const revision = 1\n')
    expect(readFileSync(join(f.second, 'index.js'), 'utf8')).toBe('export const revision = 2\n')
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
          set: {
            spec: `file:${f.second}`,
            options: { revision: 2 },
            description: 'uncommitted',
            enabled: false,
            sourceKind: 'file',
            cachedPath: f.second,
            resolvedVersion: 'revision-2',
            installedAt: T0 + 2,
            updatedAt: T0 + 3,
          },
        })
        expect(published).toMatchObject({ cachedPath: f.second, updatedAt: T0 + 3 })
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
    await harness.db
      .update(plugins)
      .set({ description: 'newer', updatedAt: T0 + 1 })
      .where(eq(plugins.id, original.id))
    const current = await repository.get(original.id)
    await expect(
      repository.publish({
        id: original.id,
        expectedConfigHash: pluginConfigHash(original),
        set: {
          spec: `file:${f.second}`,
          options: { revision: 2 },
          description: 'stale publication',
          enabled: false,
          sourceKind: 'file',
          cachedPath: f.second,
          resolvedVersion: null,
          installedAt: T0 + 2,
          updatedAt: T0 + 2,
        },
      }),
    ).rejects.toThrow('plugin changed before generation publication; reload and retry')
    expect(await repository.get(original.id)).toEqual(current)
  })

  test('metadata-only publication keeps its generation and explicit timestamps', async () => {
    const f = await fixture()
    const repository = createPluginRepository({ db: harness.db }).repository
    const original = await repository.create(record('metadata-only-plugin', f.first))
    const published = await repository.publish({
      id: original.id,
      expectedConfigHash: pluginConfigHash(original),
      set: {
        spec: original.spec,
        options: { revision: 2 },
        description: 'metadata only',
        enabled: original.enabled,
        sourceKind: original.sourceKind,
        cachedPath: original.cachedPath,
        resolvedVersion: original.resolvedVersion,
        installedAt: original.installedAt,
        updatedAt: T0 + 99,
      },
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
    await harness.db.insert(users).values({
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
  // RFC-359 —— 两台 apply 引擎合一之后，intent apply 的插件写点不再是 legacy 那两个
  // `commit(?:Legacy)?Plugin…InTx` 包装（它们随 `legacyIntentApplyResourceParticipants` /
  // `legacyIntentApplyResourceDependencies` 一起失去了生产消费者），而是**提交臂本身**在
  // `intentApplyResourcePorts.ts` 里直接写表。判据不变：写必须被 `await` 到落库。
  //
  // 为什么这条判据非要有：drizzle 的查询构建器是**惰性** `QueryPromise`。`.run()` 当场执行、
  // `await` 当场执行，而**既不 `.run()` 也不 `await`** 的写在两个引擎上都一条都不会发生——
  // 漏掉 await 不会让任何行为用例变红，只会让那次写悄悄不发生。
  const file = join(
    import.meta.dir,
    '../src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts.ts',
  )
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const writes: string[] = []
  const unawaited: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'insert' || node.expression.name.text === 'update') &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'plugins'
    ) {
      // 写链的形态是 `await transaction.insert(x).values(...).returning().get()`——
      // 沿着属性访问链往上走到最外层调用，`await` 挂在那里。
      let outermost: ts.Node = node
      while (
        ts.isPropertyAccessExpression(outermost.parent) ||
        (ts.isCallExpression(outermost.parent) && outermost.parent.expression === outermost)
      )
        outermost = outermost.parent
      writes.push(node.expression.name.text)
      if (!ts.isAwaitExpression(outermost.parent)) unawaited.push(node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(writes.length, '语料失效：一处 `plugins` 写点都没扫到').toBeGreaterThanOrEqual(2)
  expect({ writes: [...new Set(writes)].sort(), unawaited }).toEqual({
    writes: ['insert', 'update'],
    unawaited: [],
  })
})
