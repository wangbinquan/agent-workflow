import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { tablesOf } from '@/platform/persistence/sessionTables'
// RFC-395 II-pre：hosted 工件恢复改接生产 journal convergence，保留远端内容断言。
// Real Intent resource commits, durable recovery and the worker envelope share
// selected content owners. Neither provider is allowed to touch a local root.
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { insertOne } from '@/platform/persistence/singleInsert'

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { INTENT_CHANGESET_SCHEMA_VERSION } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeIntentApplyRecoveryScene } from '@/modules/intent/composition/applyMaintenance'
import {
  composeCrewStationIntentArtifacts,
  composeCrewStationIntentPluginRetention,
} from '@/modules/intent/composition/crewstationArtifacts'
import { composeCrewStationResourceArtifacts } from '@/modules/resource-catalog/composition/crewstationArtifacts'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { LIVE_TREE, readTree } from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import {
  composeCrewStationWorkerFence,
  crewStationDatabaseConfig,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { composeCrewStationMaintenanceDescriptor } from '@/bootstrap/crewstationMaintenance'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createMaintenanceWorkerEffectsInit } from '@/platform/background/maintenanceWorkerEffectsProtocol'
import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PROTOCOL_VERSION } from '@/platform/background/maintenanceProtocol'
import { openMaintenanceWorkerEffectsScope } from '@/bootstrap/maintenanceWorkerEffects'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

describeEachProvider('RFC-370 hosted resource production families', (harness) => {
  test('real skill and plugin Intent commits recover after authority loss using fresh content owners', async () => {
    const actor = buildActor({
      user: {
        id: 'owner',
        username: 'owner',
        displayName: 'Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const { users, intentSessions, intentDrafts, plugins } = tablesOf(harness.db)
    const { skills, intentApplyJournal } = tablesOf(harness.db)
    await insertOne(harness.db, users, { ...actor.user, createdAt: 1, updatedAt: 1 })
    const authority = composeIdentityAccess(harness.db).contexts.fromAuthenticatedPrincipal(
      { userId: actor.user.id, source: 'session' },
      'http',
    ).authority
    const f = objectFixture()
    const bytes = Buffer.from('export default {}')
    let held = true
    const helper: WorkspaceHelper = {
      async call<T>(_task: string, _operation: string, value: unknown) {
        const request = value as { method: string; pluginId: string; generationId: string }
        return (
          request.method === 'discard'
            ? null
            : {
                sourceKind: 'npm',
                resolvedVersion: '1.0.0',
                sourceIdentity: 'npm:fixture',
                root: `/work/plugins/${request.pluginId}/generations/${request.generationId}`,
                entry: 'index.js',
                files: [
                  {
                    kind: 'file',
                    path: 'index.js',
                    sha256: sha256Hex(bytes),
                    size: bytes.length,
                    mode: 0o644,
                  },
                ],
              }
        ) as T
      },
    }
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => {
        if (!held) throw new Error('lease expired')
      },
    }
    const create = () =>
      composeCrewStationResourceArtifacts({
        db: harness.db,
        helper,
        objects: f.objects,
        publications: createHostedObjectPublications({ db: harness.db, fence, objects: f.objects })
          .publications,
        fence,
        reference: (_task, path) => path,
        openFile: async () => new Response(bytes).body!,
        retainedReferences: composeCrewStationIntentPluginRetention(harness.db),
      })
    const sessionId = ulid(),
      draftId = ulid()
    const changesetJson = JSON.stringify({
      $schema_version: INTENT_CHANGESET_SCHEMA_VERSION,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'skill',
          tempRef: '$new:skill',
          payload: {
            name: 'hosted-skill',
            description: '',
            bodyMd: 'Run the durable helper',
            files: [{ path: 'helper.txt', content: 'persisted' }],
          },
        },
        {
          opId: 'op-2',
          action: 'create',
          resourceType: 'plugin',
          tempRef: '$new:plugin',
          payload: { name: 'hosted-plugin', spec: 'fixture@1', description: '' },
        },
      ],
    })
    const draftHash = `sha256:${sha256Hex(changesetJson)}`
    await insertOne(harness.db, intentSessions, {
      id: sessionId,
      ownerUserId: actor.user.id,
      title: 'Hosted resources',
      createdAt: 1,
      updatedAt: 1,
    })
    await insertOne(harness.db, intentDrafts, {
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: 1,
    })
    await harness.db
      .update(intentSessions)
      .set({ currentDraftId: draftId })
      .where(eq(intentSessions.id, sessionId))
    const first = composeIntentApplyOperations({
      db: harness.db,
      appHome: 'must-not-access-local-content',
      ...composeCrewStationIntentArtifacts(create().intent),
    })
    await expect(
      first.apply({
        actor,
        authority,
        command: {
          sessionId,
          clientMutationId: ulid(),
          draftRevision: 1,
          draftHash,
          decisions: [],
        },
        faults: {
          afterTxBeforeRollForward() {
            held = false
            throw new Error('interrupted after metadata commit')
          },
        },
      }),
    ).rejects.toThrow('interrupted after metadata commit')
    const skill = (await harness.db.select().from(skills))[0]!
    const plugin = (await harness.db.select().from(plugins))[0]!
    expect(skill.name).toBe('hosted-skill')
    expect(plugin.cachedPath).toMatch(/^cs-plugin:/)
    expect(await readTree(harness.db, skill.id, LIVE_TREE)).toHaveLength(0)
    expect((await harness.db.select().from(intentApplyJournal))[0]!.state).toBe('committed')
    held = true
    const cold = create()
    const convergence = createAtomicApplyRecovery([
      composeIntentApplyRecoveryScene({
        db: harness.db,
        appHome: 'must-not-access-local-content',
        pluginsDir: 'must-not-access-local-plugins',
        content: composeCrewStationIntentArtifacts(cold.intent).artifactContent,
      }),
    ])
    await convergence.converge({ intent: [] })
    expect(
      (await readTree(harness.db, skill.id, LIVE_TREE)).some(
        (file) => file.path === 'helper.txt' && Buffer.from(file.bytes).toString() === 'persisted',
      ),
    ).toBe(true)
    expect((await cold.generations.read(plugin.cachedPath)).requestedSpec).toBe('fixture@1')
    expect(await composeCrewStationIntentPluginRetention(harness.db)()).toEqual([])
    // A committed receipt cannot authorize another plugin's generation.
    await expect(
      cold.maintenance.resourcePackageRecovery.rollForward({
        id: 'journal',
        state: 'committed',
        updatedAt: 1,
        preparedArtifactsJson: resourcePackageArtifactCodecs.encode([
          {
            kind: 'plugin-install',
            operationId: 'op-1',
            pluginId: plugin.id,
            generationId: 'other',
            generationDirectory: 'cs-plugin:foreign/other',
          },
        ]),
        receiptJson: JSON.stringify({
          journalId: 'journal',
          applied: [
            {
              operationId: 'op-1',
              resourceType: 'plugin',
              resourceId: plugin.id,
              action: 'create',
              name: plugin.name,
            },
          ],
        }),
      }),
    ).rejects.toThrow('reference-mismatch')
  })

  test('worker borrows one frozen lease and cannot adopt a later main owner', async () => {
    const lease = { epoch: 7, leaseId: 'lease-seven', instanceId: 'owner-seven' }
    const fence = composeCrewStationWorkerFence(harness.db, lease)
    const { hostedExecutionControl } = tablesOf(harness.db)
    await insertOne(harness.db, hostedExecutionControl, {
      id: 'global',
      epoch: 7,
      leaseId: lease.leaseId,
      owner: lease.instanceId,
      phase: 'active',
      expiresAt: Date.now() + 60_000,
      updatedAt: 1,
    })
    await databaseSessionFor(harness.db).transaction((tx) => fence.assertHeld(tx, fence.current()))
    await harness.db
      .update(hostedExecutionControl)
      .set({ epoch: 8, leaseId: 'lease-eight', owner: 'owner-eight' })
      .where(eq(hostedExecutionControl.id, 'global'))
    expect(fence.current()).toEqual(lease)
    await expect(
      databaseSessionFor(harness.db).transaction((tx) => fence.assertHeld(tx, fence.current())),
    ).rejects.toThrow('epoch changed')
  })
})

test('worker serialization snapshots the spawn-time fence and validates the complete Intent recovery family', async () => {
  let epoch = 1
  const descriptor = composeCrewStationMaintenanceDescriptor({
    database: crewStationDatabaseConfig(),
    generationId: 'generation',
    fence: {
      current: () => ({ epoch, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => undefined,
    },
  })
  const init = {
    type: 'init' as const,
    version: MAINTENANCE_PROTOCOL_VERSION,
    catalogDigest: MAINTENANCE_CATALOG_DIGEST,
    appHome: '/unused',
    dbPath: '/unused/db',
    migrationsFolder: '/unused/migrations',
    sqlite: { synchronous: 'NORMAL' as const, pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
  }
  epoch = 2
  const envelope = createMaintenanceWorkerEffectsInit(init, descriptor)
  epoch = 3
  expect(JSON.parse(envelope.effects.configurationJson).fence.epoch).toBe(2)
  expect(envelope.effects.capabilities).toContain('intentArtifactContent')
  // RFC-370 v3 V6: one hosted object job replaces per-owner publication recovery.
  expect(envelope.effects.capabilities).toContain('objectPublications')
  expect(envelope.effects.capabilities).not.toContain('developmentArtifacts')
  expect(envelope.effects.capabilities).not.toContain('employeeArtifacts')
  const content = {
    pluginExists: async () => true,
    discardPlugin: async () => {},
    publishSkill: async () => {},
    discardSkill: async () => {},
    discardLegacy: async () => {},
  }
  let disposed = false
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: { ...envelope.effects, capabilities: ['intentArtifactContent'] },
    context: { appHome: '/unused', instanceRef: 'worker' },
    importModule: async () => ({
      createCrewStationMaintenanceEffects: () => ({
        intentArtifactContent: content,
        dispose: () => {
          disposed = true
        },
      }),
    }),
  })
  expect((await scope.ready).intentArtifactContent).toBe(content)
  await scope.dispose()
  expect(disposed).toBe(true)
})
