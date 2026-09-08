// RFC-359 W12: both provider compositions must reach the real multipart commit,
// persist a nonempty package, publish its skill files, and replay the durable
// receipt through a fresh catalog. Read assertions also pin ordered snapshots
// and file bytes before the duplicated provider assembly is extracted.

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono, type MiddlewareHandler } from 'hono'
import { PackageImportReceiptSchema, PackagePreviewSchema } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { resourceBundleApplies, skills, skillVersions, users } from '@/db/schema'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import {
  composeResourcePackageOperations,
  composeSqliteResourcePackageProvider,
  type ComposedResourcePackageCatalog,
  type ResourcePackageProviderComposition,
} from '@/modules/resource-catalog/composition/resourcePackageOperations'
import type { PostgresqlResourcePackageApplyReceipt } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { registerResourcePackageRoutes } from '@/routes/resourcePackages'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { errorHandler } from '@/util/errors'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { composeSqliteResourcePackageCatalogForTest } from './helpers/resourcePackageProvider'

const OWNER = 'rfc359-package-owner'
const NOW = 1_788_278_400_000
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const decode = (value: Uint8Array): string => new TextDecoder().decode(value)
const FILES = [
  { path: 'a.txt', bytes: utf8('first file') },
  { path: 'b.txt', bytes: new Uint8Array([0, 1, 127, 255]) },
  { path: 'b/c.txt', bytes: utf8('nested file') },
]

function skillPackage(): Uint8Array {
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: skill-guide
  type: skill
  name: guide
resources:
  - slug: skill-guide
    type: skill
    name: guide
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
              kind: 'skill-create',
              slug: 'skill-guide',
              payload: {
                name: 'guide',
                description: 'resource package provider conformance',
                frontmatterExtra: { license: 'MIT' },
                bodyMd: '# Guide\n\nImported content.\n',
                files: FILES.map((file) => ({
                  path: file.path,
                  ref: `skills/skill-guide/files/${file.path}`,
                })),
              },
            },
          ],
          rootRef: 'local:skill-guide',
        }),
      ),
    },
    ...FILES.map((file) => ({
      path: `skills/skill-guide/files/${file.path}`,
      bytes: file.bytes,
    })),
  ])
}

function upload(zip: Uint8Array): FormData {
  const form = new FormData()
  form.set('file', new Blob([Buffer.from(zip)]), 'guide.awpkg.zip')
  return form
}

function writeTree(root: string, entries: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(entries)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

describeEachProvider('RFC-359 W12 resource package provider commit', (harness: ProviderHarness) => {
  const temporaryRoots: string[] = []
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) removeTempDirSync(root)
  })

  async function fixture() {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-package-provider-'))
    temporaryRoots.push(appHome)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Package Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    })
    await harness.db.insert(users).values({
      ...actor.user,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const authority = new AuthorityClaimRegistry().mintLocalAuthority({
      userId: OWNER,
      source: 'system',
    })
    const context = {
      authority,
      operationId: 'rfc359-package-http',
      correlationId: 'rfc359-package-http',
      now: NOW,
    }
    const box = createSecretBoxFromKey(randomBytes(32))

    function compose(): {
      catalog: ComposedResourcePackageCatalog
      provider: ResourcePackageProviderComposition
    } {
      // These factories still own different mutation-session mechanisms. The
      // harness supplies the real selected client; only this assembly branches.
      if (harness.capabilities.isolation === 'exclusive') {
        const db = harness.db as DbClient
        return {
          provider: composeSqliteResourcePackageProvider({ db, appHome }),
          catalog: composeSqliteResourcePackageCatalogForTest({ db, appHome, box }),
        }
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
            throw new Error('skill fixture must not plan a plugin installation')
          },
          async install() {
            throw new Error('skill fixture must not install a plugin')
          },
        },
      })
      return {
        provider,
        catalog: composePostgresqlResourcePackageCatalog({
          provider,
          execution: createPostgresqlResourcePackageExecutionAdapter({
            box,
            provider,
            atomicApply: createPostgresqlResourcePackageAtomicApplyOperations({ db, box }),
          }),
        }),
      }
    }

    function app(catalog: ComposedResourcePackageCatalog): Hono {
      const app = new Hono()
      const injectActor: MiddlewareHandler = async (c, next) => {
        c.set('actor', actor)
        await next()
      }
      app.use('*', injectActor)
      app.onError(errorHandler)
      registerResourcePackageRoutes(app, {
        catalog,
        commandContextFor: () => context,
        queryContextFor: () => context,
      })
      return app
    }

    return { appHome, compose, app, box }
  }

  test('a committed PostgreSQL receipt crosses the real execution adapter and HTTP response schema', async () => {
    const f = await fixture()
    const { provider } = f.compose()
    // This is the exact persisted receipt shape produced by PostgreSQL atomic
    // apply. Only its completed result is substituted here; the adapter, package
    // parser, catalog application, route, and response schema all run normally.
    const committed: PostgresqlResourcePackageApplyReceipt = Object.freeze({
      journalId: 'journal-completed-package',
      applied: Object.freeze([
        Object.freeze({
          operationId: 'op-1',
          resourceType: 'skill',
          resourceId: 'skill-completed-package',
          action: 'create',
          name: 'guide',
        }),
      ]),
      root: Object.freeze({
        resourceType: 'skill',
        resourceId: 'skill-completed-package',
        action: 'create',
        name: 'guide',
      }),
    })
    const before = JSON.stringify(committed)
    let calls = 0
    const catalog = composeResourcePackageOperations({
      resources: provider.resources,
      execution: createPostgresqlResourcePackageExecutionAdapter({
        box: f.box,
        provider: { ...provider, mutationSessionFactory: Object.freeze({}) },
        atomicApply: {
          async apply() {
            calls += 1
            return committed
          },
        },
      }),
    })
    const form = upload(skillPackage())
    form.set('previewToken', 'completed-package-preview')
    form.set('decisions', JSON.stringify([{ localSlug: 'skill-guide', action: 'new' }]))
    const response = await f.app(catalog).request('/api/resource-packages/commit', {
      method: 'POST',
      body: form,
    })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    const receipt = PackageImportReceiptSchema.parse(JSON.parse(body))
    expect(receipt).toEqual({
      journalId: committed.journalId,
      applied: [
        {
          opId: 'op-1',
          resourceType: 'skill',
          resourceId: 'skill-completed-package',
          action: 'create',
          name: 'guide',
        },
      ],
      root: committed.root,
    })
    expect(calls).toBe(1)
    expect(JSON.stringify(committed)).toBe(before)
  })

  test('multipart commit persists skill content and replays the same receipt through a fresh catalog', async () => {
    const f = await fixture()
    const { catalog, provider } = f.compose()
    const app = f.app(catalog)
    const zip = skillPackage()
    const previewResponse = await app.request('/api/resource-packages/preview', {
      method: 'POST',
      body: upload(zip),
    })
    const previewBody = await previewResponse.text()
    expect(previewResponse.status, previewBody).toBe(200)
    const preview = PackagePreviewSchema.parse(JSON.parse(previewBody))
    expect(preview.entries.map((entry) => entry.localSlug)).toEqual(['skill-guide'])

    const commit = async (target: Hono) => {
      const form = upload(zip)
      form.set('previewToken', preview.previewToken)
      form.set(
        'decisions',
        JSON.stringify([{ localSlug: 'skill-guide', action: 'new', finalName: 'imported-guide' }]),
      )
      form.set('humanMemberMappings', '[]')
      form.set('secretInputs', '[]')
      const response = await target.request('/api/resource-packages/commit', {
        method: 'POST',
        body: form,
      })
      const body = await response.text()
      expect(response.status, body).toBe(200)
      return PackageImportReceiptSchema.parse(JSON.parse(body))
    }

    const receipt = await commit(app)
    const landed = await harness.db.select().from(skills).where(eq(skills.ownerUserId, OWNER))
    expect(landed).toHaveLength(1)
    const skill = landed[0]!
    expect(skill).toMatchObject({
      name: 'imported-guide',
      description: 'resource package provider conformance',
      contentVersion: 1,
      reservationState: 'ready',
    })
    expect(receipt.applied).toEqual([
      {
        opId: 'op-1',
        resourceType: 'skill',
        resourceId: skill.id,
        action: 'create',
        name: 'imported-guide',
      },
    ])
    expect(receipt.root).toEqual({
      resourceType: 'skill',
      resourceId: skill.id,
      name: 'imported-guide',
      action: 'create',
    })
    const tree = await provider.readSkillTree(skill.id)
    expect(tree.frontmatterExtra).toEqual({ license: 'MIT' })
    expect(tree.bodyMd.trim()).toBe('# Guide\n\nImported content.')
    expect(tree.files.map((file) => file.path)).toEqual(FILES.map((file) => file.path))
    expect(tree.files.map((file) => [...file.bytes])).toEqual(FILES.map((file) => [...file.bytes]))
    const versions = await harness.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skill.id))
    expect(versions).toHaveLength(1)
    for (const file of FILES) {
      expect([
        ...readFileSync(join(f.appHome, 'skills', skill.id, 'versions', 'v1', 'files', file.path)),
      ]).toEqual([...file.bytes])
    }

    expect(await commit(f.app(f.compose().catalog))).toEqual(receipt)
    expect(
      await harness.db.select().from(skills).where(eq(skills.ownerUserId, OWNER)),
    ).toHaveLength(1)
    const journals = await harness.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.id, receipt.journalId))
    expect(journals).toHaveLength(1)
    expect(journals[0]!.state).toBe('committed')
    expect(JSON.parse(journals[0]!.receiptJson!).root).toEqual(receipt.root)
  })

  test('provider reads preserve explicit ID order, null fields, and authoritative skill file order', async () => {
    const f = await fixture()
    const { provider } = f.compose()
    for (const [id, name] of [
      ['skill-z', 'Zebra'],
      ['skill-a', 'Alpha'],
    ] as const) {
      await harness.db.insert(skills).values({
        id,
        name,
        description: '',
        managedPath: null,
        ownerUserId: OWNER,
        visibility: 'private',
        schemaVersion: 1,
        contentVersion: 3,
        aclRevision: 0,
        metaRevision: 0,
        reservationState: 'ready',
        versionState: 'snapshot-authoritative',
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
    expect(
      await provider.resources.findOwnedIdsByName({
        kind: 'skill',
        ownerUserId: OWNER,
        name: 'Alpha',
      }),
    ).toEqual(['skill-a'])
    expect(
      await provider.resources.findOwnedIdsByName({
        kind: 'skill',
        ownerUserId: OWNER,
        name: 'empty',
      }),
    ).toEqual([])
    const rows = await provider.reads.listByIds('skill', ['skill-z', 'skill-a'], {
      orderById: true,
    })
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ['skill-a', 'Alpha'],
      ['skill-z', 'Zebra'],
    ])
    expect(rows.map((row) => JSON.parse(row.document).managedPath)).toEqual([null, null])
    expect(await provider.reads.listByIds('skill', [])).toEqual([])

    writeTree(join(f.appHome, 'skills', 'skill-a', 'files'), {
      'SKILL.md': '---\nname: Alpha\n---\n\nLIVE CONTENT\n',
      'a.txt': 'live file',
    })
    writeTree(join(f.appHome, 'skills', 'skill-a', 'versions', 'v3', 'files'), {
      'SKILL.md': '---\nname: Alpha\nlicense: MIT\n---\n\nSNAPSHOT CONTENT\n',
      'b/c.txt': 'nested snapshot',
      'b.txt': 'second snapshot',
      'a.txt': 'first snapshot',
    })
    const tree = await provider.readSkillTree('skill-a')
    expect(tree.frontmatterExtra).toEqual({ license: 'MIT' })
    expect(tree.bodyMd.trim()).toBe('SNAPSHOT CONTENT')
    expect(tree.files.map((file) => [file.path, decode(file.bytes)])).toEqual([
      ['a.txt', 'first snapshot'],
      ['b.txt', 'second snapshot'],
      ['b/c.txt', 'nested snapshot'],
    ])
  })
})
