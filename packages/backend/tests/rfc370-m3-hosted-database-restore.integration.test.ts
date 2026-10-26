import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTarGz } from '@/util/archive'
import {
  captureEpochMetadata,
  verifyEpochMetadataSnapshot,
} from '@/platform/persistence/schema/history/metadataSnapshot'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { readContentObject, hostedObjectOf } from '@/platform/content/infrastructure/contentStore'
// RFC-370 v3 V5 — real PostgreSQL path: born-hosted install -> one-object
// standalone-format backup -> refused non-empty target -> empty target ->
// interrupted verified copy -> resumed restore with owner normalization ->
// release migrate -> CS RFC-042 verify receipt. Uses only the CI test
// database, never the local CrewStation deployment.
import {
  readTaskFixtures,
  readWorkflowFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { migrateForDeployment } from '@/bootstrap/deployment'
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
  restoredDatabaseDigests,
} from '@/modules/system-operations/infrastructure/crewstation/databaseRestoreVerification'
import {
  createHostedObjectPublications,
  hostedPublicationId,
} from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedRestoreTaskNormalization } from '@/modules/task-execution/public/participants'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

const TASK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

if (resolveTestProviders(process.env).includes('postgresql')) {
  test('a one-object backup restores through the standalone import with owner normalization and verifies', async () => {
    const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
    if (!urlEnv || !process.env[urlEnv]) throw new Error('real PostgreSQL URL required')
    const environment = { project: 'rfc370-backup', service: 'aw' }
    const env = {
      AW_DEPLOYMENT_MODE: 'crewstation',
      CS_PROJECT: environment.project,
      CS_SERVICE: environment.service,
      CS_DATABASE_URL: process.env[urlEnv]!,
    }
    const contract = logicalSchemaContract,
      plan = buildPostgresqlSchemaPlan(logicalSchemaContract)
    const restoreEnv = {
      ...env,
      CS_DATABASE_GENERATION_ID: '01a13e6d-3e00-7000-9e3c-000000000011',
      CS_DATABASE_GENERATION_OPERATION: '01a13e6d-3e00-7000-9e3c-000000000012',
    }
    const generation = hostedDatabaseGeneration({
      ...environment,
      schemaDigest: contract.digest,
      env: restoreEnv,
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
      const serving = await prepareCrewStationDatabase({
        contract: logicalSchemaContract,
        environment,
        schema: 'verify',
        env,
      })
      let reference: string
      try {
        const db = serving.openBootstrapClient()
        const { hostedExecutionControl, hostedExecutionBindings } = tablesOf(db)
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
        await workflowFixture(db, {
          id: 'retained-workflow',
          name: 'From snapshot',
          // The backup exports workflows through the strict portable codec.
          definition: JSON.stringify({ $schema_version: 7, inputs: [], nodes: [], edges: [] }),
        })
        await taskFixture(db, {
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
        await insertOne(db, hostedExecutionBindings, {
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
          contract: logicalSchemaContract,
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
        const archiveRoot = mkdtempSync(join(tmpdir(), 'mc-hosted-metadata-'))
        try {
          const stored = fixture.stored.get(parseHostedBackupReference(reference).id)!
          const path = join(archiveRoot, 'backup.tar.gz')
          writeFileSync(path, stored.bytes)
          const unpacked = join(archiveRoot, 'unpacked')
          mkdirSync(unpacked)
          await extractTarGz(path, unpacked)
          const metadata = verifyEpochMetadataSnapshot(
            JSON.parse(
              readFileSync(join(unpacked, 'database', 'logical', 'epoch2-metadata.json'), 'utf8'),
            ),
          )
          const generations = metadata.payload.tables.find(
            (table) => table.name === 'generations',
          )!.rows
          expect(generations).toContainEqual(
            expect.objectContaining({
              generation_id: serving.runtime.runtime.generationId,
              role: 'installed',
              state: 'active',
            }),
          )
          expect(metadata.payload.tables.map((table) => table.name)).toContain(
            'migration_history_restrictions',
          )
          expect(metadata.payload.tables.map((table) => table.name)).not.toContain('first_write')
        } finally {
          rmSync(archiveRoot, { recursive: true, force: true })
        }

        // One archive object is the whole backup: nothing else was pinned.
        expect(fixture.pins).toHaveLength(1)
        const catalog = await backup.backup.catalog!.list()
        expect(catalog.backups).toHaveLength(1)
        expect((await backup.backup.catalog!.verify(catalog.backups[0]!.id)).reference).toBe(
          reference,
        )
        let targetOpens = 0
        const attempt = (override: Partial<typeof identity> = {}) =>
          restoreHostedDatabaseInstallation({
            headContract: logicalSchemaContract,
            ...identity,
            ...override,
            runtime,
            reference,
            contract,
            plan,
            generation: {
              generationId: generation.generationId,
              operationId: generation.operationId!,
            },
            objects: fixture.objects,
            normalization: [createHostedRestoreTaskNormalization()],
            async openTarget(options) {
              targetOpens += 1
              return await openPostgresqlLogicalTarget(options)
            },
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
        const beforeMetadata = await captureEpochMetadata(
          postgresqlHistoryConnection(runtime.providerPool()),
        )
        const beforeRows = await restoredDatabaseDigests(runtime.providerPool(), contract)
        await expect(attempt()).rejects.toThrow('hosted-restore-target-not-empty')
        expect(targetOpens).toBe(0)
        expect(
          await captureEpochMetadata(postgresqlHistoryConnection(runtime.providerPool())),
        ).toEqual(beforeMetadata)
        expect(await restoredDatabaseDigests(runtime.providerPool(), contract)).toEqual(beforeRows)
      } finally {
        await serving.runtime.close()
      }
      await emptyTarget()
      const input = {
        headContract: logicalSchemaContract,
        ...identity,
        runtime,
        reference: reference!,
        contract,
        plan,
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
              async finalizeSchema(now, tables) {
                await target.finalizeSchema(now, tables)
                throw new Error('process ended after schema verification')
              },
            }
          },
        }),
      ).rejects.toThrow('after schema verification')
      await expect(
        restoreHostedDatabaseInstallation({
          ...input,
          async openTarget(options) {
            const target = await openPostgresqlLogicalTarget(options)
            return {
              ...target,
              async activateGeneration(id, now) {
                await target.activateGeneration(id, now)
                throw new Error('process ended after generation activation')
              },
            }
          },
        }),
      ).rejects.toThrow('after generation activation')
      const activatedMetadata = await captureEpochMetadata(
        postgresqlHistoryConnection(runtime.providerPool()),
      )
      for (const wrongGeneration of [
        { ...input.generation, generationId: 'dbg_other_restore_generation' },
        { ...input.generation, operationId: 'dbm_other_restore_operation' },
      ]) {
        let opened = false
        await expect(
          restoreHostedDatabaseInstallation({
            ...input,
            generation: wrongGeneration,
            async openTarget(options) {
              opened = true
              return await openPostgresqlLogicalTarget(options)
            },
          }),
        ).rejects.toThrow('hosted-restore-target-not-empty')
        expect(opened).toBe(false)
        expect(
          await captureEpochMetadata(postgresqlHistoryConnection(runtime.providerPool())),
        ).toEqual(activatedMetadata)
      }
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
      await migrateForDeployment(restoreEnv)
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
      const restored = await prepareCrewStationDatabase({
        contract: logicalSchemaContract,
        environment,
        schema: 'verify',
        env: restoreEnv,
      })
      try {
        const db = restored.openBootstrapClient()
        const { hostedExecutionControl, hostedExecutionBindings, hostedDatabaseBackups } =
          tablesOf(db)
        const { contentPublications } = tablesOf(db)
        expect((await db.select().from(hostedExecutionControl))[0]!).toMatchObject({
          phase: 'frozen',
          expiresAt: 0,
        })
        expect((await readWorkflowFixtures(db, { id: 'retained-workflow' }))[0]!.name).toBe(
          'From snapshot',
        )
        expect((await readTaskFixtures(db, { id: TASK }))[0]).toMatchObject({
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
        const [publication] = await db
          .select()
          .from(contentPublications)
          .where(eq(contentPublications.id, hostedPublicationId(HOSTED_BACKUP_OWNER, rootId!)))
        expect(publication).toMatchObject({ state: 'ready', attempt: rootId })
        expect(hostedObjectOf((await readContentObject(db, publication!.contentId!))!)).toEqual(
          object,
        )
      } finally {
        await restored.runtime.close()
      }
    } finally {
      {
        await runtime.close()
      }
    }
  }, 300_000)
}
