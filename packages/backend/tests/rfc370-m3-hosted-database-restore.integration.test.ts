// RFC-370 v3 V5 — real PostgreSQL path: born-hosted install -> one-object
// standalone-format backup -> refused non-empty target -> empty target ->
// interrupted verified copy -> resumed restore with owner normalization ->
// release migrate -> CS RFC-042 verify receipt. Uses only the CI test
// database, never the local CrewStation deployment.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { migrateForDeployment } from '@/bootstrap/deployment'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  hostedDatabaseBackups,
  hostedExecutionBindings,
  hostedExecutionControl,
  hostedObjectPublications,
  tasks,
  workflows,
} from '@/db/schema'
import { composeCrewStationDatabaseBackups } from '@/modules/system-operations/composition/crewstationDatabaseBackups'
import {
  composeCrewStationWorkerFence,
  prepareCrewStationDatabase,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { createDatabaseApplicationConfiguration } from '@/modules/system-operations/infrastructure/databaseApplicationConfiguration'
import {
  HOSTED_BACKUP_OWNER,
  parseHostedBackupReference,
} from '@/modules/system-operations/infrastructure/crewstation/databaseBackupFormat'
import { readHostedDatabaseBackupProvenance } from '@/modules/system-operations/infrastructure/crewstation/databaseBackupProvenance'
import { restoreHostedDatabaseInstallation } from '@/modules/system-operations/infrastructure/crewstation/databaseRestoreInstallation'
import {
  verifyHostedDatabaseRestore,
  verifyRestoredDatabaseDigests,
} from '@/modules/system-operations/infrastructure/crewstation/databaseRestoreVerification'
import {
  createHostedObjectPublications,
  hostedPublicationId,
} from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedRestoreTaskNormalization } from '@/modules/task-execution/public/participants'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

const TASK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

if (resolveTestProviders(process.env).includes('postgresql')) {
  test('a one-object backup restores through the standalone import with owner normalization and verifies', async () => {
    const previousSchemaProvider = currentDatabaseSchemaProvider()
    const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
    if (!urlEnv || !process.env[urlEnv]) throw new Error('real PostgreSQL URL required')
    const environment = { project: 'rfc370-backup', service: 'aw' }
    const env = {
      AW_DEPLOYMENT_MODE: 'crewstation',
      CS_PROJECT: environment.project,
      CS_SERVICE: environment.service,
      CS_DATABASE_URL: process.env[urlEnv]!,
    }
    const contract = buildLogicalSchemaContract(),
      history = await loadPostgresqlMigrationHistory()
    const generation = hostedDatabaseGeneration({
      ...environment,
      schemaDigest: contract.digest,
    }).payload
    const runtime = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv, poolMax: 2 }),
      generationId: generation.generationId,
    })
    const emptyTarget = async () => {
      await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
      await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
    }
    const fixture = objectFixture(),
      secretKey = Buffer.alloc(32, 1)
    const objectSpaceId = '01a13e6d-3e00-7000-9e3c-000000000001'
    const installation = `${environment.project}/${environment.service}`
    const identity = {
      installation,
      objectSpaceId,
      keyFingerprint: createHash('sha256').update(secretKey).digest('hex'),
    }
    try {
      await emptyTarget()
      await migrateForDeployment(env)
      const serving = await prepareCrewStationDatabase({ environment, schema: 'verify', env })
      let reference: string
      try {
        const db = serving.openBootstrapClient()
        await db
          .insert(hostedExecutionControl)
          .values({
            id: 'global',
            epoch: 1,
            owner: 'owner',
            phase: 'active',
            leaseId: 'lease',
            expiresAt: Date.now() + 600_000,
            updatedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: hostedExecutionControl.id,
            set: {
              epoch: 1,
              owner: 'owner',
              phase: 'active',
              leaseId: 'lease',
              expiresAt: Date.now() + 600_000,
            },
          })
        await db.insert(workflows).values({
          id: 'retained-workflow',
          name: 'From snapshot',
          // The backup exports workflows through the strict portable codec.
          definition: JSON.stringify({ $schema_version: 7, inputs: [], nodes: [], edges: [] }),
        })
        await db.insert(tasks).values({
          id: TASK,
          name: 'Restored task',
          workflowId: 'retained-workflow',
          workflowSnapshot: '{}',
          repoPath: 'cs-workspace:parent/repos/main',
          worktreePath: 'cs-workspace:parent/workspace',
          baseBranch: 'main',
          branch: 'work',
          status: 'running',
          inputs: '{}',
          startedAt: 1,
        })
        await db.insert(hostedExecutionBindings).values({
          executionId: 'old-execution',
          taskId: TASK,
          kind: 'command',
          businessTaskId: 'old-parent',
          requestKey: 'old-request',
          requestJson: '{}',
          state: 'submitting',
          epoch: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        await createDatabaseApplicationConfiguration({
          db,
          managed: { database: serving.databaseConfig },
        }).applyPatch({ language: 'en-US' })
        const fence = composeCrewStationWorkerFence(db, {
          epoch: 1,
          leaseId: 'lease',
          instanceId: 'owner',
        })
        const backup = composeCrewStationDatabaseBackups({
          db,
          runtime: serving.runtime.runtime,
          fence,
          objects: fixture.objects,
          publications: createHostedObjectPublications({ db, fence, objects: fixture.objects })
            .publications,
          installation,
          objectSpaceId,
          secretKey,
        })
        await expect(backup.backup.request({ includeWorktrees: true })).rejects.toMatchObject({
          code: 'hosted-backup-worktrees-unsupported',
        })
        reference = (await backup.backup.request({ includeWorktrees: false })).path
        // One archive object is the whole backup: nothing else was pinned.
        expect(fixture.pins).toHaveLength(1)
        const catalog = await backup.backup.catalog!.list()
        expect(catalog.backups).toHaveLength(1)
        expect((await backup.backup.catalog!.verify(catalog.backups[0]!.id)).reference).toBe(
          reference,
        )
        const attempt = (override: Partial<typeof identity> = {}) =>
          restoreHostedDatabaseInstallation({
            ...identity,
            ...override,
            runtime,
            reference,
            contract,
            plan: history.head.plan,
            generation: {
              generationId: generation.generationId,
              operationId: generation.operationId!,
            },
            objects: fixture.objects,
            normalization: [createHostedRestoreTaskNormalization()],
          })
        // The archive is verified before any target inspection or write.
        await expect(attempt({ keyFingerprint: 'e'.repeat(64) })).rejects.toThrow(
          'hosted-restore-encryption-key-mismatch',
        )
        await expect(attempt({ installation: 'other/service' })).rejects.toThrow(
          'hosted-restore-installation-mismatch',
        )
        fixture.tamper('body')
        await expect(attempt()).rejects.toThrow('download-content-mismatch')
        fixture.tamper(undefined)
        await expect(attempt()).rejects.toThrow('target-not-empty')
      } finally {
        await serving.runtime.close()
      }
      await emptyTarget()
      const input = {
        ...identity,
        runtime,
        reference: reference!,
        contract,
        plan: history.head.plan,
        generation: { generationId: generation.generationId, operationId: generation.operationId! },
        objects: fixture.objects,
        normalization: [createHostedRestoreTaskNormalization()],
      }
      await expect(
        restoreHostedDatabaseInstallation({
          ...input,
          async openTarget(options) {
            const target = await openPostgresqlLogicalTarget(options)
            return {
              ...target,
              async close() {
                await target.close()
                throw new Error('process ended after schema verification')
              },
            }
          },
        }),
      ).rejects.toThrow('after schema verification')
      expect(await restoreHostedDatabaseInstallation(input)).toMatchObject({
        restored: true,
        normalized: {
          'system-operations.adoptedBackups': 1,
          'task-execution.interruptedTasks': 1,
          'task-execution.cancelledBindings': 1,
        },
      })
      expect(await restoreHostedDatabaseInstallation(input)).toMatchObject({ restored: false })
      // The release Job continues with the ordinary migrate of the same generation.
      await migrateForDeployment(env)
      expect(
        await verifyHostedDatabaseRestore({
          runtime,
          reference: reference!,
          contract,
          generation: {
            generationId: generation.generationId,
            operationId: generation.operationId!,
          },
        }),
      ).toEqual({
        version: 1,
        backupReferenceDigest: createHash('sha256').update(reference!).digest('hex'),
        schemaDigest: contract.digest,
        complete: true,
        autoResumeSuspended: true,
      })
      const verifiedConnection = await runtime.providerPool().reserve()
      try {
        await verifiedConnection.unsafe('BEGIN')
        await verifiedConnection.unsafe(
          "UPDATE agent_workflow.workflows SET name='unexpected write' WHERE id='retained-workflow'",
        )
        await expect(
          verifyRestoredDatabaseDigests(verifiedConnection, contract, generation.operationId!),
        ).rejects.toThrow('finalized-content-changed')
        await verifiedConnection.unsafe('ROLLBACK')
      } finally {
        verifiedConnection.release()
      }
      const restored = await prepareCrewStationDatabase({ environment, schema: 'verify', env })
      try {
        const db = restored.openBootstrapClient()
        expect((await db.select().from(hostedExecutionControl))[0]!).toMatchObject({
          phase: 'frozen',
          expiresAt: 0,
        })
        expect(
          (await db.select().from(workflows).where(eq(workflows.id, 'retained-workflow')))[0]!.name,
        ).toBe('From snapshot')
        expect((await db.select().from(tasks).where(eq(tasks.id, TASK)))[0]).toMatchObject({
          status: 'interrupted',
          autoRecoverySuspended: true,
        })
        expect((await db.select().from(hostedExecutionBindings))[0]).toMatchObject({
          cancelRequested: true,
          cancelReason: 'restored',
        })
        expect(
          (
            await createDatabaseApplicationConfiguration({
              db,
              managed: { database: restored.databaseConfig },
            }).load()
          ).language,
        ).toBe('en-US')
        const [rootId] = await readHostedDatabaseBackupProvenance(
          restored.runtime.runtime,
          contract,
        )
        const object = parseHostedBackupReference(reference!)
        expect(
          (
            await db
              .select()
              .from(hostedDatabaseBackups)
              .where(eq(hostedDatabaseBackups.id, rootId!))
          )[0],
        ).toMatchObject({
          state: 'ready',
          activeSlot: null,
          objectId: object.id,
          sha256: object.sha256,
        })
        expect(
          (
            await db
              .select()
              .from(hostedObjectPublications)
              .where(
                eq(hostedObjectPublications.id, hostedPublicationId(HOSTED_BACKUP_OWNER, rootId!)),
              )
          )[0],
        ).toMatchObject({ state: 'ready', attempt: rootId, objectId: object.id })
      } finally {
        await restored.runtime.close()
      }
    } finally {
      try {
        await runtime.close()
      } finally {
        selectDatabaseSchemaProvider(previousSchemaProvider)
      }
    }
  }, 300_000)
}
