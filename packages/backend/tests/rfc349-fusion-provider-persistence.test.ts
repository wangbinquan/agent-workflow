// RFC-349 — fusion orchestration owns no database mechanism. Durable state,
// OCC, recovery and atomic skill+memory apply are selected-provider operations.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { memories, skillOperations, skills, skillVersions } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlFusionPersistence } from '@/modules/memory/infrastructure/postgresqlFusionPersistence'
import { createSqliteFusionPersistence } from '@/modules/memory/infrastructure/sqliteFusionPersistence'
import type { FusionPersistenceRecord } from '@/modules/memory/public/fusion'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-fusion-'))
  roots.push(root)
  return root
}

function fusionRecord(
  preconditionToken: string,
  patch: Partial<FusionPersistenceRecord> = {},
): FusionPersistenceRecord {
  return {
    id: 'fusion-1',
    skillId: 'skill-1',
    skillName: 'managed-skill',
    baseSkillVersion: 1,
    preconditionToken,
    memoryIdsJson: '["memory-1"]',
    intent: 'merge approved knowledge',
    status: 'applying',
    iteration: 1,
    currentTaskId: null,
    proposedWorktreePath: null,
    proposedDiff: null,
    incorporatedMemoryIdsJson: '["memory-1"]',
    skippedJson: '[]',
    changelog: 'merged memory',
    appliedSkillVersion: null,
    ownerUserId: 'owner-1',
    createdAt: 1,
    decidedByUserId: null,
    decidedAt: null,
    decisionReason: null,
    error: null,
    ...patch,
  }
}

function sqlRows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const execute = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    return sqlRows(responses.shift() ?? [])
  }
  const connection: PostgresqlReservedConnection = { unsafe: execute, release() {} }
  const pool: PostgresqlPool = {
    unsafe: execute,
    async reserve() {
      return connection
    },
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_fusion_pg',
    providerPool: () => pool,
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 fusion provider persistence', () => {
  test('keeps database mechanisms behind provider adapters', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const service = readFileSync(join(sourceRoot, 'services/fusion.ts'), 'utf8')
    const contract = readFileSync(join(sourceRoot, 'modules/memory/public/fusion.ts'), 'utf8')
    const sqlite = readFileSync(
      join(sourceRoot, 'modules/memory/infrastructure/sqliteFusionPersistence.ts'),
      'utf8',
    )
    const postgresql = readFileSync(
      join(sourceRoot, 'modules/memory/infrastructure/postgresqlFusionPersistence.ts'),
      'utf8',
    )

    expect(service).not.toMatch(/from ['"](?:@\/db\/|drizzle-orm)/)
    expect(service).not.toMatch(/\bdb\.(?:select|insert|update|delete|transaction)\b/)
    expect(service).toContain('operations.persistence')
    expect(contract).not.toMatch(/@\/db\/|drizzle-orm|\bDbClient\b|PostgresqlDatabaseClient/)
    expect(sqlite).toContain('DbClient')
    expect(postgresql).toContain('PostgresqlDatabaseClient')
    expect(postgresql).not.toMatch(/createSqlite|\bas DbClient\b|\bas PostgresqlDatabaseClient\b/)
  })

  test('SQLite atomically versions the skill, fuses memories and publishes the proposal', async () => {
    const appHome = tempRoot()
    const db = createInMemoryDb(MIGRATIONS)
    const actor = buildActor({
      user: {
        id: 'owner-1',
        username: 'owner',
        displayName: 'Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    db.insert(skills)
      .values({
        id: 'skill-1',
        name: 'managed-skill',
        managedPath: 'skills/skill-1/files',
        contentVersion: 1,
        versionState: 'snapshot-authoritative',
        ownerUserId: actor.user.id,
      })
      .run()
    db.insert(memories)
      .values({
        id: 'memory-1',
        scopeType: 'global',
        scopeId: null,
        title: 'approved memory',
        bodyMd: 'durable content',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: 1,
      })
      .run()

    const live = join(appHome, 'skills/skill-1/files')
    const versionOne = join(appHome, 'skills/skill-1/versions/v1/files')
    const proposal = join(appHome, 'proposal')
    for (const directory of [live, versionOne, proposal]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(live, 'SKILL.md'), 'old\n')
    writeFileSync(join(versionOne, 'SKILL.md'), 'old\n')
    writeFileSync(join(proposal, 'SKILL.md'), 'new\n')

    const persistence = createSqliteFusionPersistence({ db, appHome })
    const access = await persistence.loadSkillAccess(actor, 'skill-1')
    expect(access).not.toBeNull()
    await persistence.create(fusionRecord(access!.preconditionToken))
    const applied = await persistence.apply({
      fusionId: 'fusion-1',
      actor,
      appHome,
      proposedWorktreePath: proposal,
      incorporatedMemoryIds: ['memory-1'],
      summary: 'merged memory',
      now: 10,
    })

    expect(applied).toEqual({ versionIndex: 2 })
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(appHome, 'skills/skill-1/versions/v2/files/SKILL.md'), 'utf8')).toBe(
      'new\n',
    )
    expect(db.select().from(skills).where(eq(skills.id, 'skill-1')).get()?.contentVersion).toBe(2)
    expect(db.select().from(memories).where(eq(memories.id, 'memory-1')).get()?.status).toBe(
      'fused',
    )
    expect(
      db.select().from(skillVersions).where(eq(skillVersions.fusionId, 'fusion-1')).get()
        ?.versionIndex,
    ).toBe(2)
    expect(
      db.select().from(skillOperations).where(eq(skillOperations.skillId, 'skill-1')).get()?.active,
    ).toBe(0)
  })

  test('PostgreSQL adapter issues schema-qualified Promise reads', async () => {
    const fixture = postgresqlFixture([[['fusion-1'], ['fusion-2']]])
    const persistence = createPostgresqlFusionPersistence({
      db: fixture.db,
      appHome: tempRoot(),
    })

    await expect(persistence.listIdsByStatus('running')).resolves.toEqual(['fusion-1', 'fusion-2'])
    expect(fixture.executions).toHaveLength(1)
    expect(fixture.executions[0]?.sql).toContain('"agent_workflow"."fusions"')
    expect(fixture.executions[0]?.parameters).toEqual(['running'])
  })
})
