import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  frozenTablesOf as tablesOf,
  bindFrozenSqliteHandle,
  FROZEN_MIGRATIONS,
  type FrozenDbClient as DbClient,
} from './migration-freeze'

import { first } from '@/platform/persistence/queryHelpers'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-279 — locks the seven-column physical cleanup, fail-closed polarity,
// direct-upgrade URL escrow, and current single-id operation contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrateFrozenSqlite as migrate } from './migration-freeze'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { unsealRepoUrl } from '../src/services/repoCredentials'
import { repositoryUrlEnvironment } from '@/modules/source-control/composition/conversion'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import type { SecretBox } from '@/auth/secretBox'

const MIGRATIONS = FROZEN_MIGRATIONS
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
    artifacts.clear()
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
    db = bindFrozenSqliteHandle(sqlite)
    migrate(db, { migrationsFolder: tempMigrations })
  })

  afterEach(() => {
    sqlite?.close()
    rmSync(tempMigrations, { recursive: true, force: true })
  })

  const artifacts = new Map<string, Uint8Array>()
  async function converterUrls(key: SecretBox | null = box) {
    const rows = sqlite.query('SELECT * FROM cached_repos ORDER BY id').all()
    const input = {
      stage: 'plan',
      root: { kind: 'app-home', root: tempMigrations, runsSupplied: false, objects: 'none' },
      source: {
        preflight: { tables: [{ table: 'cached_repos' }], expectedAbsent: [] },
        reader: {
          async assertUnchanged() {},
          async readChunk() {
            return { decodedRows: rows, rows, lastKey: null }
          },
        },
      },
      readArtifact: async (name: string) => artifacts.get(name) ?? null,
      writeArtifact: async (name: string, bytes: Uint8Array) => {
        artifacts.set(name, bytes)
      },
    } as unknown as BootUpgradeCaptureInput
    const facts = await repositoryUrlEnvironment({
      async open() {
        return key ? { identity: 'original-input', fingerprint: 'key-27', box: key } : null
      },
    }).capture(input)
    return facts.map(
      (fact) =>
        fact.evidence as {
          id: string
          urlEnc: string | null
          urlRedacted: string | null
          reason: string | null
        },
    )
  }

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

    const { cachedRepos } = tablesOf(db)
    const escrow = first(db.select().from(cachedRepos))!
    expect(escrow.urlEnc?.startsWith('aw-legacy-url-hex-v1:')).toBe(true)
    expect(unsealRepoUrl(escrow, box)).toBeNull()

    const before = sqlite.query('SELECT url_enc FROM cached_repos').get()
    const converted = (await converterUrls())[0]!
    expect(converted.reason).toBeNull()
    expect(box.unseal(converted.urlEnc!)).toBe(LEGACY_URL)
    expect(converted.urlRedacted).not.toContain('OLDTOKEN')
    expect((await converterUrls())[0]).toEqual(converted)
    expect(sqlite.query('SELECT url_enc FROM cached_repos').get()).toEqual(before)
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
    const facts = await converterUrls()
    expect(facts[0]!.reason).toBe('v2-boot-url-escrow-invalid')
    expect(JSON.stringify(facts[0]!.reason)).not.toContain('XYZ')
  })

  test('migration escrow cannot pass the converter without a SecretBox', async () => {
    sqlite
      .query(
        `INSERT INTO cached_repos (
          id, url_hash, url, local_path, last_fetched_at, created_at
        ) VALUES ('needs-key', 'key00000', ?, '/tmp/needs-key', 1, 1)`,
      )
      .run(LEGACY_URL)
    apply0147()

    expect((await converterUrls(null))[0]!.reason).toBe('v2-boot-url-key-missing')
    const { cachedRepos } = tablesOf(db)
    expect(first(db.select().from(cachedRepos))?.urlEnc).toStartWith('aw-legacy-url-hex-v1:')
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

    const { cachedRepos } = tablesOf(db)
    const row = first(db.select().from(cachedRepos))!
    expect(row.urlEnc).toBe(sealed)
    expect(unsealRepoUrl(row, box)).toBe(LEGACY_URL)
    expect((await converterUrls())[0]!.urlEnc).toBe(sealed)
  })
})

describe('RFC-279 source ratchet', () => {
  test('current schema and production readers no longer name removed physical fields', () => {
    const schema = persistenceSchema.tables.flatMap((table) =>
      Object.values(table.columns).map((column) => column.name),
    )
    for (const identifier of [
      'migration_marker',
      'prior_answer_snapshot_json',
      'reopen_count',
      'manual_title',
      'next_skill_id',
    ]) {
      expect(schema).not.toContain(identifier)
    }

    const production = [
      'modules/resource-catalog/infrastructure/legacy/skill.ts',
      'modules/resource-catalog/infrastructure/legacy/skillBootVerify.ts',
      'modules/resource-catalog/infrastructure/legacy/skillVersion.ts',
      'services/taskQuestions.ts',
      // RFC-284 T27 改锚：正体迁 clarify/queue.ts（旧路径只剩 facade，留旧条目会让本扫描空转）。
      'modules/collaboration/infrastructure/clarify/queue.ts',
      'services/gitRepoCache.ts',
      'services/repoCredentials.ts',
      'services/repoGroup.ts',
      'modules/resource-catalog/infrastructure/legacy/skillOperations.ts',
      'modules/resource-catalog/infrastructure/migration/skillBootRules.ts',
      'services/webhook/webhookDispatch.ts',
      'bootstrap/daemonApplication.ts',
    ]
      .map((path) =>
        path === 'bootstrap/daemonApplication.ts'
          ? readDaemonGraphSource()
          : readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8'),
      )
      .join('\n')
    expect(production).not.toContain('skills.sourceKind')
    expect(production).not.toContain('cachedRepos.url)')
    expect(production).not.toContain('nextSkillId')
    expect(production).not.toContain('priorAnswerSnapshotJson')
  })
})
