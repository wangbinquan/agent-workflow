// RFC-279 — locks the seven-column physical cleanup, fail-closed polarity,
// direct-upgrade URL escrow, and current single-id operation contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { ensureCredentialsSealed, unsealRepoUrl } from '../src/services/repoCredentials'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIGRATION = join(MIGRATIONS, '0147_rfc279_database_redundancy_cleanup.sql')
const LEGACY_URL = 'https://x-access-token:OLDTOKEN@github.com/acme/legacy.git'
const box = createSecretBoxFromKey(Buffer.alloc(32, 27))

function columns(sqlite: Database, table: string): string[] {
  return (sqlite.query(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

describe('RFC-279 migration 0147', () => {
  let tempMigrations: string
  let sqlite: Database
  let db: DbClient

  beforeEach(() => {
    tempMigrations = mkdtempSync(join(tmpdir(), 'aw-rfc279-migrations-'))
    cpSync(MIGRATIONS, tempMigrations, { recursive: true })
    const journalPath = join(tempMigrations, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number }>
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 145)
    writeFileSync(journalPath, JSON.stringify(journal))

    sqlite = new Database(':memory:')
    sqlite.exec('PRAGMA foreign_keys = OFF')
    db = drizzle(sqlite) as unknown as DbClient
    migrate(db, { migrationsFolder: tempMigrations })
  })

  afterEach(() => {
    sqlite?.close()
    rmSync(tempMigrations, { recursive: true, force: true })
  })

  function apply0147(): void {
    const source = readFileSync(MIGRATION, 'utf8')
    const run = sqlite.transaction(() => {
      for (const part of source.split('--> statement-breakpoint')) {
        const statement = part.trim()
        if (statement.length > 0) sqlite.exec(statement)
      }
    })
    run()
  }

  function insertQuestion(overrides: {
    reopenCount?: number
    priorSnapshot?: string | null
    questionTitle?: string
    manualTitle?: string | null
  }): void {
    sqlite
      .query(
        `INSERT INTO task_questions (
          id, task_id, origin_node_run_id, question_id, question_title,
          source_kind, role_kind, reopen_count, prior_answer_snapshot_json,
          manual_title
        ) VALUES (?, ?, ?, ?, ?, 'manual', 'designer', ?, ?, ?)`,
      )
      .run(
        ulid(),
        ulid(),
        ulid(),
        ulid(),
        overrides.questionTitle ?? 'Title',
        overrides.reopenCount ?? 0,
        overrides.priorSnapshot ?? null,
        overrides.manualTitle ?? null,
      )
  }

  test('preserves data and locks while removing all seven columns', async () => {
    const skillId = ulid()
    const opId = ulid()
    sqlite
      .query(
        `INSERT INTO skills (id, name, source_kind, managed_path)
         VALUES (?, 'kept-skill', 'managed', ?)`,
      )
      .run(skillId, `skills/${skillId}/files`)
    insertQuestion({ questionTitle: 'Manual title', manualTitle: 'Manual title' })
    sqlite
      .query(
        `INSERT INTO skill_operations (op_id, skill_id, kind, phase, active)
         VALUES (?, ?, 'reserve', 'intent', 1)`,
      )
      .run(opId, skillId)
    sqlite
      .query(
        `INSERT INTO skill_operation_locks (locked_skill_id, op_id)
         VALUES (?, ?)`,
      )
      .run(skillId, opId)
    sqlite
      .query(
        `INSERT INTO cached_repos (
          id, url_hash, url, local_path, last_fetched_at, created_at
        ) VALUES ('repo-legacy', 'deadbeef', ?, '/tmp/repo-legacy', 1, 1)`,
      )
      .run(LEGACY_URL)

    apply0147()

    for (const column of ['source_kind', 'migration_marker']) {
      expect(columns(sqlite, 'skills')).not.toContain(column)
    }
    for (const column of ['reopen_count', 'prior_answer_snapshot_json', 'manual_title']) {
      expect(columns(sqlite, 'task_questions')).not.toContain(column)
    }
    expect(columns(sqlite, 'cached_repos')).not.toContain('url')
    expect(columns(sqlite, 'skill_operations')).not.toContain('next_skill_id')
    expect(
      sqlite.query('SELECT name FROM skills WHERE id = ?').get(skillId) as { name: string },
    ).toEqual({ name: 'kept-skill' })
    expect(
      sqlite
        .query('SELECT op_id FROM skill_operation_locks WHERE locked_skill_id = ?')
        .get(skillId),
    ).toEqual({ op_id: opId })

    const ddl = (
      sqlite
        .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_operations'")
        .get() as { sql: string }
    ).sql
    expect(ddl).toContain("'reserve', 'migrate', 'delete', 'version-write'")
    expect(ddl).not.toContain("'replace'")
    expect(ddl).not.toContain("'adopt-managed'")
    expect(
      sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_skill_operations_active'",
        )
        .get(),
    ).toEqual({ name: 'uq_skill_operations_active' })

    const escrow = db.select().from(cachedRepos).get()!
    expect(escrow.urlEnc?.startsWith('aw-legacy-url-hex-v1:')).toBe(true)
    expect(unsealRepoUrl(escrow, box)).toBeNull()

    const store = composeSqliteRepositoryWorkspaceStore(db)
    const sealed = await ensureCredentialsSealed(store, box)
    expect(sealed.sealed).toBe(1)
    const current = db.select().from(cachedRepos).get()!
    expect(current.urlEnc?.startsWith('aw-legacy-url-hex-v1:')).toBe(false)
    expect(current.urlRedacted).toBe('https://***@github.com/acme/legacy.git')
    expect(unsealRepoUrl(current, box)).toBe(LEGACY_URL)
    expect((await ensureCredentialsSealed(store, box)).sealed).toBe(0)
  })

  const guardCases: Array<{ name: string; seed: (sqlite: Database) => void }> = [
    {
      name: 'non-managed skill',
      seed: (raw) =>
        raw
          .query(
            `INSERT INTO skills (id, name, source_kind, managed_path)
             VALUES (?, 'unexpected-external', 'external', 'skills/x/files')`,
          )
          .run(ulid()),
    },
    {
      name: 'non-zero reopen count',
      seed: () => insertQuestion({ reopenCount: 1 }),
    },
    {
      name: 'prior answer snapshot',
      seed: () => insertQuestion({ priorSnapshot: '{}' }),
    },
    {
      name: 'divergent manual title',
      seed: () => insertQuestion({ questionTitle: 'A', manualTitle: 'B' }),
    },
    {
      name: 'retired operation kind',
      seed: (raw) =>
        raw
          .query(
            `INSERT INTO skill_operations (op_id, skill_id, kind, phase, active)
             VALUES (?, ?, 'replace', 'intent', 1)`,
          )
          .run(ulid(), ulid()),
    },
    {
      name: 'second operation id',
      seed: (raw) =>
        raw
          .query(
            `INSERT INTO skill_operations (
              op_id, skill_id, kind, phase, active, next_skill_id
             ) VALUES (?, ?, 'reserve', 'intent', 1, ?)`,
          )
          .run(ulid(), ulid(), ulid()),
    },
  ]

  for (const guardCase of guardCases) {
    test(`fails closed and rolls back for ${guardCase.name}`, () => {
      guardCase.seed(sqlite)
      expect(() => apply0147()).toThrow()
      expect(columns(sqlite, 'skills')).toContain('source_kind')
      expect(columns(sqlite, 'cached_repos')).toContain('url')
      expect(columns(sqlite, 'skill_operations')).toContain('next_skill_id')
    })
  }

  test('corrupt migration escrow fails closed without exposing its payload', async () => {
    apply0147()
    sqlite
      .query(
        `INSERT INTO cached_repos (
          id, url_hash, url_enc, url_redacted, local_path, last_fetched_at, created_at
        ) VALUES ('bad-escrow', 'bad00000', 'aw-legacy-url-hex-v1:XYZ', NULL, '/tmp/bad', 1, 1)`,
      )
      .run()
    await expect(
      ensureCredentialsSealed(composeSqliteRepositoryWorkspaceStore(db), box),
    ).rejects.toThrow(/cached repo legacy URL escrow is malformed/)
  })

  test('migration escrow cannot pass the boot gate without a SecretBox', async () => {
    sqlite
      .query(
        `INSERT INTO cached_repos (
          id, url_hash, url, local_path, last_fetched_at, created_at
        ) VALUES ('needs-key', 'key00000', ?, '/tmp/needs-key', 1, 1)`,
      )
      .run(LEGACY_URL)
    apply0147()

    await expect(
      ensureCredentialsSealed(composeSqliteRepositoryWorkspaceStore(db), undefined),
    ).rejects.toThrow(/legacy URL escrow requires SecretBox sealing/)
    expect(db.select().from(cachedRepos).get()?.urlEnc).toStartWith('aw-legacy-url-hex-v1:')
  })

  test('an already sealed URL survives the migration unchanged', async () => {
    const sealed = box.seal(LEGACY_URL)
    sqlite
      .query(
        `INSERT INTO cached_repos (
          id, url_hash, url, url_enc, url_redacted,
          local_path, last_fetched_at, created_at
        ) VALUES (
          'already-sealed', 'sealed00', '', ?,
          'https://***@github.com/acme/legacy.git', '/tmp/sealed', 1, 1
        )`,
      )
      .run(sealed)
    apply0147()

    const row = db.select().from(cachedRepos).get()!
    expect(row.urlEnc).toBe(sealed)
    expect(unsealRepoUrl(row, box)).toBe(LEGACY_URL)
    expect(
      (await ensureCredentialsSealed(composeSqliteRepositoryWorkspaceStore(db), box)).sealed,
    ).toBe(0)
  })
})

describe('RFC-279 source ratchet', () => {
  test('current schema and production readers no longer name removed physical fields', () => {
    const schema = readFileSync(resolve(import.meta.dir, '..', 'src', 'db', 'schema.ts'), 'utf8')
    for (const identifier of [
      'migrationMarker:',
      'priorAnswerSnapshotJson:',
      "reopenCount: integer('reopen_count')",
      "manualTitle: text('manual_title')",
      'nextSkillId:',
    ]) {
      expect(schema).not.toContain(identifier)
    }

    const production = [
      'modules/resource-catalog/infrastructure/legacy/skill.ts',
      'modules/resource-catalog/infrastructure/legacy/skillBootVerify.ts',
      'modules/resource-catalog/infrastructure/legacy/skillVersion.ts',
      'services/taskQuestions.ts',
      // RFC-284 T27 改锚：正体迁 clarify/queue.ts（旧路径只剩 facade，留旧条目会让本扫描空转）。
      'services/clarify/queue.ts',
      'services/gitRepoCache.ts',
      'services/repoCredentials.ts',
      'services/repoGroup.ts',
      'modules/resource-catalog/infrastructure/legacy/skillOperations.ts',
      'modules/resource-catalog/infrastructure/legacy/skillIdentityMigration.ts',
      'services/webhook/webhookDispatch.ts',
      'cli/start.ts',
    ]
      .map((path) => readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8'))
      .join('\n')
    expect(production).not.toContain('skills.sourceKind')
    expect(production).not.toContain('cachedRepos.url)')
    expect(production).not.toContain('nextSkillId')
    expect(production).not.toContain('priorAnswerSnapshotJson')
  })
})
