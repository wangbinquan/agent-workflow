// Uses the shared provider selection and a disposable PostgreSQL test database.
// RFC349_DATABASE_URL remains supported for an explicit standalone evidence run. This covers the production coordinator used by CLI/Settings,
// including durable config activation, idempotent replay and instant rollback.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { DatabaseConfig } from '@agent-workflow/shared'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { createDatabaseMigrationCoordinator } from '@/modules/system-operations/infrastructure/databaseMigrationCoordinator'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const realTest = resolveTestProviders(process.env).includes('postgresql') ? test : test.skip

describe('RFC-349 production database migration coordinator', () => {
  test('missing target environment is an actionable validation error instead of HTTP 500', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-coordinator-preflight-env-'))
    roots.push(root)
    const sqlitePath = join(root, 'db.sqlite')
    const drizzle = createInMemoryDb(MIGRATIONS)
    const sqlite = (drizzle as unknown as { $client: Database }).$client
    writeFileSync(sqlitePath, sqlite.serialize())
    sqlite.close()

    const coordinator = createDatabaseMigrationCoordinator({
      sqlitePath,
      operationsRoot: join(root, 'database-migrations'),
      generationPointerPath: join(root, 'database-generation.json'),
      env: {},
      admission: {
        async freezeAndDrain() {},
        async reopenSqlite() {},
        async activatePostgresql() {},
        async openPostgresqlAdmission() {},
      },
      activateTargetConfig() {},
      activateSourceConfig() {},
    })

    await expect(
      coordinator.preflight({
        target: {
          provider: 'postgresql',
          urlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
          poolMax: 4,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
      }),
    ).rejects.toMatchObject({
      code: 'postgresql-url-env-missing',
      status: 422,
      details: { field: 'urlEnv', urlEnv: 'AGENT_WORKFLOW_DATABASE_URL' },
    })
  })

  test('persists failures raised while constructing the target runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-coordinator-bootstrap-failure-'))
    roots.push(root)
    const sqlitePath = join(root, 'db.sqlite')
    const drizzle = createInMemoryDb(MIGRATIONS)
    const sqlite = (drizzle as unknown as { $client: Database }).$client
    writeFileSync(sqlitePath, sqlite.serialize())
    sqlite.close()

    const coordinator = createDatabaseMigrationCoordinator({
      sqlitePath,
      operationsRoot: join(root, 'database-migrations'),
      generationPointerPath: join(root, 'database-generation.json'),
      env: {},
      admission: {
        async freezeAndDrain() {},
        async reopenSqlite() {},
        async activatePostgresql() {},
        async openPostgresqlAdmission() {},
      },
      activateTargetConfig() {},
      activateSourceConfig() {},
    })
    const input = {
      idempotencyKey: 'rfc349-bootstrap-failure-01',
      target: {
        provider: 'postgresql' as const,
        urlEnv: 'RFC349_INTENTIONALLY_MISSING_URL',
        poolMax: 4,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleTimeoutMs: 30_000,
      },
    }
    await expect(coordinator.start(input)).rejects.toThrow('RFC349_INTENTIONALLY_MISSING_URL')
    const [failed] = await coordinator.list()
    if (failed === undefined) throw new Error('expected a durable failed migration operation')
    expect(failed).toMatchObject({
      phase: 'planned',
      failure: {
        category: 'target-schema',
        detailCode: 'postgresql-url-env-missing',
        retryable: false,
      },
    })
    expect(await coordinator.start(input)).toEqual(failed)
  })

  realTest(
    'runs one click, replays idempotently and rolls back before the first live write',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc349-coordinator-'))
      roots.push(root)
      const sqlitePath = join(root, 'db.sqlite')
      const drizzle = createInMemoryDb(MIGRATIONS)
      const sqlite = (drizzle as unknown as { $client: Database }).$client
      writeFileSync(sqlitePath, sqlite.serialize())
      sqlite.close()

      const urlEnv = process.env.RFC349_DATABASE_URL
        ? 'RFC349_DATABASE_URL'
        : resolvePostgresqlTestUrlEnv(process.env)
      if (urlEnv === undefined)
        throw new Error('selected PostgreSQL migration requires a disposable test URL')
      const contract = buildLogicalSchemaContract()
      const admissions: string[] = []
      let activatedTarget: unknown
      let sourceActivations = 0
      let targetWriteStarted!: () => void
      const targetWriteEntered = new Promise<void>((resolve) => {
        targetWriteStarted = resolve
      })
      let releaseTargetWrite!: () => void
      const targetWriteAllowed = new Promise<void>((resolve) => {
        releaseTargetWrite = resolve
      })
      let sourceWriteStarted!: () => void
      const sourceWriteEntered = new Promise<void>((resolve) => {
        sourceWriteStarted = resolve
      })
      let releaseSourceWrite!: () => void
      const sourceWriteAllowed = new Promise<void>((resolve) => {
        releaseSourceWrite = resolve
      })
      const configurationState: { current: DatabaseConfig } = { current: { provider: 'sqlite' } }
      let failBackground!: (error: unknown) => void
      const backgroundFailure = new Promise<never>((_resolve, reject) => {
        failBackground = reject
      })
      const { coordinator } = composeDatabaseMigrationModule({
        sqlitePath,
        operationsRoot: join(root, 'database-migrations'),
        generationPointerPath: join(root, 'database-generation.json'),
        admission: {
          async freezeAndDrain() {
            admissions.push('freeze')
          },
          async reopenSqlite() {
            admissions.push('sqlite')
          },
          async activatePostgresql() {
            admissions.push('postgresql')
          },
          async openPostgresqlAdmission() {
            admissions.push('open')
          },
        },
        configuration: {
          async read() {
            return configurationState.current
          },
          async write(database) {
            if (database.provider === 'postgresql') {
              targetWriteStarted()
              await targetWriteAllowed
              activatedTarget = database
            } else {
              sourceWriteStarted()
              await sourceWriteAllowed
              sourceActivations += 1
            }
            configurationState.current = database
          },
        },
        executionMode: 'background',
        onBackgroundFailure: ({ error }) => failBackground(error),
      })
      const input = {
        idempotencyKey: 'rfc349-production-coordinator-01',
        target: {
          provider: 'postgresql' as const,
          urlEnv,
          // A logical target holds one operation-scoped session after
          // preflight. The production coordinator must sequence preflight
          // before that reservation so the supported minimum pool remains 1.
          poolMax: 1,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
      }
      // The shared CI database is reused serially by isolated test files.
      // Reset only the disposable target's application schemas, as in the
      // existing historical-copy suite, before asking migration to create them.
      const targetRuntime = createPostgresqlDatabaseRuntime({
        config: input.target,
        generationId: 'dbg_rfc370_config_fixture',
      })
      try {
        await targetRuntime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await targetRuntime
          .providerPool()
          .unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
      } finally {
        await targetRuntime.close()
      }
      const migrated = await coordinator.start(input)
      expect(migrated).toMatchObject({
        phase: 'planned',
        tableCounts: {
          source: contract.sourceTableCount,
          active: contract.activeTableCount,
          archiveOnly: contract.archiveOnlyTableCount,
        },
        progress: { tablesCompleted: 0, tablesTotal: contract.sourceTableCount },
      })
      // RFC-370: the production composition must await an asynchronous durable
      // configuration adapter before activating the next provider's admission.
      try {
        await Promise.race([targetWriteEntered, backgroundFailure])
        expect(admissions).toEqual(['freeze'])
        expect(configurationState.current).toEqual({ provider: 'sqlite' })
      } finally {
        releaseTargetWrite()
      }
      let completed = await coordinator.get({ operationId: migrated.operationId })
      const deadline = Date.now() + 30_000
      while (completed.phase !== 'accepting-writes' && completed.failure === null) {
        if (Date.now() >= deadline) throw new Error('background database migration timed out')
        await Bun.sleep(10)
        completed = await coordinator.get({ operationId: migrated.operationId })
      }
      expect(completed).toMatchObject({
        phase: 'accepting-writes',
        progress: {
          tablesCompleted: contract.sourceTableCount,
          tablesTotal: contract.sourceTableCount,
        },
        failure: null,
      })
      expect(admissions).toEqual(['freeze', 'postgresql', 'open'])
      expect(activatedTarget).toEqual(input.target)

      expect(await coordinator.start(input)).toMatchObject({
        operationId: migrated.operationId,
        phase: 'accepting-writes',
      })
      expect(await coordinator.list()).toHaveLength(1)
      const rollingBack = coordinator.rollback({ operationId: migrated.operationId })
      try {
        await Promise.race([
          sourceWriteEntered,
          rollingBack.then(() => {
            throw new Error('rollback completed before persisting source configuration')
          }),
        ])
        expect(admissions).toEqual(['freeze', 'postgresql', 'open', 'freeze'])
        expect(configurationState.current).toEqual(input.target)
      } finally {
        releaseSourceWrite()
      }
      const rolledBack = await rollingBack
      expect(rolledBack).toMatchObject({
        phase: 'accepting-writes',
        rolledBackAt: expect.any(Number),
        rollback: { eligible: false, reason: 'operation-rolled-back' },
      })
      expect(sourceActivations).toBe(1)
      expect(configurationState.current).toEqual({ provider: 'sqlite' })
      expect(admissions.slice(-2)).toEqual(['freeze', 'sqlite'])
      await expect(coordinator.finalize({ operationId: migrated.operationId })).rejects.toThrow(
        'rolled-back database migration',
      )
      expect(buildLogicalSchemaContract().activeTableCount).toBe(182)
    },
    120_000,
  )
})
