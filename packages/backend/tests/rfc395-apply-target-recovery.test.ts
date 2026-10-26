import { createFileResourcePackageSkillArtifactOwner } from '@/modules/resource-catalog/infrastructure/local/fileResourcePackageArtifacts'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
// RFC-395 P: target envelopes recover against explicit live/snapshot references on both providers.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { createTestDb } from './helpers/testDatabase'
import { createIntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/intentApplyArtifactLifecycle'
import { createIntentApplyRecoveryScene } from '@/modules/intent/infrastructure/intentApplyRecovery'
import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { reencodeIntentApplyArtifacts } from '@/modules/intent/infrastructure/migration/applyJournalRule'
import {
  createSkillContentLocationQuery,
  skillTreeColumns,
  writeTree,
  readTree,
  hashSkillTree,
} from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import { createDatabaseSkillArtifactOwners } from '@/modules/resource-catalog/infrastructure/crewstation/skillArtifacts'
import { createFileIntentSkillArtifactOwner } from '@/modules/resource-catalog/infrastructure/local/fileIntentApplyArtifactOwners'
import { createResourcePackageOperationArtifactRecovery } from '@/modules/resource-catalog/infrastructure/resourcePackageOperationRecovery'
import { createVersionedResourcePackageArtifactRecovery } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactRecovery'
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '@/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import {
  reencodeBundleApplyArtifacts,
  reencodeBundleApplyReceipt,
} from '@/modules/resource-catalog/infrastructure/migration/bundleAppliesRule'
import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { resolveAtomicApplyReplay } from '@/platform/atomic-apply/replay'
import { INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE } from '@/modules/intent/application/journalConvergence'
import { createResourcePackageRecoveryScene } from '@/modules/resource-catalog/infrastructure/resourcePackageRecovery'
import { createResourcePackageApplyJournalPort } from '@/modules/resource-catalog/infrastructure/resourcePackageApplyJournal'
import { createFileResourcePackageRecoveryEffectsFactory } from '@/modules/resource-catalog/infrastructure/local/fileResourcePackageRecoveryEffects'
import { finishOperation } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type { ResourcePackageRecoveryEffectsFactory } from '@/modules/resource-catalog/application/package/recoveryContentEffects'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  IntentArtifactContentPort,
  IntentSkillArtifactPublication,
} from '@/modules/intent/application/ports/intentArtifactContent'
import type { Logger } from '@/util/log'

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log }
const skillId = 'target-skill'
const artifact: IntentApplyArtifact = {
  kind: 'skill-version-stage',
  skillId,
  operationId: 'persisted-op',
  version: 2,
  stagingDirectory: 'skills/target-skill/staging/persisted-op',
  versionDirectory: 'skills/target-skill/versions/v2/files',
}

describeEachProvider('RFC-395 P target apply recovery', (h) => {
  async function seed(
    kind: 'local-file' | 'database-bytes',
    version: number,
    snapshot: boolean,
    contentHash = 'snapshot-hash',
    snapshotVersion = 2,
  ) {
    const { skills, skillVersions } = tablesOf(h.db)
    await h.db.insert(skills).values({
      id: skillId,
      name: skillId,
      description: '',
      contentVersion: version,
      ...skillTreeColumns(skillId, 'live', kind, 'skills/name-keyed/files'),
      createdAt: 1,
      updatedAt: 1,
    })
    if (snapshot)
      await h.db.insert(skillVersions).values({
        id: `snapshot-${snapshotVersion}`,
        skillId,
        versionIndex: snapshotVersion,
        source: 'import',
        contentHash,
        ...skillTreeColumns(
          skillId,
          `version:${snapshotVersion}`,
          kind,
          `skills/name-keyed/versions/v${snapshotVersion}/files`,
        ),
        createdAt: 1,
      })
  }
  function recordingContent() {
    const published: IntentSkillArtifactPublication[] = []
    const discarded: string[] = []
    const content: IntentArtifactContentPort = {
      pluginExists: () => true,
      discardPlugin() {},
      discardLegacy() {
        throw new Error('no runtime legacy payload')
      },
      publishSkill: (value) => {
        published.push(value)
      },
      discardSkill: ({ artifact }) => {
        discarded.push(artifact.skillId)
      },
    }
    const lifecycle = createIntentApplyArtifactLifecycle({
      db: h.db,
      appHome: '/unused',
      pluginsDir: '/unused/plugins',
      skillContentLocations: createSkillContentLocationQuery(h.db),
      content,
    })
    return { lifecycle, published, discarded }
  }

  function convertedPackageVersion() {
    const paths = createFileResourcePackageRecoveryEffectsFactory('/unused')
    const publishId = 'source-publish'
    const effects: string[] = []
    const warnings: { message: string; fields?: Record<string, unknown> }[] = []
    const factory: ResourcePackageRecoveryEffectsFactory = {
      ...paths,
      acquire() {
        effects.push('acquire')
        return {
          exists: () => true,
          createDirectory(reference) {
            effects.push(`mkdir:${reference}`)
          },
          removeDirectory(reference) {
            effects.push(`remove:${reference}`)
          },
          move() {
            throw new Error('unexpected move')
          },
          cleanupOperation(_reference, id) {
            effects.push(`cleanup:${id}`)
          },
          swapStaged(_reference, id) {
            effects.push(`swap:${id}`)
            return { hadPrevious: true }
          },
          restoreBackup() {
            throw new Error('unexpected restore')
          },
          directoryChainState() {
            effects.push('chain')
            return 'real-directory'
          },
          hashRegularTree() {
            effects.push('hash')
            return 'snapshot-hash'
          },
          close() {
            effects.push('close')
          },
        }
      },
    }
    const source = JSON.stringify([
      {
        kind: 'skill-version-stage',
        staged: {
          skillId,
          skillName: 'skill',
          opId: 'source-version-op',
          publishId,
          newVersion: 2,
          newHash: 'snapshot-hash',
          filesDir: paths.live(skillId),
          versionDir: paths.version(skillId, 2),
          stagingDir: paths.staged(paths.live(skillId), publishId),
          noop: null,
        },
      },
    ])
    const receiptJson = reencodeBundleApplyReceipt(
      JSON.stringify({
        journalId: 'package-version',
        applied: [
          {
            opId: 'receipt-op',
            resourceType: 'skill',
            resourceId: skillId,
            action: 'update',
            name: 'skill',
          },
        ],
      }),
    )
    const journal = {
      id: 'package-version',
      state: 'committed' as const,
      preparedArtifactsJson: reencodeBundleApplyArtifacts(source, receiptJson),
      receiptJson,
      updatedAt: 1,
    }
    const operations = createResourcePackageOperationArtifactRecovery({
      db: h.db,
      appHome: '/unused',
      pluginsDir: '/unused/plugins',
      effectsFactory: factory,
      log: {
        warn: (message, fields) => {
          warnings.push({ message, fields })
        },
      },
    })
    const recovery = createVersionedResourcePackageArtifactRecovery(
      {
        rollForward() {
          throw new Error('converted version must use the operation adapter')
        },
        compensate() {
          throw new Error('converted version must use the operation adapter')
        },
      },
      operations,
    )
    return { paths, effects, warnings, journal, recovery, publishId }
  }

  test('target database defaults produce empty scene envelopes when both columns are omitted', async () => {
    const { intentSessions, intentApplyJournal, resourceBundleApplies } = tablesOf(h.db)
    await h.db
      .insert(intentSessions)
      .values({ id: 'session', ownerUserId: 'owner', createdAt: 1, updatedAt: 1 })
    await h.executeFixtureDdl(`INSERT INTO intent_apply_journal
      (id, session_id, client_mutation_id, draft_id, draft_hash, created_at, updated_at)
      VALUES ('default-intent', 'session', 'key', 'draft', 'hash', 1, 1)`)
    await h.executeFixtureDdl(`INSERT INTO resource_bundle_applies
      (id, scope, key, actor_user_id, created_at, updated_at)
      VALUES ('default-package', 'scope', 'key', 'owner', 1, 1)`)
    const intent = (await h.db.select().from(intentApplyJournal))[0]!
    const bundle = (await h.db.select().from(resourceBundleApplies))[0]!
    expect(intent.preparedArtifactsJson).toBe(intentApplyArtifactCodecs.encode([]))
    expect(bundle.preparedArtifactsJson).toBe(resourcePackageArtifactCodecs.encode([]))
    expect(intentApplyArtifactCodecs.decode(intent.preparedArtifactsJson)).toEqual([])
    expect(resourcePackageArtifactCodecs.decode(bundle.preparedArtifactsJson)).toEqual([])
  })

  test.each([
    'active',
    'done',
    'aborted',
    'superseded',
    'deleted',
    'missing-snapshot',
    'hash-mismatch',
    'missing-generation',
  ] as const)(
    'converted package skill-version-stage: %s follows the operation adapter and keeps its identities',
    async (state) => {
      if (state !== 'deleted')
        await seed(
          'local-file',
          state === 'superseded' ? 3 : state === 'missing-generation' ? 1 : 2,
          state !== 'missing-snapshot',
          state === 'hash-mismatch' ? 'different-hash' : 'snapshot-hash',
        )
      const { skillOperations } = tablesOf(h.db)
      const phase =
        state === 'done' ? 'done' : state === 'aborted' ? 'fs-versioned' : 'db-committed'
      const active = state === 'done' || state === 'aborted' ? 0 : 1
      await h.db.insert(skillOperations).values({
        opId: 'source-version-op',
        skillId,
        kind: 'version-write',
        phase,
        active,
        targetVersion: 2,
        createdAt: 1,
      })
      const { paths, journal, recovery, effects, warnings, publishId } = convertedPackageVersion()
      expect(resourcePackageArtifactCodecs.decode(journal.preparedArtifactsJson)[0]).toMatchObject({
        operationId: 'receipt-op',
        publishId,
        recovery: { operationId: 'source-version-op', publishId },
      })
      if (
        state === 'aborted' ||
        state === 'missing-snapshot' ||
        state === 'hash-mismatch' ||
        state === 'missing-generation'
      ) {
        const error =
          state === 'aborted'
            ? 'resource-package-skill-operation-not-replayable:source-version-op'
            : state === 'missing-generation'
              ? `resource-package-skill-publication-missing:${skillId}`
              : `resource-package-skill-snapshot-missing:${skillId}:2`
        await expect(recovery.rollForward(journal)).rejects.toThrow(error)
        await expect(recovery.rollForward(journal)).rejects.toThrow(error)
        expect(effects).toEqual([])
        expect(warnings).toEqual(
          state === 'aborted'
            ? [1, 2].map(() => ({
                message: 'resource-package-skill-publish-op-not-replayable',
                fields: { skillId, operationId: 'source-version-op', phase },
              }))
            : [],
        )
      } else {
        await recovery.rollForward(journal)
        expect(effects).toEqual(
          state === 'active'
            ? [
                'acquire',
                `mkdir:${paths.parent(paths.live(skillId))}`,
                `swap:${publishId}`,
                'chain',
                'hash',
                `cleanup:${publishId}`,
                'close',
              ]
            : state === 'done'
              ? []
              : [
                  'acquire',
                  `cleanup:${publishId}`,
                  `remove:${paths.candidate(paths.version(skillId, 2), publishId)}`,
                  'close',
                ],
        )
        expect(warnings).toEqual([])
        if (state === 'active' || state === 'done') {
          const firstEffects = [...effects]
          const recording = h.recordStatements()
          try {
            await recovery.rollForward(journal)
            expect(effects).toEqual(firstEffects)
            expect(
              recording.statements.filter(({ sql }) =>
                /\bupdate\s+[^;]*skill_operations/i.test(sql),
              ),
            ).toEqual([])
          } finally {
            recording.stop()
          }
        }
      }
      expect((await h.db.select().from(skillOperations))[0]).toMatchObject({
        opId: 'source-version-op',
        active: state === 'active' ? 0 : active,
        phase: state === 'active' ? 'done' : phase,
      })
    },
  )

  test('converted package version compensation uses the operation adapter and preserves the published snapshot', async () => {
    await seed('local-file', 2, true)
    const { skillOperations, resourceBundleApplies } = tablesOf(h.db)
    const { skillVersions } = tablesOf(h.db)
    const snapshots = await h.db.select().from(skillVersions)
    await h.db.insert(skillOperations).values({
      opId: 'source-version-op',
      skillId,
      kind: 'version-write',
      phase: 'fs-versioned',
      active: 1,
      createdAt: 1,
    })
    const { paths, journal, recovery, effects, publishId } = convertedPackageVersion()
    await h.db.insert(resourceBundleApplies).values({
      ...journal,
      state: 'applying',
      receiptJson: null,
      scope: 'scope',
      key: 'key',
      actorUserId: 'owner',
      createdAt: 1,
    })
    const convergence = createAtomicApplyRecovery([
      createResourcePackageRecoveryScene({
        journal: createResourcePackageApplyJournalPort(h.db),
        artifacts: recovery,
        now: () => 700_001,
      }),
    ])
    expect(await convergence.converge({ 'resource-package': [] })).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    const expectedEffects = [
      'acquire',
      `cleanup:${publishId}`,
      `remove:${paths.candidate(paths.version(skillId, 2), publishId)}`,
      'close',
    ]
    expect(effects).toEqual(expectedEffects)
    expect((await h.db.select().from(skillOperations))[0]).toMatchObject({
      active: 0,
      phase: 'fs-versioned',
    })
    expect(await h.db.select().from(skillVersions)).toEqual(snapshots)
    expect((await h.db.select().from(resourceBundleApplies))[0]).toMatchObject({
      state: 'failed',
      preparedArtifactsJson: journal.preparedArtifactsJson,
      error: 'converged: crashed before commit',
    })
    expect(await convergence.converge({ 'resource-package': [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(effects).toEqual(expectedEffects)
  })

  test('failed history rows preserve failure, envelope and receipt bytes across repeated convergence and replay', async () => {
    const { intentSessions, intentApplyJournal, resourceBundleApplies } = tablesOf(h.db)
    await h.db
      .insert(intentSessions)
      .values({ id: 'session', ownerUserId: 'owner', createdAt: 1, updatedAt: 1 })
    const failed = {
      state: 'failed' as const,
      error: 'original failure',
      receiptJson: ' {"historical":true}\n',
      createdAt: 1,
      updatedAt: 2,
    }
    await h.db.insert(intentApplyJournal).values({
      ...failed,
      id: 'failed-intent',
      sessionId: 'session',
      clientMutationId: 'key',
      draftId: 'draft',
      draftHash: 'hash',
      preparedArtifactsJson: intentApplyArtifactCodecs.encode([]),
    })
    await h.db.insert(resourceBundleApplies).values({
      ...failed,
      id: 'failed-package',
      scope: 'scope',
      key: 'key',
      actorUserId: 'owner',
      preparedArtifactsJson: resourcePackageArtifactCodecs.encode([]),
    })
    const before = [
      ...(await h.db.select().from(intentApplyJournal)),
      ...(await h.db.select().from(resourceBundleApplies)),
    ]
    let effects = 0
    const convergence = createAtomicApplyRecovery([
      createIntentApplyRecoveryScene({
        db: h.db,
        log,
        artifacts: {
          async compensate() {
            effects += 1
          },
          async rollForward() {
            effects += 1
            return true
          },
        },
      }),
      createResourcePackageRecoveryScene({
        journal: createResourcePackageApplyJournalPort(h.db),
        artifacts: {
          async compensate() {
            effects += 1
          },
          async rollForward() {
            effects += 1
          },
        },
      }),
    ])
    for (let pass = 0; pass < 2; pass += 1)
      expect(await convergence.converge({ intent: [], 'resource-package': [] })).toEqual({
        failed: 0,
        rolledForward: 0,
      })
    const after = [
      ...(await h.db.select().from(intentApplyJournal)),
      ...(await h.db.select().from(resourceBundleApplies)),
    ]
    expect(after).toEqual(before)
    expect(effects).toBe(0)
    for (const row of after)
      expect(() =>
        resolveAtomicApplyReplay(row, {
          decode() {
            throw new Error('failed replay must not decode the receipt')
          },
          failedReplay: (failedRow) => new Error(failedRow.error!),
          unsettledReplay: () => new Error('failed replay must remain failed'),
        }),
      ).toThrow('original failure')
  })

  test('plugin roll-forward warnings retain the persisted generation id', async () => {
    const { plugins } = tablesOf(h.db)
    await h.db.insert(plugins).values({
      id: 'plugin',
      name: 'plugin',
      spec: 'plugin',
      sourceKind: 'file',
      cachedPath: '/missing/plugin',
      installedAt: 1,
    })
    const warnings: { message: string; fields?: Record<string, unknown> }[] = []
    const lifecycle = createIntentApplyArtifactLifecycle({
      db: h.db,
      appHome: '/unused',
      pluginsDir: '/unused/plugins',
      skillContentLocations: createSkillContentLocationQuery(h.db),
      content: {
        pluginExists: () => false,
        discardPlugin() {},
        discardLegacy() {},
        discardSkill() {},
        publishSkill() {},
      },
    })
    expect(
      await lifecycle.rollForward(
        [
          {
            kind: 'plugin-install',
            pluginId: 'plugin',
            generationId: 'original-generation',
            generationDir: '/missing/plugin',
          },
        ],
        {
          ...log,
          warn: (message, fields) => {
            warnings.push({ message, fields })
          },
        },
      ),
    ).toBe(false)
    expect(warnings).toEqual([
      {
        message: 'intent-apply-artifact-roll-forward-retryable',
        fields: {
          kind: 'plugin-install',
          operationId: 'original-generation',
          err: 'intent-apply-plugin-publication-missing:plugin',
        },
      },
    ])
  })

  for (const kind of ['local-file', 'database-bytes'] as const) {
    for (const state of [
      'current',
      'superseded',
      'missing-snapshot',
      'missing-generation',
      'deleted',
    ] as const) {
      test(`${kind}: ${state} uses exact snapshot identity and never substitutes live`, async () => {
        if (state !== 'deleted')
          await seed(
            kind,
            state === 'superseded' ? 3 : state === 'missing-generation' ? 1 : 2,
            state !== 'missing-snapshot',
          )
        const { lifecycle, published, discarded } = recordingContent()
        const ok = await lifecycle.rollForward(
          intentApplyArtifactCodecs.decode(intentApplyArtifactCodecs.encode([artifact])),
          log,
        )
        expect(ok).toBe(state !== 'missing-snapshot' && state !== 'missing-generation')
        if (state === 'current' || state === 'superseded') {
          expect(published).toHaveLength(1)
          expect(published[0]).toMatchObject({
            disposition: state,
            version: 2,
            contentHash: 'snapshot-hash',
            managedPath:
              kind === 'local-file' ? 'skills/name-keyed/files' : 'skills/target-skill/files',
            filesPath:
              kind === 'local-file'
                ? 'skills/name-keyed/versions/v2/files'
                : 'skills/target-skill/versions/v2/files',
          })
        } else expect(published).toEqual([])
        expect(discarded).toEqual(state === 'deleted' ? [skillId] : [])
      })
    }
  }

  test('a post-commit publication crash remains retryable and the exact persisted envelope recovers once storage returns', async () => {
    const files = [{ path: 'SKILL.md', bytes: new Uint8Array([239, 187, 191, 65, 255]) }]
    await seed('database-bytes', 2, true, hashSkillTree(files))
    await h.session.transaction((tx) => writeTree(tx, skillId, 'staging:persisted-op', files, 1))
    const { intentSessions, intentApplyJournal } = tablesOf(h.db)
    await h.db
      .insert(intentSessions)
      .values({ id: 'session', ownerUserId: 'owner', createdAt: 1, updatedAt: 1 })
    const json = intentApplyArtifactCodecs.encode([artifact])
    await h.db.insert(intentApplyJournal).values({
      id: 'journal',
      sessionId: 'session',
      clientMutationId: 'key',
      draftId: 'draft',
      draftHash: 'hash',
      state: 'committed',
      preparedArtifactsJson: json,
      receiptJson: '{"journalId":"journal","commitSeq":1,"applied":[]}',
      error: 'before recovery attempt',
      createdAt: 1,
      updatedAt: 1,
    })
    const owners = createDatabaseSkillArtifactOwners(h.db)
    let unavailable = true
    const lifecycle = createIntentApplyArtifactLifecycle({
      db: h.db,
      appHome: '/unused',
      pluginsDir: '/unused',
      skillContentLocations: createSkillContentLocationQuery(h.db),
      content: {
        pluginExists: () => true,
        discardPlugin() {},
        discardLegacy() {
          throw new Error('legacy')
        },
        discardSkill: ({ artifact, version }) =>
          owners.recovery.discard({
            skillId: artifact.skillId,
            operationId: artifact.operationId,
            version,
          }),
        publishSkill: async ({ artifact, version }) => {
          if (unavailable) throw new Error('storage temporarily unavailable')
          await owners.recovery.publish({
            skillId: artifact.skillId,
            operationId: artifact.operationId,
            version,
          })
        },
      },
    })
    const recovery = createAtomicApplyRecovery([
      createIntentApplyRecoveryScene({ db: h.db, artifacts: lifecycle, log, now: () => 42 }),
    ])
    expect(await recovery.converge({ intent: [] })).toEqual({ failed: 0, rolledForward: 0 })
    expect((await h.db.select().from(intentApplyJournal))[0]).toMatchObject({
      state: 'committed',
      preparedArtifactsJson: json,
      error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
      updatedAt: 42,
    })
    unavailable = false
    expect(await recovery.converge({ intent: [] })).toEqual({ failed: 0, rolledForward: 1 })
    expect(await readTree(h.db, skillId, 'version:2')).toEqual(files)
    expect(await readTree(h.db, skillId, 'live')).toEqual(files)
    expect(await readTree(h.db, skillId, 'staging:persisted-op')).toEqual([])
    expect((await h.db.select().from(intentApplyJournal))[0]).toMatchObject({
      state: 'committed',
      preparedArtifactsJson: json,
      error: null,
    })
    expect(await recovery.converge({ intent: [] })).toEqual({ failed: 0, rolledForward: 1 })
    expect(await readTree(h.db, skillId, 'version:2')).toEqual(files)
  })

  for (const kind of ['skill-stage', 'skill-version-stage'] as const) {
    test.each(['done', 'intent', 'fs-versioned'] as const)(
      `${kind}: only an inactive done operation settles; %s never republishes or finishes`,
      async (phase) => {
        await seed('local-file', 2, true)
        if (kind === 'skill-stage') {
          const { skillVersions } = tablesOf(h.db)
          await h.db.insert(skillVersions).values({
            id: 'snapshot-1',
            skillId,
            versionIndex: 1,
            source: 'import',
            contentHash: 'snapshot-hash',
            ...skillTreeColumns(skillId, 'version:1', 'local-file', '/source/version'),
            createdAt: 1,
          })
          const { skills } = tablesOf(h.db)
          await h.db.update(skills).set({ contentVersion: 1 }).where(eq(skills.id, skillId))
        }
        const source =
          kind === 'skill-stage'
            ? {
                kind,
                skillId,
                opId: 'operation-id',
                skillDir: '/source/skill',
              }
            : {
                kind: 'skill-version-stage',
                staged: {
                  skillId,
                  skillName: 'skill',
                  opId: 'operation-id',
                  publishId: 'publication-id',
                  newVersion: 2,
                  newHash: 'snapshot-hash',
                  filesDir: '/source/files',
                  versionDir: '/source/version',
                  stagingDir: '/source/staging',
                  noop: null,
                },
              }
        const artifacts = intentApplyArtifactCodecs.decode(
          reencodeIntentApplyArtifacts(JSON.stringify({ version: 1, artifacts: [source] })),
        )
        let effects = 0
        const lifecycle = createIntentApplyArtifactLifecycle({
          db: h.db,
          appHome: '/unused',
          pluginsDir: '/unused',
          skillContentLocations: createSkillContentLocationQuery(h.db),
          content: {
            pluginExists: () => true,
            discardPlugin() {},
            discardLegacy() {},
            discardSkill() {},
            publishSkill() {
              effects += 1
            },
          },
          legacySkillArtifacts: {
            loadSkillOperationState: async () => ({ active: 0, phase }),
            unmarkSkillBootVerified() {
              effects += 1
            },
            publishStagedSkillVersion() {
              effects += 1
            },
            finishOperation() {
              effects += 1
            },
          },
        })
        const warnings: { message: string; fields?: Record<string, unknown> }[] = []
        const recordingLog: Logger = {
          ...log,
          warn: (message, fields) => {
            warnings.push({ message, fields })
          },
        }
        expect(await lifecycle.rollForward(artifacts, recordingLog)).toBe(phase === 'done')
        expect(await lifecycle.rollForward(artifacts, recordingLog)).toBe(phase === 'done')
        expect(effects).toBe(0)
        expect(warnings).toEqual(
          phase === 'done'
            ? []
            : [1, 2].map(() => ({
                message:
                  kind === 'skill-stage'
                    ? 'intent-skill-finish-op-not-replayable'
                    : 'intent-skill-publish-op-not-replayable',
                fields: { skillId, opId: 'operation-id', phase },
              })),
        )
      },
    )
  }

  test('converted Intent create finishes its active operation exactly once through the recording port', async () => {
    await seed('local-file', 1, true, 'snapshot-hash', 1)
    const { skillOperations } = tablesOf(h.db)
    await h.db.insert(skillOperations).values({
      opId: 'create-op',
      skillId,
      kind: 'reserve',
      phase: 'db-committed',
      active: 1,
      createdAt: 1,
    })
    const finished: string[] = []
    const lifecycle = createIntentApplyArtifactLifecycle({
      db: h.db,
      appHome: '/unused',
      pluginsDir: '/unused/plugins',
      skillContentLocations: createSkillContentLocationQuery(h.db),
      content: {
        pluginExists: () => true,
        discardPlugin() {},
        discardLegacy() {},
        discardSkill() {},
        publishSkill() {
          throw new Error('converted create uses the operation port')
        },
      },
      legacySkillArtifacts: {
        loadSkillOperationState: async (db, id) =>
          (await db.select().from(skillOperations).where(eq(skillOperations.opId, id)))[0],
        unmarkSkillBootVerified() {
          throw new Error('create does not publish a version')
        },
        publishStagedSkillVersion() {
          throw new Error('create does not publish a version')
        },
        async finishOperation(tx, id) {
          finished.push(id)
          await finishOperation(tx, id)
        },
      },
    })
    const artifacts = intentApplyArtifactCodecs.decode(
      reencodeIntentApplyArtifacts(
        JSON.stringify([
          { kind: 'skill-stage', skillId, opId: 'create-op', skillDir: '/source/skill' },
        ]),
      ),
    )
    expect(await lifecycle.rollForward(artifacts, log)).toBe(true)
    expect(finished).toEqual(['create-op'])
    expect(await lifecycle.rollForward(artifacts, log)).toBe(true)
    expect(finished).toEqual(['create-op'])
  })

  test('converted source roots survive compensation for content-maintenance holder checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-p-holder-'))
    try {
      const root = join(dir, 'skills', skillId)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'retained.bin'), new Uint8Array([255, 0, 128]))
      const original = JSON.stringify([
        { kind: 'skill-stage', skillId, opId: 'old-create', skillDir: root },
      ])
      const artifacts = intentApplyArtifactCodecs.decode(reencodeIntentApplyArtifacts(original))
      const { lifecycle } = recordingContent()
      await lifecycle.compensate(artifacts[0]!)
      expect(readFileSync(join(root, 'retained.bin'))).toEqual(Buffer.from([255, 0, 128]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('converted package create instructions retain operation ids and never repeat the finish write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-p-package-'))
    try {
      const { skillOperations } = tablesOf(h.db)
      await h.db.insert(skillOperations).values({
        opId: 'source-op',
        skillId,
        kind: 'reserve',
        phase: 'db-committed',
        active: 1,
        createdAt: 1,
      })
      const source = JSON.stringify([
        {
          kind: 'skill-stage',
          skillId,
          opId: 'source-op',
          skillDir: join(root, 'skills', skillId),
        },
      ])
      const receiptJson = reencodeBundleApplyReceipt(
        JSON.stringify({
          journalId: 'j',
          applied: [
            {
              opId: 'bundle-op',
              resourceType: 'skill',
              resourceId: skillId,
              action: 'create',
              name: 'skill',
            },
          ],
        }),
      )
      const preparedArtifactsJson = reencodeBundleApplyArtifacts(source, receiptJson)
      const current = createPostgresqlResourcePackageApplyArtifactRecovery({
        db: h.db,
        appHome: root,
        pluginsDir: join(root, 'plugins'),
      })
      const operations = createResourcePackageOperationArtifactRecovery({
        db: h.db,
        appHome: root,
        pluginsDir: join(root, 'plugins'),
      })
      const recovery = createVersionedResourcePackageArtifactRecovery(current, operations)
      const journal = {
        id: 'j',
        state: 'committed' as const,
        preparedArtifactsJson,
        receiptJson,
        updatedAt: 1,
      }
      await recovery.rollForward(journal)
      const recording = h.recordStatements()
      try {
        await recovery.rollForward(journal)
        expect(
          recording.statements.filter(({ sql }) => /\bupdate\s+[^;]*skill_operations/i.test(sql)),
        ).toEqual([])
      } finally {
        recording.stop()
      }
      expect(resourcePackageArtifactCodecs.decode(preparedArtifactsJson)[0]).toMatchObject({
        operationId: 'bundle-op',
        recovery: { operationId: 'source-op' },
      })
      expect((await h.db.select().from(skillOperations))[0]).toMatchObject({
        active: 0,
        phase: 'done',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('local writer publishes its explicit local-file kind and roundtrips the new envelope', async () => {
  const fixture = await createTestDb()
  const root = mkdtempSync(join(tmpdir(), 'aw-p-local-'))
  try {
    const plan = await createFileIntentSkillArtifactOwner({
      db: fixture.db,
      appHome: root,
    }).planCreate({
      authority: {} as DirectAuthenticatedAuthority,
      operationId: 'op',
      skillId: 'local-skill',
      payload: { name: 'local-skill', description: '', bodyMd: 'body', files: [] },
    })
    const publication = await plan.stage()
    expect(publication.contentKind).toBe('local-file')
    await databaseSessionFor(fixture.db).transaction((tx) => publication.commitInTransaction(tx, 1))
    expect(
      intentApplyArtifactCodecs.decode(intentApplyArtifactCodecs.encode([plan.artifact])),
    ).toEqual([plan.artifact])
    await plan.rollForward()
    expect(
      readFileSync(join(root, publication.filesPath, 'SKILL.md'), { encoding: 'utf8' }),
    ).toBeDefined()
  } finally {
    await fixture.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(['intent', 'package'] as const)(
  '%s local update reads the converted database snapshot and preserves binary files',
  async (scene) => {
    const fixture = await createTestDb()
    const root = mkdtempSync(join(tmpdir(), 'aw-p-converted-update-'))
    try {
      const id = 'converted-skill'
      const files = [
        { path: 'SKILL.md', bytes: Buffer.from('old body') },
        { path: 'binary.dat', bytes: new Uint8Array([255, 0, 128]) },
      ]
      const { skills, skillVersions } = tablesOf(fixture.db)
      await fixture.db.insert(skills).values({
        id,
        name: id,
        description: '',
        contentVersion: 1,
        ...skillTreeColumns(id, 'live', 'database-bytes'),
        createdAt: 1,
        updatedAt: 1,
      })
      await fixture.db.insert(skillVersions).values({
        id: 'initial',
        skillId: id,
        versionIndex: 1,
        source: 'initial',
        contentHash: hashSkillTree(files),
        ...skillTreeColumns(id, 'version:1', 'database-bytes'),
        createdAt: 1,
      })
      await fixture.session.transaction((tx) => writeTree(tx, id, 'version:1', files, 1))
      const plan =
        scene === 'intent'
          ? await createFileIntentSkillArtifactOwner({ db: fixture.db, appHome: root }).planUpdate({
              authority: {} as DirectAuthenticatedAuthority,
              operationId: 'op-1',
              current: {
                id,
                name: id,
                description: '',
                sourceKind: 'managed',
                contentVersion: 1,
                schemaVersion: 1,
                metaRevision: 0,
                createdAt: 1,
                updatedAt: 1,
              },
              payload: { name: id, description: '', bodyMd: 'new body', files: [] },
            })
          : createFileResourcePackageSkillArtifactOwner({
              db: fixture.db,
              appHome: root,
            }).planUpdate(
              {
                actor: {
                  user: {
                    id: 'owner',
                    username: 'owner',
                    displayName: 'Owner',
                    role: 'user',
                    status: 'active',
                  },
                  source: 'session',
                  permissions: new Set(),
                },
                authority: {} as ResourceRequestContext,
                humanMemberMappings: [],
                secretInputs: [],
                readSkillFile: () => new Uint8Array(),
                ids: { mintCreate: () => id, findCreate: () => id, listPending: () => [] },
              },
              {
                skillId: id,
                version: 2,
                publishId: 'publish',
                mutation: {
                  kind: 'skill-update',
                  opId: 'op-1',
                  target: `external:${id}`,
                  expect: {
                    expectedContentVersion: 1,
                    expectedMetaRevision: 0,
                    expectedAclRevision: 0,
                  },
                  payload: {
                    name: id,
                    description: '',
                    bodyMd: 'new body',
                    frontmatterExtra: {},
                    files: [],
                  },
                },
              },
            )
      expect((await plan.stage()).contentKind).toBe('local-file')
      const staged = plan.artifact
      if (staged.kind === 'plugin-install') throw new Error('expected skill artifact')
      expect(readFileSync(join(staged.stagingDirectory, 'binary.dat'))).toEqual(
        Buffer.from([255, 0, 128]),
      )
      expect(await readTree(fixture.db, id, 'version:1')).toEqual(files)
    } finally {
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
