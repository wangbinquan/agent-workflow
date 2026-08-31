// Run with RFC349_DATABASE_URL pointed at an empty disposable PostgreSQL 15+
// database. This covers the production coordinator used by CLI/Settings,
// including durable config activation, idempotent replay and instant rollback.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
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
        phase: 'accepting-writes',
        tableCounts: { source: 184, active: 178, archiveOnly: 6 },
        progress: { tablesCompleted: 184, tablesTotal: 184 },
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
