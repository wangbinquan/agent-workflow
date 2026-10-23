// RFC-395 II-a A6 — 场景回放、历史回执与共同恢复调度的双 provider 回归。
import { beforeEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { BundleSchema } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import { createIntentApplyEngine } from '@/modules/intent/infrastructure/intentApplyEngine'
import { createIntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/intentApplyArtifactLifecycle'
import { createIntentApplyRecoveryScene } from '@/modules/intent/infrastructure/intentApplyRecovery'
import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { createResourcePackageAtomicApplyOperations } from '@/modules/resource-catalog/infrastructure/resourcePackageAtomicApply'
import { createResourcePackageApplyJournalPort } from '@/modules/resource-catalog/infrastructure/resourcePackageApplyJournal'
import { createResourcePackageRecoveryScene } from '@/modules/resource-catalog/infrastructure/resourcePackageRecovery'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { PackageManifestSchema, type ParsedPackage } from '@/services/resourcePackage/parse'
import { signPreviewToken } from '@/services/resourcePackage/preview'
import type { Logger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

const actor: Actor = {
  user: { id: 'a6-owner', username: 'a6-owner', displayName: 'A6', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(),
}
const authority = Object.freeze({}) as ResourceRequestContext
const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log }
const receipt = { journalId: 'intent-journal', commitSeq: 1, applied: [] }

describeEachProvider('RFC-395 II-a A6 scene adapters', (harness) => {
  beforeEach(async () => {
    const { users, intentSessions, intentDrafts } = tablesOf(harness.db)
    await insertOne(harness.db, users, { ...actor.user, createdAt: 1, updatedAt: 1 })
    await insertOne(harness.db, intentSessions, {
      id: 'a6-session',
      ownerUserId: actor.user.id,
      title: 'A6',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    await insertOne(harness.db, intentDrafts, {
      id: 'a6-draft',
      sessionId: 'a6-session',
      revision: 1,
      draftHash: 'hash-a',
      contextRevision: 0,
      changesetJson: '{}',
      createdAt: 1,
    })
  })
  async function intentJournal(artifacts: string, state: 'prepared' | 'committed' = 'committed') {
    const { intentApplyJournal } = tablesOf(harness.db)
    await insertOne(harness.db, intentApplyJournal, {
      id: receipt.journalId,
      sessionId: 'a6-session',
      clientMutationId: 'a6-mutation',
      draftId: 'a6-draft',
      draftHash: 'hash-a',
      state,
      preparedArtifactsJson: artifacts,
      receiptJson: state === 'committed' ? JSON.stringify(receipt) : null,
      error: state === 'committed' ? 'retryable: tail incomplete' : null,
      createdAt: 1,
      updatedAt: 1,
    })
  }
  async function packageJournal(state: 'prepared' | 'committed', storedReceipt?: object) {
    const { resourceBundleApplies } = tablesOf(harness.db)
    await insertOne(harness.db, resourceBundleApplies, {
      id: 'package-journal',
      scope: 'package',
      key: 'a6-import',
      actorUserId: actor.user.id,
      state,
      preparedArtifactsJson: '[]',
      receiptJson: storedReceipt === undefined ? null : JSON.stringify(storedReceipt),
      createdAt: 1,
      updatedAt: 1,
    })
  }

  test('Intent compares the persisted draft hash before replay and rejects different-payload replay (RFC-395 II-a A6 deliberate change)', async () => {
    await intentJournal('[]')
    const engine = createIntentApplyEngine({
      db: harness.db,
      resources: {
        createSession() {
          throw new Error('replay must not prepare resources')
        },
      },
      artifacts: {
        async compensate() {},
        async rollForward() {
          return true
        },
      },
    })
    const command = {
      sessionId: 'a6-session',
      clientMutationId: 'a6-mutation',
      draftRevision: 1,
      draftHash: 'hash-a',
      decisions: [],
    }
    await expect(engine.apply({ actor, authority, command })).resolves.toEqual(receipt)
    await expect(
      engine.apply({ actor, authority, command: { ...command, draftHash: 'hash-b' } }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'intent-draft-hash-mismatch',
      message: 'confirmed draft hash does not match',
    })
    const { intentApplyJournal } = tablesOf(harness.db)
    expect(await first(harness.db.select().from(intentApplyJournal))).toMatchObject({
      state: 'committed',
      draftHash: 'hash-a',
    })
  })

  test('package replay preserves current receipts before token expiry checks; decisions have no stored identity in II-a', async () => {
    await packageJournal('committed', {
      journalId: 'package-journal',
      applied: [
        {
          operationId: 'old-op',
          resourceType: 'mcp' as const,
          resourceId: 'old-mcp',
          name: 'tools',
          action: 'create' as const,
        },
      ],
    })
    const box = createSecretBoxFromKey(randomBytes(32))
    const pkg: ParsedPackage = {
      manifest: PackageManifestSchema.parse({
        formatVersion: 1,
        exportedAt: 0,
        root: { slug: 'tools', type: 'mcp', name: 'tools' },
        resources: [{ slug: 'tools', type: 'mcp', name: 'tools' }],
        requirements: {},
        secrets: [],
      }),
      bundle: BundleSchema.parse({
        bundleVersion: 1,
        rootRef: 'local:tools',
        ops: [
          {
            opId: 'op-1',
            kind: 'mcp-create',
            slug: 'tools',
            payload: {
              name: 'tools',
              description: '',
              type: 'remote',
              config: { url: 'https://pkg.test/mcp' },
              enabled: true,
            },
          },
        ],
      }),
      files: new Map(),
      digest: 'same-preview-digest',
    }
    const previewToken = signPreviewToken(box, {
      importId: 'a6-import',
      actorUserId: actor.user.id,
      packageDigest: pkg.digest,
      expiresAt: 1,
      baseline: [],
      humanBaseline: [],
    })
    const engine = createResourcePackageAtomicApplyOperations({
      db: harness.db,
      box,
      now: () => 100,
    })
    const request = {
      actor,
      authority,
      package: pkg,
      previewToken,
      decisions: [],
      humanMemberMappings: [],
      secretInputs: [],
      mutationSessionFactory: {
        create() {
          throw new Error('replay must not create mutation session')
        },
      },
    }
    const expected = {
      journalId: 'package-journal',
      applied: [
        {
          operationId: 'old-op',
          resourceType: 'mcp' as const,
          resourceId: 'old-mcp',
          name: 'tools',
          action: 'create' as const,
        },
      ],
    }
    await expect(engine.apply(request)).resolves.toEqual(expected)
    // 缺少原请求 digest，不能把改变 decisions 的重放伪装成已拒绝；II-b 需要 request identity。
    await expect(
      engine.apply({ ...request, decisions: [{ localSlug: 'tools', action: 'new' }] }),
    ).resolves.toEqual(expected)
  })

  test('one registered recovery entry drives both journals and preserves per-scene active snapshots', async () => {
    await intentJournal('[]', 'prepared')
    await packageJournal('prepared')
    const calls: string[] = []
    const recovery = createAtomicApplyRecovery(
      [
        createIntentApplyRecoveryScene({
          db: harness.db,
          log,
          artifacts: {
            async compensate() {
              calls.push('intent')
            },
            async rollForward() {
              return true
            },
          },
        }),
        createResourcePackageRecoveryScene({
          journal: createResourcePackageApplyJournalPort(harness.db),
          artifacts: {
            async compensate() {
              calls.push('package')
            },
            async rollForward() {},
          },
        }),
      ],
      () => 1_000_000,
    )
    expect(
      await recovery.converge({ intent: [receipt.journalId], 'resource-package': [] }),
    ).toEqual({ failed: 1, rolledForward: 0 })
    expect(calls).toEqual(['package'])
    const { intentApplyJournal, resourceBundleApplies } = tablesOf(harness.db)
    expect((await first(harness.db.select().from(intentApplyJournal)))?.state).toBe('prepared')
    expect((await first(harness.db.select().from(resourceBundleApplies)))?.state).toBe('failed')
    expect(await recovery.converge({ intent: [], 'resource-package': [] })).toEqual({
      failed: 1,
      rolledForward: 0,
    })
  })

  test('committed Intent artifacts for deleted skills/plugins complete without endlessly retrying publication', async () => {
    await intentJournal(
      intentApplyArtifactCodecs.encode([
        {
          kind: 'skill-stage',
          skillId: 'deleted-skill',
          operationId: 'skill-op',
          stagingDirectory: '/staged',
        },
        {
          kind: 'plugin-install',
          pluginId: 'deleted-plugin',
          generationId: 'gen',
          generationDir: '/gen',
        },
      ]),
    )
    const discarded: string[] = []
    const artifacts = createIntentApplyArtifactLifecycle({
      db: harness.db,
      appHome: '/unused',
      pluginsDir: '/unused/plugins',
      content: {
        pluginExists() {
          throw new Error('deleted plugin has no current publication')
        },
        discardPlugin() {},
        discardLegacy() {},
        publishSkill() {
          throw new Error('deleted skill must not be republished')
        },
        discardSkill({ artifact }) {
          discarded.push(artifact.skillId)
        },
      },
    })
    const recovery = createAtomicApplyRecovery([
      createIntentApplyRecoveryScene({ db: harness.db, artifacts, log }),
    ])
    expect(await recovery.converge({ intent: [] })).toEqual({ failed: 0, rolledForward: 1 })
    expect(discarded).toEqual(['deleted-skill'])
    const { intentApplyJournal } = tablesOf(harness.db)
    expect(
      await first(
        harness.db
          .select()
          .from(intentApplyJournal)
          .where(eq(intentApplyJournal.id, receipt.journalId)),
      ),
    ).toMatchObject({ state: 'committed', error: null })
  })

  test('a package recovery error is persisted, and a later successful tail clears it', async () => {
    await packageJournal('committed', { journalId: 'package-journal', applied: [] })
    let fail = true
    const recovery = createAtomicApplyRecovery([
      createResourcePackageRecoveryScene({
        journal: createResourcePackageApplyJournalPort(harness.db),
        artifacts: {
          async compensate() {},
          async rollForward() {
            if (fail) throw new Error('offline artifact storage')
          },
        },
      }),
    ])
    expect(await recovery.converge({ 'resource-package': [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    const { resourceBundleApplies } = tablesOf(harness.db)
    expect((await first(harness.db.select().from(resourceBundleApplies)))?.error).toBe(
      'retryable: committed roll-forward incomplete: offline artifact storage',
    )
    fail = false
    expect(await recovery.converge({ 'resource-package': [] })).toEqual({
      failed: 0,
      rolledForward: 1,
    })
    expect((await first(harness.db.select().from(resourceBundleApplies)))?.error).toBeNull()
  })
  test.each(['decode', 'database'] as const)(
    'recovery classifies %s failures explicitly and keeps bare log messages',
    async (kind) => {
      await intentJournal(kind === 'decode' ? '{' : '[]')
      const warnings: Array<{ message: string; fields: unknown }> = []
      const logger: Logger = {
        ...log,
        warn: (message, fields) => {
          warnings.push({ message, fields })
        },
      }
      const databaseError = new Error('database unavailable', {
        cause: new Error('connection closed'),
      })
      const recovery = createAtomicApplyRecovery([
        createIntentApplyRecoveryScene({
          db: harness.db,
          log: logger,
          artifacts: {
            compensate: async () => undefined,
            rollForward: async () => {
              throw databaseError
            },
          },
        }),
      ])
      expect(await recovery.converge({ intent: [] })).toEqual({ failed: 0, rolledForward: 0 })
      expect(warnings).toEqual([
        {
          message:
            kind === 'decode'
              ? 'intent-journal-artifact-corrupt'
              : 'intent-apply-artifact-roll-forward-retryable',
          fields: {
            journalId: receipt.journalId,
            state: 'committed',
            err:
              kind === 'decode'
                ? 'intent apply journal artifacts are not valid JSON'
                : databaseError.message,
          },
        },
      ])
      const { intentApplyJournal } = tablesOf(harness.db)
      expect((await first(harness.db.select().from(intentApplyJournal)))?.error).toBe(
        kind === 'decode'
          ? 'retryable: artifact decode failed: intent apply journal artifacts are not valid JSON'
          : 'retryable: committed roll-forward incomplete; inspect intent apply logs',
      )
    },
  )
})
