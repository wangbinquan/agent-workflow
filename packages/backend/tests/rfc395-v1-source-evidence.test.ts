// RFC-395 V1: complete prefix coverage, physical evidence, content facts and restart semantics.
import { setDefaultTimeout, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeV1Providers, installFrozenSqlite } from './helpers/rfc395V1Harness'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import { LEGACY_MIGRATION_HASHES } from '@/platform/persistence/migration/epoch1/journalAliases'
import { identifySource } from '@/platform/persistence/migration/supportedSources'
import {
  openEpoch1SqliteSource,
  openEpoch1SqliteBackupSource,
} from '@/platform/persistence/migration/sqliteSourceReader'
import { exportEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceExport'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import {
  captureEpoch1SqliteEvidence,
  verifyEpoch1SqliteEvidence,
} from '@/platform/persistence/migration/auditSourceEvidence'
import { sourceContentPresence } from '@/platform/persistence/migration/sourceReader'
import { tableCatalogDigest } from '@/platform/persistence/migration/sourceDispositions'
import { SourceBlockedError, type SourceKind } from '@/platform/persistence/migration/sourceTypes'
import { assertSqliteIntegrity } from '@/platform/persistence/migration/rawSourceReader'
import { vacuumSqliteInto } from '@/platform/persistence/migration/legacy/sqliteSnapshot'

// Complete source backups and immutable identity evidence take about 12 s per CI-scaled case; allow 40 s.
setDefaultTimeout(40000)

// Independent reconstruction of the released RFC-278 regression fixture.
async function installObserved0141(database: Database): Promise<void> {
  await installFrozenSqlite(database, 141)
  database.exec(`
    DROP TABLE recovery_events;
    CREATE TABLE recovery_events (
      id text PRIMARY KEY NOT NULL,
      task_id text,
      node_run_id text,
      actor text NOT NULL, -- 'system' or a user id
      kind text NOT NULL,  -- legacy inline event catalog
      reason text,
      before_json text,
      after_json text,
      created_at integer NOT NULL
    );
    DROP TABLE mcp_runtime_test_create_receipts;
    CREATE TABLE mcp_runtime_test_create_receipts (
      mcp_id text NOT NULL,
      owner_user_id text NOT NULL,
      client_create_id text NOT NULL,
      request_digest text NOT NULL,
      session_id text NOT NULL,
      accepted_turn_id text NOT NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL,
      PRIMARY KEY (mcp_id, owner_user_id, client_create_id)
    );
    CREATE INDEX idx_mcp_runtime_test_create_receipts_expiry
      ON mcp_runtime_test_create_receipts (expires_at);
    CREATE TABLE recent_repos (
      path text PRIMARY KEY NOT NULL,
      last_used_at integer NOT NULL,
      default_branch text
    );
  `)
}

describeV1Providers('RFC-395 V1 source evidence', (h) => {
  test('metadata has a separate destination and every content kind inspects its actual tree', async () => {
    await h.install()
    const source = await h.source()
    try {
      const preflight = await source.preflight()
      expect(preflight.sourceGenerationId).toMatch(/^dbg_/)
      expect(preflight.identityEvidence).toBe('physical')
      for (const table of preflight.tables.filter(
        (table) =>
          table.physicalTable.startsWith('agent_workflow_meta.') ||
          table.table === '__drizzle_migrations' ||
          table.table === 'employee_os_writer_state',
      )) {
        expect(table.disposition).toBe('metadata')
        expect(table.destination.kind).toBe('migration-records')
      }
      expect(preflight.tables.every((table) => !table.table.startsWith('agent_workflow.'))).toBe(
        true,
      )
      expect(await source.preflight()).toEqual(preflight)
    } finally {
      await source.close()
    }
    for (const kind of [
      'sqlite-file',
      'sqlite-backup',
      'logical-artifact',
      'logical-backup',
      'hosted-backup',
      'postgresql-database',
    ] satisfies SourceKind[]) {
      const root = join(h.operationRoot, kind)
      mkdirSync(root, { recursive: true })
      mkdirSync(join(root, 'runs'))
      const content = sourceContentPresence({ root, kind })
      expect(content[0]?.state).toBe('supplied')
      expect(content[1]?.state).toBe(
        kind === 'sqlite-backup' || kind === 'logical-backup'
          ? 'originally-absent'
          : kind === 'hosted-backup'
            ? 'external-not-inventoried'
            : 'not-inventoried',
      )
    }
  })
  test('identity high-water survives an empty table and repeat preflight, and invalidates the watermark when changed', async () => {
    await h.install()
    const table = 'intent_turn_events'
    const setHighWater = async (value: string) => {
      if (h.provider === 'sqlite') {
        h.sqlite.query('DELETE FROM sqlite_sequence WHERE name=?').run(table)
        h.sqlite
          .query('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)')
          .run(table, BigInt(value))
      } else {
        await h.native.execute(
          "SELECT setval(pg_get_serial_sequence('agent_workflow.intent_turn_events','id'),$1::bigint,true)",
          [value],
        )
      }
    }
    await setHighWater('9007199254740993')
    const source = await h.source()
    try {
      const before = await source.preflight()
      expect(before.identityHighWater.find((entry) => entry.table === table)).toMatchObject({
        value: '9007199254740993',
        isCalled: true,
        increment: '1',
      })
      expect(
        before.fingerprint.tableRows[h.provider === 'sqlite' ? table : `agent_workflow.${table}`],
      ).toBe(0)
      expect(await Promise.all([source.preflight(), source.preflight()])).toEqual([before, before])
      await expect(
        source.assertUnchanged({ ...before, sourceGenerationId: 'dbg_changed_fixture' }),
      ).rejects.toBeInstanceOf(SourceBlockedError)
      await setHighWater('9007199254740994')
      await expect(source.assertUnchanged(before)).rejects.toBeInstanceOf(SourceBlockedError)
    } finally {
      await source.close()
    }
  })
  test('preflight is retryable after a previously unknown empty table is removed', async () => {
    await h.install()
    await h.native.execute(`CREATE TABLE ${h.table('v1_retry')} (id text PRIMARY KEY)`)
    const source = await h.source()
    try {
      await expect(source.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
      await h.native.execute(`DROP TABLE ${h.table('v1_retry')}`)
      const [a, b] = await Promise.all([source.preflight(), source.preflight()])
      expect(a).toEqual(b)
      await source.assertUnchanged(a)
    } finally {
      await source.close()
    }
  })
  if (h.provider === 'sqlite') {
    test('RFC-115 rebuilds explicitly disable cascades, then check all foreign keys', () => {
      createFrozenSqliteJournal(h.sqlite)
      h.sqlite.exec(
        'PRAGMA foreign_keys=ON; CREATE TABLE v1_parent(id INTEGER PRIMARY KEY); CREATE TABLE v1_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES v1_parent(id) ON DELETE CASCADE); INSERT INTO v1_parent VALUES (1); INSERT INTO v1_child VALUES (2,1)',
      )
      applyFrozenSqliteMigrations(h.sqlite, [
        {
          sql: [
            'DROP TABLE v1_parent',
            'CREATE TABLE v1_parent(id INTEGER PRIMARY KEY)',
            'INSERT INTO v1_parent VALUES (1)',
          ],
          folderMillis: 1,
          hash: 'rebuild-fixture',
          bps: true,
        },
      ])
      expect(h.sqlite.query('SELECT * FROM v1_child').all()).toEqual([{ id: 2, parent_id: 1 }])
      expect(() => assertSqliteIntegrity(h.sqlite)).not.toThrow()
      h.sqlite.exec('DELETE FROM v1_parent')
      expect(() => assertSqliteIntegrity(h.sqlite)).toThrow(SourceBlockedError)
    })

    test('every frozen SQLite prefix is identified, including prefixes without a logical contract', async () => {
      const manifest = await h.manifest()
      const history = await loadFrozenEpoch1History()
      expect(manifest.sources.filter((source) => source.provider === 'sqlite')).toHaveLength(
        history.sqlite.length + 1,
      )
      createFrozenSqliteJournal(h.sqlite)
      for (const [index, migration] of history.sqlite.entries()) {
        applyFrozenSqliteMigrations(h.sqlite, [migration])
        const source = identifySource({ fingerprint: await h.fingerprint(), manifest }).source
        expect(source.id).toBe(`sqlite:${history.sqliteTags[index]}`)
        expect(source.sqliteThrough).toBe(index + 1)
        expect(source.readMode).toBe(source.contract ? 'frozen-codec' : 'upgrade-only')
      }
    })
    test('BF-D28 admits only the explicit observed 0141 catalog at its frozen journal prefix', async () => {
      await installObserved0141(h.sqlite)
      const manifest = await h.manifest()
      const history = await loadFrozenEpoch1History()
      const fingerprint = await h.fingerprint()
      const identified = identifySource({ fingerprint, manifest })
      expect(structuredClone(identified.source)).toMatchObject({
        id: 'sqlite:0141_rfc271_resource_bundle_applies:observed-rfc278',
        sqliteThrough: 141,
        contract: null,
        readMode: 'upgrade-only',
        catalog: fingerprint.catalog,
        journal: fingerprint.journal,
        archivedTables: expect.arrayContaining(['recent_repos']),
      })
      expect(identified.tables.find((table) => table.table === 'recent_repos')).toMatchObject({
        disposition: 'archived',
        destination: { kind: 'archive' },
      })
      expect(identified.tables.some((table) => table.disposition === 'blocked')).toBeFalse()
      for (const [tag, aliases] of Object.entries(LEGACY_MIGRATION_HASHES)) {
        const migration = history.sqlite[history.sqliteTags.indexOf(tag)]!
        h.sqlite
          .query('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
          .run(aliases[0]!, migration.folderMillis)
      }
      expect(identifySource({ fingerprint: await h.fingerprint(), manifest }).source.id).toBe(
        identified.source.id,
      )
    })
    test('BF-D28 rejects near-variants of the observed 0141 shape and journal', async () => {
      await installObserved0141(h.sqlite)
      const manifest = await h.manifest()
      for (const sql of [
        'CREATE INDEX idx_recovery_events_task ON recovery_events (task_id, created_at)',
        'DROP INDEX idx_mcp_runtime_test_create_receipts_expiry',
        'ALTER TABLE mcp_runtime_test_create_receipts ADD COLUMN unexpected text',
        'ALTER TABLE recovery_events ADD COLUMN unexpected text',
        'ALTER TABLE recent_repos RENAME COLUMN default_branch TO branch',
        'DROP TABLE recent_repos',
        'ALTER TABLE users ADD COLUMN unexpected text',
        "UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)",
        'UPDATE __drizzle_migrations SET created_at=created_at+1 WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)',
      ]) {
        h.sqlite.exec('SAVEPOINT observed_variant')
        try {
          h.sqlite.exec(sql)
          const fingerprint = await h.fingerprint()
          expect(() => identifySource({ fingerprint, manifest }), sql).toThrow(SourceBlockedError)
        } finally {
          h.sqlite.exec('ROLLBACK TO observed_variant; RELEASE observed_variant')
        }
      }
      const history = await loadFrozenEpoch1History()
      applyFrozenSqliteMigrations(h.sqlite, history.sqlite.slice(141, 142))
      const laterPrefix = await h.fingerprint()
      expect(() => identifySource({ fingerprint: laterPrefix, manifest })).toThrow(
        SourceBlockedError,
      )
    })
    for (const [tag, aliases] of Object.entries(LEGACY_MIGRATION_HASHES))
      test(`BF-D20 legacy alias ${tag}: accepts the exact receipt; rejects mutation, wrong tag and timestamp`, async () => {
        await h.install()
        const history = await loadFrozenEpoch1History()
        const manifest = await h.manifest()
        const index = history.sqliteTags.indexOf(tag)
        expect(index).toBeGreaterThanOrEqual(0)
        expect(aliases).toHaveLength(1)
        const alias = aliases[0]!
        const entry = history.sqlite[index]!
        expect(alias).toMatch(/^[0-9a-f]{64}$/)
        expect(alias).not.toBe(entry.hash)
        const set = (hash: string) =>
          h.sqlite
            .query('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
            .run(hash, entry.folderMillis)
        set(alias)
        expect(
          identifySource({ fingerprint: await h.fingerprint(), manifest }).source.contract?.digest,
        ).toBe(manifest.headDigest)
        set(`${alias.slice(0, -1)}${alias.endsWith('0') ? '1' : '0'}`)
        const mutated = await h.fingerprint()
        expect(() => identifySource({ fingerprint: mutated, manifest })).toThrow(SourceBlockedError)
        set(alias)
        h.sqlite
          .query('UPDATE __drizzle_migrations SET created_at=? WHERE created_at=?')
          .run(entry.folderMillis + 1, entry.folderMillis)
        const timestamp = await h.fingerprint()
        expect(() => identifySource({ fingerprint: timestamp, manifest })).toThrow(
          SourceBlockedError,
        )
        h.sqlite
          .query('UPDATE __drizzle_migrations SET created_at=?,hash=? WHERE created_at=?')
          .run(entry.folderMillis, entry.hash, entry.folderMillis + 1)
        const other = history.sqlite[index + 1]!
        h.sqlite
          .query('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
          .run(alias, other.folderMillis)
        const wrongTag = await h.fingerprint()
        expect(() => identifySource({ fingerprint: wrongTag, manifest })).toThrow(
          SourceBlockedError,
        )
      })
    test('BF-D20 the frozen alias roster contains all nine published tags with distinct live hashes', async () => {
      const history = await loadFrozenEpoch1History()
      expect(Object.keys(LEGACY_MIGRATION_HASHES)).toHaveLength(9)
      const hashes = Object.values(LEGACY_MIGRATION_HASHES).flat()
      expect(new Set(hashes).size).toBe(hashes.length)
      for (const tag of Object.keys(LEGACY_MIGRATION_HASHES))
        expect(history.sqliteTags).toContain(tag)
    })
    for (const format of ['pre-manifest', 'manifest-v1'])
      test(`${format} SQLite backup retains the published raw-file restore path`, async () => {
        await installFrozenSqlite(h.sqlite, 1)
        h.sqlite.exec("INSERT INTO recent_repos VALUES ('old-backup',7,NULL)")
        const history = await loadFrozenEpoch1History()
        const root = join(h.operationRoot, format)
        mkdirSync(root, { recursive: true })
        vacuumSqliteInto({ dbPath: h.sqlitePath, dest: join(root, 'db.sqlite') })
        if (format === 'manifest-v1')
          writeFileSync(
            join(root, 'manifest.json'),
            JSON.stringify({
              manifestVersion: 1,
              kind: 'manual',
              createdAt: 1,
              appVersion: 'epoch1-fixture',
              includesWorktrees: false,
              migration: {
                lastHash: history.sqlite[0]!.hash,
                lastCreatedAt: history.sqlite[0]!.folderMillis,
              },
            }),
          )
        const reader = openEpoch1SqliteBackupSource({
          backupRoot: root,
          operationRoot: h.operationRoot,
          manifest: await h.manifest(),
        })
        try {
          const preflight = await reader.preflight()
          expect(preflight.logicalBackupVerification).toBe('raw-sqlite-only')
          expect(preflight.requiresOfflineUpgrade).toBe(true)
          expect((await reader.readRawChunk('recent_repos', null, 2)).rows).toHaveLength(1)
          expect(await reader.preflight()).toEqual(preflight)
        } finally {
          await reader.close()
        }
      })
    for (const appVersion of ['0.18.18', '0.18.19'])
      test(`manifest-v2 v${appVersion} reads raw db.sqlite despite the obsolete logical contract`, async () => {
        await installFrozenSqlite(h.sqlite, 223)
        const history = await loadFrozenEpoch1History()
        const last = history.sqlite[222]!
        const root = join(h.operationRoot, appVersion)
        mkdirSync(root, { recursive: true })
        vacuumSqliteInto({ dbPath: h.sqlitePath, dest: join(root, 'db.sqlite') })
        writeFileSync(
          join(root, 'manifest.json'),
          JSON.stringify({
            manifestVersion: 2,
            kind: 'manual',
            createdAt: 1,
            appVersion,
            includesWorktrees: false,
            migration: { lastHash: last.hash, lastCreatedAt: last.folderMillis },
            database: {
              format: 'agent-workflow-logical-database-v1',
              provider: 'sqlite',
              sourceGenerationId: 'dbg_v018_backup_fixture',
              schemaDigest:
                'sha256:3ee9be23a3e0f46c002f76b382b33d137c6a9ef4ef78a3ee71e212e5247c72d7',
              logicalPath: 'database/logical',
              envelopeFileDigest: `sha256:${'0'.repeat(64)}`,
              rawSqlitePath: 'db.sqlite',
            },
          }),
        )
        const reader = openEpoch1SqliteBackupSource({
          backupRoot: root,
          operationRoot: h.operationRoot,
          manifest: await h.manifest(),
        })
        try {
          const preflight = await reader.preflight()
          expect(preflight.logicalBackupVerification).toBe('raw-sqlite-only')
          expect(preflight.requiresOfflineUpgrade).toBe(true)
          expect(preflight.sourceGenerationId).toBe('dbg_v018_backup_fixture')
          expect(await reader.readRawChunk('__drizzle_migrations', null, 1000)).toMatchObject({
            rows: expect.any(Array),
          })
        } finally {
          await reader.close()
        }
      })
    test('watermark survives connection restart, file relocation and a separate process', async () => {
      await h.install()
      await h.seed()
      const manifest = await h.manifest()
      const first = openEpoch1SqliteSource({
        path: h.sqlitePath,
        manifest,
        operationRoot: h.operationRoot,
      })
      const before = await first.preflight()
      await first.close()
      const path = join(h.operationRoot, 'relocated.sqlite')
      vacuumSqliteInto({ dbPath: h.sqlitePath, dest: path })
      const second = openEpoch1SqliteSource({ path, manifest, operationRoot: h.operationRoot })
      try {
        expect((await second.preflight()).watermark).toBe(before.watermark)
        const script = join(import.meta.dir, 'fixtures/rfc395-v1/restart.ts')
        const process = Bun.spawn([Bun.which('bun')!, script, path, h.operationRoot], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const output = await new Response(process.stdout).text()
        expect(await process.exited).toBe(0)
        expect(JSON.parse(output).watermark).toBe(before.watermark)
      } finally {
        await second.close()
      }
    })
    test('audit capture preserves full native evidence but never authorizes the unknown sample', async () => {
      await h.install()
      h.sqlite.exec('CREATE TABLE draft_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,payload BLOB)')
      h.sqlite.exec("INSERT INTO draft_audit(payload) VALUES (X'00FF')")
      const evidence = captureEpoch1SqliteEvidence({
        sourcePath: h.sqlitePath,
        operationRoot: h.operationRoot,
        appliedBy: {
          revision: 'fixture',
          unknownMigrationSql: { draft: 'CREATE TABLE draft_audit' },
        },
      })
      expect(() => verifyEpoch1SqliteEvidence(evidence)).not.toThrow()
      expect(evidence.schema).toHaveLength(
        h.sqlite.query('SELECT * FROM sqlite_schema').all().length,
      )
      expect(
        evidence.catalog.some(
          (entry) => entry.relation === 'draft_audit' && entry.kind === 'column',
        ),
      ).toBe(true)
      expect(evidence.journal).toHaveLength((await h.fingerprint()).journalEntryCount)
      expect(evidence.tableRows.draft_audit).toBe(1)
      expect(evidence.sqliteSequence.find((entry) => entry.table === 'draft_audit')?.value).toBe(
        '1',
      )
      expect(Object.keys(evidence.pragmas)).toEqual(
        expect.arrayContaining([
          'page_size',
          'user_version',
          'journal_mode',
          'encoding',
          'quick_check',
          'foreign_key_check',
          'integrity_check',
        ]),
      )
      expect(() => verifyEpoch1SqliteEvidence({ ...evidence, digest: 'changed' })).toThrow(
        SourceBlockedError,
      )
      const manifest = await h.manifest()
      const fingerprint = await h.fingerprint()
      expect(() => identifySource({ fingerprint, manifest })).toThrow(SourceBlockedError)
    })
  }
  if (h.provider === 'postgresql') {
    test('unknown PostgreSQL tables block before export; an empty identity table needs its owned-sequence decision', async () => {
      await h.install()
      await h.native.execute(
        'CREATE TABLE agent_workflow.v1_unknown (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)',
      )
      const source = await h.source()
      const artifactRoot = join(h.operationRoot, 'blocked-export')
      try {
        await expect(
          exportEpoch1PostgresqlSource({
            source,
            artifactRoot,
            operationId: 'dbm_unknown_table_fixture',
            chunkRows: 2,
          }),
        ).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await source.close()
      }
      const fingerprint = await h.fingerprint()
      const table = 'agent_workflow.v1_unknown'
      const decision = {
        table,
        catalogDigest: tableCatalogDigest(fingerprint, table),
        disposition: 'archived' as const,
        reason: 'empty table and owned sequence reviewed',
      }
      expect(
        identifySource({
          fingerprint,
          manifest: await h.manifest(),
          emptyTables: [decision],
        }).tables.find((entry) => entry.table === 'v1_unknown')?.disposition,
      ).toBe('archived')
      await h.native.execute('INSERT INTO agent_workflow.v1_unknown DEFAULT VALUES')
      const populated = await h.fingerprint()
      const manifest = await h.manifest()
      expect(() =>
        identifySource({ fingerprint: populated, manifest, emptyTables: [decision] }),
      ).toThrow(SourceBlockedError)
    })
    test('bound export carries physical fingerprint, generation and sequence high-water into the artifact reader', async () => {
      const version = await h.install()
      await h.seed()
      const backup = await h.backup(version)
      const reader = openEpoch1LogicalArtifactSource({
        artifactRoot: backup.artifactRoot,
        envelopeFileDigest: backup.envelopeFileDigest,
        supportedSources: await h.manifest(),
      })
      try {
        const preflight = await reader.preflight()
        expect(preflight.fingerprint.evidence).toBe('physical-catalog-and-journal')
        expect(preflight.identityEvidence).toBe('physical')
        expect(preflight.sourceGenerationId).toBe('dbg_rfc395_v1_backup_fixture')
        expect(preflight.identityHighWater.length).toBeGreaterThan(0)
        expect(
          (await reader.readRawChunk('schema_migrations', null, 3)).rows.length,
        ).toBeGreaterThan(0)
        const cloned = join(h.operationRoot, 'export-copy')
        cpSync(backup.artifactRoot, cloned, { recursive: true })
        const binding = join(cloned, 'source-evidence/binding.json')
        const text = readFileSync(binding, 'utf8')
        writeFileSync(
          binding,
          text.replace('dbg_rfc395_v1_backup_fixture', 'dbg_changed_generation_fixture'),
        )
        const changed = openEpoch1LogicalArtifactSource({
          artifactRoot: cloned,
          envelopeFileDigest: backup.envelopeFileDigest,
          supportedSources: await h.manifest(),
        })
        try {
          await expect(changed.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
        } finally {
          await changed.close()
        }
      } finally {
        await reader.close()
        backup.close()
      }
    })
  }
})
