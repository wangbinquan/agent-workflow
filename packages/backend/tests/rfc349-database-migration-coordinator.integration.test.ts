// Run with RFC349_DATABASE_URL pointed at an empty disposable PostgreSQL 15+
// database. This covers the production coordinator used by CLI/Settings,
// including durable config activation, idempotent replay and instant rollback.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { createDatabaseMigrationCoordinator } from '@/modules/system-operations/infrastructure/databaseMigrationCoordinator'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const realTest = process.env.RFC349_DATABASE_URL === undefined ? test.skip : test

describe('RFC-349 production database migration coordinator', () => {
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

      const admissions: string[] = []
      let activatedTarget: unknown
      let sourceActivations = 0
      const coordinator = createDatabaseMigrationCoordinator({
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
        activateTargetConfig(target) {
          activatedTarget = target
        },
        activateSourceConfig() {
          sourceActivations += 1
        },
        executionMode: 'background',
      })
      const input = {
        idempotencyKey: 'rfc349-production-coordinator-01',
        target: {
          provider: 'postgresql' as const,
          urlEnv: 'RFC349_DATABASE_URL',
          poolMax: 4,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
      }
      const migrated = await coordinator.start(input)
      expect(migrated).toMatchObject({
        phase: 'planned',
        tableCounts: { source: 184, active: 178, archiveOnly: 6 },
        progress: { tablesCompleted: 0, tablesTotal: 184 },
      })
      let completed = await coordinator.get({ operationId: migrated.operationId })
      const deadline = Date.now() + 30_000
      while (completed.phase !== 'accepting-writes' && completed.failure === null) {
        if (Date.now() >= deadline) throw new Error('background database migration timed out')
        await Bun.sleep(10)
        completed = await coordinator.get({ operationId: migrated.operationId })
      }
      expect(completed).toMatchObject({
        phase: 'accepting-writes',
        progress: { tablesCompleted: 184, tablesTotal: 184 },
        failure: null,
      })
      expect(admissions).toEqual(['freeze', 'postgresql', 'open'])
      expect(activatedTarget).toEqual(input.target)

      expect(await coordinator.start(input)).toMatchObject({
        operationId: migrated.operationId,
        phase: 'accepting-writes',
      })
      expect(await coordinator.list()).toHaveLength(1)
      const rolledBack = await coordinator.rollback({ operationId: migrated.operationId })
      expect(rolledBack).toMatchObject({
        phase: 'accepting-writes',
        rolledBackAt: expect.any(Number),
        rollback: { eligible: false, reason: 'operation-rolled-back' },
      })
      expect(sourceActivations).toBe(1)
      expect(admissions.slice(-2)).toEqual(['freeze', 'sqlite'])
      await expect(coordinator.finalize({ operationId: migrated.operationId })).rejects.toThrow(
        'rolled-back database migration',
      )
      expect(buildLogicalSchemaContract().activeTableCount).toBe(178)
    },
    120_000,
  )
})
