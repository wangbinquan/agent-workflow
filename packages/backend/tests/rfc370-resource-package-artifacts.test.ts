// RFC-370: selected storage owners must drive the real package apply and recovery,
// while AW retains durable journal, database publication and replay semantics.
import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { PackagePreviewSchema } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { plugins, resourceBundleApplies, skills, skillVersions, users } from '@/db/schema'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type {
  ResourcePackageMutationArtifact,
  ResourcePackagePluginArtifactOwner,
  ResourcePackageSkillArtifactOwner,
} from '@/modules/resource-catalog/application/package/artifactOwners'
import type { ResourcePackageApplyArtifactRecoveryPort } from '@/modules/resource-catalog/application/resourcePackageMaintenance'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composePostgresqlResourcePackageProvider } from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import {
  composePostgresqlResourcePackageApplyMaintenance,
  composeSqliteResourcePackageApplyMaintenance,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { buildPackagePreviewFromReadPort } from '@/services/resourcePackage/preview'
import { encodeZip } from '@/util/zip'
import { describeEachProvider } from './helpers/eachProvider'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
const utf8 = (text: string) => new TextEncoder().encode(text)
const binary = new Uint8Array([0, 255, 128, 10])
const ownerId = 'package-storage-owner'
const hash = 'a'.repeat(64)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageBytes(kind: 'skill' | 'plugin') {
  const slug = `${kind}-storage`
  const requirements =
    kind === 'plugin'
      ? `requirements:
  pluginSources:
    - name: storage
      spec: storage-fixture@1.0.0
      sourceKind: npm`
      : 'requirements: {}'
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: ${slug}
  type: ${kind}
  name: storage
resources:
  - slug: ${slug}
    type: ${kind}
    name: storage
${requirements}
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
              opId: 'op-storage',
              kind: `${kind}-create`,
              slug,
              payload:
                kind === 'skill'
                  ? {
                      name: 'storage',
                      description: '',
                      frontmatterExtra: {},
                      bodyMd: 'storage bytes',
                      files: [{ path: 'binary.bin', ref: 'skills/skill-storage/files/binary.bin' }],
                    }
                  : {
                      name: 'storage',
                      description: '',
                      options: {},
                      enabled: true,
                      spec: 'storage-fixture@1.0.0',
                      sourceKind: 'npm',
                    },
            },
          ],
          rootRef: `local:${slug}`,
        }),
      ),
    },
    ...(kind === 'skill' ? [{ path: 'skills/skill-storage/files/binary.bin', bytes: binary }] : []),
  ])
}

describeEachProvider('RFC-370 selected resource package artifacts', (harness) => {
  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'aw-package-artifacts-'))
    roots.push(directory)
    const appHome = join(directory, 'absent-home')
    const actor = buildActor({
      user: {
        id: ownerId,
        username: ownerId,
        displayName: 'Storage Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    })
    await harness.db.insert(users).values({ ...actor.user, createdAt: 1, updatedAt: 1 })
    const authority = new AuthorityClaimRegistry().mintLocalAuthority({
      userId: ownerId,
      source: 'system',
    })
    const box = createSecretBoxFromKey(randomBytes(32))
    const journal = async () => {
      const rows = await harness.db.select().from(resourceBundleApplies)
      expect(rows).toHaveLength(1)
      return rows[0]!
    }
    const apply = async (
      kind: 'skill' | 'plugin',
      skillArtifacts: ResourcePackageSkillArtifactOwner,
      pluginArtifacts: ResourcePackagePluginArtifactOwner,
    ) => {
      const provider = composePostgresqlResourcePackageProvider({
        db: harness.db,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({
          db: harness.db,
        }),
        skillArtifacts,
        pluginArtifacts,
      })
      const pkg = await parseResourcePackage(packageBytes(kind))
      const preview = PackagePreviewSchema.parse(
        await buildPackagePreviewFromReadPort(provider.reads, actor, pkg, {
          box,
          importId: 'storage-preview',
        }),
      )
      return createPostgresqlResourcePackageAtomicApplyOperations({ db: harness.db, box }).apply({
        actor,
        authority,
        package: pkg,
        previewToken: preview.previewToken,
        decisions: [{ localSlug: `${kind}-storage`, action: 'new' }],
        humanMemberMappings: [],
        secretInputs: [],
        mutationSessionFactory: provider.mutationSessionFactory,
      })
    }
    return { appHome, journal, apply }
  }

  function owners(input: {
    stage(artifact: ResourcePackageMutationArtifact): Promise<void>
    compensate(artifact: ResourcePackageMutationArtifact, committed: boolean): Promise<void>
    rollForward(artifact: ResourcePackageMutationArtifact): Promise<void>
    afterCommitted(): Promise<void>
  }): { skill: ResourcePackageSkillArtifactOwner; plugin: ResourcePackagePluginArtifactOwner } {
    return {
      skill: {
        planCreate(context, request) {
          const artifact = {
            kind: 'skill-stage' as const,
            operationId: request.mutation.opId,
            skillId: request.skillId,
            stagingDirectory: 'object-ref:skill-stage',
            targetDirectory: 'object-ref:skill-live',
          }
          return {
            artifact,
            async stage() {
              expect(context.readSkillFile?.('skills/skill-storage/files/binary.bin')).toEqual(
                binary,
              )
              await input.stage(artifact)
              return {
                managedPath: 'object-ref:skill-live',
                filesPath: 'object-ref:skill-v1',
                contentHash: hash,
              }
            },
          }
        },
        planUpdate() {
          throw new Error('create fixture must not update')
        },
        compensate: async (_context, request) =>
          await input.compensate(request.artifact, request.databaseCommitted),
        rollForward: async (_context, request) => await input.rollForward(request.artifact),
        afterCommitted: async () => await input.afterCommitted(),
      },
      plugin: {
        planInstall(_context, request) {
          const artifact = {
            kind: 'plugin-install' as const,
            operationId: request.mutation.opId,
            pluginId: request.pluginId,
            generationId: request.generationId,
            generationDirectory: 'object-ref:plugin-generation',
          }
          return {
            artifact,
            async install() {
              await input.stage(artifact)
              return {
                sourceKind: 'npm',
                cachedPath: 'object-ref:plugin-content',
                resolvedVersion: '1.0.0',
              }
            },
          }
        },
        compensate: async (_context, request) =>
          await input.compensate(request.artifact, request.databaseCommitted),
        rollForward: async (_context, request) => await input.rollForward(request.artifact),
        afterCommitted: async () => await input.afterCommitted(),
      },
    }
  }

  for (const kind of ['skill', 'plugin'] as const) {
    test(`${kind} apply records before staging, waits for effects and publishes selected storage references`, async () => {
      const f = await fixture()
      const entered = barrier(),
        stage = barrier(),
        published = barrier(),
        finish = barrier(),
        tail = barrier(),
        releaseTail = barrier()
      const calls: string[] = []
      let afterCount = 0,
        settled = false
      const selected = owners({
        async stage(artifact) {
          const row = await f.journal()
          expect(row.state).toBe('prepared')
          expect(JSON.parse(row.preparedArtifactsJson)).toEqual([artifact])
          calls.push('stage')
          entered.release()
          await stage.pending
        },
        async compensate() {
          throw new Error('successful apply must not compensate')
        },
        async rollForward(artifact) {
          const row = await f.journal()
          expect(row.state).toBe('committed')
          expect(JSON.parse(row.preparedArtifactsJson)).toEqual([artifact])
          calls.push('publish')
          published.release()
          await finish.pending
        },
        async afterCommitted() {
          afterCount++
          tail.release()
          await releaseTail.pending
        },
      })
      const pending = f.apply(kind, selected.skill, selected.plugin).then((receipt) => {
        settled = true
        return receipt
      })
      try {
        await Promise.race([
          entered.pending,
          pending.then(() => {
            throw new Error('stage not reached')
          }),
        ])
        expect(await harness.db.select().from(kind === 'skill' ? skills : plugins)).toHaveLength(0)
        expect(settled).toBe(false)
        stage.release()
        await Promise.race([
          published.pending,
          pending.then(() => {
            throw new Error('publication not reached')
          }),
        ])
        expect(settled).toBe(false)
        const rows = await harness.db.select().from(kind === 'skill' ? skills : plugins)
        expect(rows).toHaveLength(1)
        if (kind === 'skill') {
          expect(await harness.db.select({ managedPath: skills.managedPath }).from(skills)).toEqual(
            [{ managedPath: 'object-ref:skill-live' }],
          )
          expect(
            await harness.db
              .select({
                filesPath: skillVersions.filesPath,
                contentHash: skillVersions.contentHash,
              })
              .from(skillVersions),
          ).toEqual([{ filesPath: 'object-ref:skill-v1', contentHash: hash }])
        } else {
          expect(await harness.db.select({ cachedPath: plugins.cachedPath }).from(plugins)).toEqual(
            [{ cachedPath: 'object-ref:plugin-content' }],
          )
        }
        finish.release()
        await Promise.race([
          tail.pending,
          pending.then(() => {
            throw new Error('completion tail not reached')
          }),
        ])
        expect(settled).toBe(false)
        releaseTail.release()
        const receipt = await pending
        expect(receipt.applied).toHaveLength(1)
        expect(afterCount).toBe(2)
        expect(calls).toEqual(['stage', 'publish'])
        expect(existsSync(f.appHome)).toBe(false)
      } finally {
        stage.release()
        finish.release()
        tail.release()
        releaseTail.release()
        await pending.catch(() => {})
      }
    })
  }

  test('failed staging waits for selected compensation before marking the durable attempt failed', async () => {
    const f = await fixture(),
      cleaning = barrier(),
      release = barrier()
    const error = new Error('storage stage failed')
    const selected = owners({
      async stage() {
        throw error
      },
      async compensate(artifact, committed) {
        expect(committed).toBe(false)
        expect(JSON.parse((await f.journal()).preparedArtifactsJson)).toEqual([artifact])
        cleaning.release()
        await release.pending
      },
      async rollForward() {
        throw new Error('failed staging must not publish')
      },
      async afterCommitted() {
        throw new Error('failed staging must not complete')
      },
    })
    let settled = false
    const pending = f.apply('skill', selected.skill, selected.plugin)
    const observed = pending.then(
      () => {
        settled = true
        return null
      },
      (failure: unknown) => {
        settled = true
        return failure
      },
    )
    try {
      await Promise.race([
        cleaning.pending,
        observed.then(() => {
          throw new Error('compensation not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect((await f.journal()).state).toBe('prepared')
      expect(await harness.db.select().from(skills)).toHaveLength(0)
      release.release()
      expect(await observed).toBe(error)
      expect((await f.journal()).state).toBe('failed')
      expect(existsSync(f.appHome)).toBe(false)
    } finally {
      release.release()
      await observed
    }
  })

  test('a committed publication failure retains the journal for selected recovery and never reverts rows', async () => {
    const f = await fixture(),
      error = new Error('storage publication unavailable')
    const compensation: boolean[] = []
    const selected = owners({
      async stage() {},
      async compensate(_artifact, committed) {
        compensation.push(committed)
        throw error
      },
      async rollForward() {
        throw error
      },
      async afterCommitted() {
        throw new Error('failed publication must not complete')
      },
    })
    await expect(f.apply('skill', selected.skill, selected.plugin)).rejects.toBe(error)
    const row = await f.journal()
    expect(row.state).toBe('committed')
    expect(row.receiptJson).not.toBeNull()
    expect(compensation).toEqual([true])
    expect(await harness.db.select().from(skills)).toHaveLength(1)
    let recovered = 0
    const maintenance = composePostgresqlResourcePackageApplyMaintenance({
      db: harness.db,
      appHome: f.appHome,
      pluginsDir: join(f.appHome, 'plugins'),
      artifacts: {
        async rollForward(snapshot) {
          expect(snapshot).toMatchObject({
            id: row.id,
            preparedArtifactsJson: row.preparedArtifactsJson,
            receiptJson: row.receiptJson,
          })
          recovered++
        },
        async compensate() {
          throw new Error('committed recovery must not compensate')
        },
      },
    })
    expect(await maintenance.command.converge({ activeApplyIds: [] })).toEqual({
      failed: 0,
      rolledForward: 1,
    })
    expect(recovered).toBe(1)
    expect((await f.journal()).state).toBe('committed')
    expect(existsSync(f.appHome)).toBe(false)
  })

  for (const composition of ['sqlite', 'postgresql'] as const) {
    test(`${composition} maintenance waits for selected recovery, retries failures and preserves active attempts`, async () => {
      const f = await fixture(),
        entered = barrier(),
        release = barrier()
      const now = 10_000_000
      for (const [id, state] of [
        ['committed', 'committed'],
        ['stale', 'applying'],
        ['active', 'applying'],
      ] as const) {
        await harness.db.insert(resourceBundleApplies).values({
          id,
          scope: 'storage-test',
          key: id,
          actorUserId: ownerId,
          state,
          preparedArtifactsJson: 'opaque-adapter-journal',
          receiptJson: state === 'committed' ? 'opaque-adapter-receipt' : null,
          createdAt: 1,
          updatedAt: 1,
        })
      }
      let failing = true,
        settled = false
      const calls: string[] = []
      const artifacts: ResourcePackageApplyArtifactRecoveryPort = {
        async rollForward(row) {
          expect(row.preparedArtifactsJson).toBe('opaque-adapter-journal')
          calls.push(`publish:${row.id}`)
          if (failing) throw new Error('storage offline')
        },
        async compensate(row) {
          calls.push(`cleanup:${row.id}`)
          expect(row.id).toBe('stale')
          if (failing) throw new Error('storage offline')
          entered.release()
          await release.pending
        },
      }
      const input = {
        db: harness.db,
        appHome: f.appHome,
        pluginsDir: join(f.appHome, 'plugins'),
        artifacts,
        now: () => now,
      }
      const maintenance =
        composition === 'sqlite'
          ? composeSqliteResourcePackageApplyMaintenance({
              ...input,
              activitySource: { activeApplyIds: () => ['active'] },
            })
          : composePostgresqlResourcePackageApplyMaintenance(input)
      expect(await maintenance.command.converge({ activeApplyIds: ['active'] })).toEqual({
        failed: 0,
        rolledForward: 0,
      })
      failing = false
      const pending = maintenance.command
        .converge({ activeApplyIds: ['active'] })
        .then((result) => {
          settled = true
          return result
        })
      try {
        await Promise.race([
          entered.pending,
          pending.then(() => {
            throw new Error('cleanup not reached')
          }),
        ])
        expect(settled).toBe(false)
        expect(
          (
            await harness.db
              .select()
              .from(resourceBundleApplies)
              .where(eq(resourceBundleApplies.id, 'stale'))
              .get()
          )?.state,
        ).toBe('applying')
        release.release()
        expect(await pending).toEqual({ failed: 1, rolledForward: 1 })
        expect(
          (
            await harness.db
              .select()
              .from(resourceBundleApplies)
              .where(eq(resourceBundleApplies.id, 'active'))
              .get()
          )?.state,
        ).toBe('applying')
        expect([...calls].sort()).toEqual([
          'cleanup:stale',
          'cleanup:stale',
          'publish:committed',
          'publish:committed',
        ])
        expect(existsSync(f.appHome)).toBe(false)
      } finally {
        release.release()
        await pending.catch(() => {})
      }
    })
  }
})
