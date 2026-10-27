import { epochSourceArchiveInput } from '@/bootstrap/epochMigration'
import { SQL } from 'bun'
import type { PostgresqlPool } from '@/platform/persistence/postgresqlRuntime'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  compileEpoch1PostgresqlCatalog,
  loadSupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { LEGACY_MIGRATION_HASHES } from '@/platform/persistence/migration/epoch1/journalAliases'
// RFC-395 V3-F: source snapshots, retained upgrade evidence and restart bindings.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describeV1Providers, installFrozenSqlite } from './helpers/rfc395V1Harness'
import { describeV3Providers, describeV3CrossProvider } from './helpers/rfc395V3Harness'
import {
  openFrozenSource,
  openLiveSnapshotSource,
  frozenSourceDetails,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import { openPostgresqlScratch } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { createLocalEpochArtifacts as createLocalSourceArtifacts } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { atomicSourceFile } from '@/platform/persistence/migration/freeze/artifacts'
import type { EpochSwitchArtifactPort } from '@/platform/persistence/migration/run/types'
import { sourceFilesDigest } from '@/platform/persistence/migration/sourceReader'
import { createEpochSourceAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/sourceAdapter'

// Source freeze, offline upgrade and reopen take about 27 s per CI-scaled case; allow 90 s.
setDefaultTimeout(90_000)

describeV1Providers('RFC-395 V3 source access', (h) => {
  const input = async (): Promise<SourceAccessInput> => ({
    manifest: await h.manifest(),
    emptyTables: [],
    operationRoot: join(h.operationRoot, 'access'),
    location:
      h.provider === 'sqlite'
        ? {
            kind: 'sqlite-file',
            path: h.sqlitePath,
            pointerPath: join(h.operationRoot, 'missing-pointer.json'),
          }
        : { kind: 'postgresql-database', profileRef: 'env:V3_SOURCE_URL' },
    postgresql: () => h.runtime,
  })
  test('freeze/reopen retains watermark and rejects source changes without mutating the source', async () => {
    await h.install()
    await h.seed()
    const request = await input()
    const source = await openFrozenSource(request)
    const expected = {
      watermark: source.watermark,
      preUpgradeWatermark: null,
      sourceGenerationId: source.preflight.sourceGenerationId,
    }
    const rows = await source.reader.readChunk('maintenance_state', null, 100)
    const original = frozenSourceDetails(source).originalReader
    const assertOriginal = original.assertUnchanged.bind(original)
    let assertions = 0
    original.assertUnchanged = async (expected) => {
      assertions += 1
      await assertOriginal(expected)
    }
    await source.reader.assertUnchanged(source.preflight)
    expect(assertions).toBe(1)
    await source.close()
    const again = await openFrozenSource({ ...request, expected })
    expect(await again.reader.readChunk('maintenance_state', null, 100)).toEqual(rows)
    expect(again.preUpgrade).toBeNull()
    await again.close()
    await h.native.execute(
      `UPDATE ${h.table('maintenance_state')} SET value='changed' WHERE key='v1-a'`,
    )
    await expect(openFrozenSource({ ...request, expected })).rejects.toThrow('source-changed')
    const adapter = createEpochSourceAdapter({
      async resolve() {
        return request
      },
    })
    await expect(adapter.freeze({ ...request, expected })).rejects.toMatchObject({
      category: 'source-changed',
    })
  })

  test('portable, logical-artifact and hosted readers use the immutable backup digest', async () => {
    const version = await h.install()
    await h.seed()
    const backup = await h.backup(version)
    try {
      const cases = [
        {
          kind: 'backup' as const,
          sourceKind:
            h.provider === 'sqlite' ? ('sqlite-backup' as const) : ('logical-backup' as const),
          artifact: backup.root,
          root: backup.root,
        },
        {
          kind: 'backup' as const,
          sourceKind: 'logical-artifact' as const,
          artifact: backup.artifactRoot,
          root: backup.artifactRoot,
        },
        {
          kind: 'backup' as const,
          sourceKind: 'hosted-backup' as const,
          artifact: backup.root,
          root: backup.root,
        },
      ]
      for (const location of cases) {
        const source = await openFrozenSource({ ...(await input()), location })
        try {
          expect(source.preflight.kind).toBe(location.sourceKind)
          expect(source.watermark).toBe(await sourceFilesDigest(location.root))
          expect((await source.reader.readChunk('maintenance_state', null, 100)).rows).toHaveLength(
            3,
          )
        } finally {
          await source.close()
        }
      }
    } finally {
      backup.close()
    }
  })

  test('live planning keeps one snapshot while the live source advances', async () => {
    await h.install()
    if (h.provider === 'sqlite') h.sqlite.exec('PRAGMA journal_mode=WAL')
    // Commit in WAL mode before opening a read-only snapshot; a mode switch alone has no WAL yet.
    await h.seed()
    const source = await openLiveSnapshotSource(await input())
    try {
      const rows = await source.reader.readChunk('maintenance_state', null, 100)
      await h.native.execute(
        `UPDATE ${h.table('maintenance_state')} SET value='after-live-snapshot' WHERE key='v1-a'`,
      )
      await source.reader.assertUnchanged(source.preflight)
      expect(await source.reader.readChunk('maintenance_state', null, 100)).toEqual(rows)
    } finally {
      await source.close()
    }
  })

  if (h.provider === 'postgresql')
    test('source composition validates never-installed evidence before admitting absent history', async () => {
      await h.install()
      const request = await input()
      const valid: SourceAccessInput = {
        ...request,
        postgresqlArchive: async (source) =>
          epochSourceArchiveInput(source, { bornOnPostgresql: true }),
      }
      const source = await openLiveSnapshotSource(valid)
      try {
        expect(
          source.preflight.expectedAbsent.filter((name) => name.startsWith('code_')),
        ).toHaveLength(6)
        expect(source.watermark).toBe(frozenSourceDetails(source).originalPreflight.watermark)
      } finally {
        await source.close()
      }
      for (const mode of ['live', 'frozen'] as const) {
        const forged: SourceAccessInput = {
          ...request,
          postgresqlArchive: async (source) => {
            const archive = epochSourceArchiveInput(source, { bornOnPostgresql: true })
            if (archive.kind !== 'never-installed') throw new Error('expected provenance')
            return { ...archive, evidence: { ...archive.evidence, sourceWatermark: 'wrong' } }
          },
        }
        await expect(
          mode === 'live' ? openLiveSnapshotSource(forged) : openFrozenSource(forged),
        ).rejects.toThrow('postgresql-never-installed-evidence-mismatch')
      }
    })

  if (h.provider === 'sqlite') {
    test('BF-D20 the observed 0141 shape upgrades offline with recovery rows and retired evidence intact', async () => {
      await installFrozenSqlite(h.sqlite, 141)
      h.sqlite.exec('PRAGMA foreign_keys=OFF')
      h.sqlite.exec(`
      DROP INDEX idx_recovery_events_task;
      DROP INDEX idx_recovery_events_kind;
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
      INSERT INTO recovery_events (
        id, task_id, node_run_id, actor, kind, reason,
        before_json, after_json, created_at
      ) VALUES (
        'recovery-rfc278', 'task-preserved', 'run-preserved', 'startup',
        'task-interrupted', 'sentinel-reason', '{"before":1}', '{"after":2}', 42
      );

      INSERT INTO users (
        id, username, display_name, role, status, force_password_change,
        created_at, updated_at
      ) VALUES ('user-rfc278', 'user-rfc278', 'RFC 278', 'user', 'active', 0, 1, 1);
      INSERT INTO mcps (
        id, name, description, type, config, enabled, owner_user_id,
        visibility, acl_revision, schema_version, created_at, updated_at
      ) VALUES (
        'mcp-rfc278', 'mcp-rfc278', '', 'local', '{"command":["fixture"]}', 1,
        'user-rfc278', 'private', 0, 1, 1, 1
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
      INSERT INTO mcp_runtime_test_create_receipts (
        mcp_id, owner_user_id, client_create_id, request_digest,
        session_id, accepted_turn_id, created_at, expires_at
      ) VALUES (
        'mcp-rfc278', 'user-rfc278', 'old-create', '${'a'.repeat(64)}',
        'old-native-session', 'old-turn', 1, 86400001
      );

      CREATE TABLE recent_repos (
        path text PRIMARY KEY NOT NULL,
        last_used_at integer NOT NULL,
        default_branch text
      );
      INSERT INTO recent_repos (path, last_used_at, default_branch) VALUES
        ('/legacy/a', 1, 'main'),
        ('/legacy/b', 2, 'main'),
        ('/legacy/c', 3, NULL);
    `)
      const recoveryBefore = h.sqlite
        .query("SELECT * FROM recovery_events WHERE id='recovery-rfc278'")
        .get() as Record<string, string | number | null>
      const history = await loadFrozenEpoch1History()
      for (const [tag, hashes] of Object.entries(LEGACY_MIGRATION_HASHES)) {
        const entry = history.sqlite[history.sqliteTags.indexOf(tag)]!
        h.sqlite
          .query('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
          .run(hashes[0]!, entry.folderMillis)
      }
      h.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const original = readFileSync(h.sqlitePath)
      const request = await input()
      const source = await openFrozenSource(request)
      try {
        expect(source.preUpgrade!.preflight.sourceVersion).toBe(
          'sqlite:0141_rfc271_resource_bundle_applies:observed-rfc278',
        )
        expect(source.preUpgrade!.preflight.requiresOfflineUpgrade).toBeTrue()
        expect(source.preflight.contract?.digest).toBe(request.manifest.headDigest)
        expect(
          (await source.reader.readChunk('recovery_events', null, 10)).decodedRows,
        ).toContainEqual(recoveryBefore)
        expect(
          (await source.preUpgrade!.reader.readRawChunk('recent_repos', null, 10)).rows,
        ).toHaveLength(3)
        expect(
          (
            await source.preUpgrade!.reader.readRawChunk(
              'mcp_runtime_test_create_receipts',
              null,
              10,
            )
          ).rows,
        ).toHaveLength(1)
        expect(
          (await source.reader.readChunk('mcp_runtime_test_create_receipts', null, 10)).rows,
        ).toEqual([])
        expect(
          source.preflight.fingerprint.catalog.some((entry) => entry.relation === 'recent_repos'),
        ).toBeFalse()
        expect(
          source.preflight.fingerprint.catalog
            .filter((entry) => entry.kind === 'index' && entry.relation === 'recovery_events')
            .map((entry) => entry.name),
        ).toEqual(expect.arrayContaining(['idx_recovery_events_task', 'idx_recovery_events_kind']))
        const receipts = source.preflight.fingerprint.catalog.filter(
          (entry) => entry.relation === 'mcp_runtime_test_create_receipts',
        )
        expect(
          receipts
            .filter((entry) => entry.kind === 'fk')
            .map((entry) => (JSON.parse(entry.definition) as { table: string }).table)
            .sort(),
        ).toEqual(['mcps', 'users'])
        expect(receipts.find((entry) => entry.kind === 'table')?.definition).toContain(
          'mcp_runtime_test_create_receipts_shape',
        )
        expect(
          receipts.some((entry) => entry.name === 'idx_mcp_runtime_test_create_receipts_expiry'),
        ).toBeTrue()
        await source.reader.assertUnchanged(source.preflight)
      } finally {
        await source.close()
      }
      expect(readFileSync(h.sqlitePath)).toEqual(original)
    })

    for (const through of [1, 120])
      test(`SQLite prefix ${through} upgrades offline and keeps paired pre-upgrade evidence`, async () => {
        await installFrozenSqlite(h.sqlite, through)
        if (through === 1)
          h.sqlite.exec("INSERT INTO recent_repos VALUES ('kept',9007199254740993,NULL)")
        const request = await input()
        const source = await openFrozenSource(request)
        const evidenceRoot = source.evidenceRoot!
        const before = source.preUpgrade!.preflight
        const expected = {
          watermark: source.watermark,
          preUpgradeWatermark: before.watermark,
          sourceGenerationId: source.preflight.sourceGenerationId,
        }
        expect(source.preflight.contract?.digest).toBe(request.manifest.headDigest)
        expect(before.requiresOfflineUpgrade).toBe(true)
        expect(readFileSync(join(evidenceRoot, 'preflight.json'), 'utf8')).toContain(
          before.watermark,
        )
        if (through === 1)
          expect(
            (await source.preUpgrade!.reader.readRawChunk('recent_repos', null, 10)).rows[0]?.cells
              .last_used_at?.value,
          ).toEqual({ type: 'integer', value: '9007199254740993' })
        await source.close()
        expect(existsSync(evidenceRoot)).toBe(true)
        const again = await openFrozenSource({ ...request, expected })
        expect(again.preUpgrade!.preflight).toEqual(before)
        await again.close()
      })

    test('pointer-less live/frozen sources keep the epoch-1 generation while numeric content advances', async () => {
      await h.install()
      await h.seed()
      const request = await input()
      const live = await openLiveSnapshotSource(request)
      expect(live.preflight.sourceGenerationId).toBe('dbg_legacy_sqlite')
      const oldWatermark = live.watermark
      await live.close()
      await h.native.execute(
        `UPDATE ${h.table('maintenance_state')} SET value='advanced' WHERE key='v1-a'`,
      )
      const frozen = await openFrozenSource(request)
      try {
        expect(frozen.preflight.sourceGenerationId).toBe('dbg_legacy_sqlite')
        expect(frozen.watermark).not.toBe(oldWatermark)
      } finally {
        await frozen.close()
      }
    })
    test('owned crash copies and torn pre-binding temp files are removed; committed evidence is retained', async () => {
      await installFrozenSqlite(h.sqlite, 1)
      const request = await input()
      const work = join(request.operationRoot, 'source-access')
      for (const name of [
        'epoch1-source-old',
        'plan-snapshot-old',
        'epoch1-upgrade-old',
        'epoch1-pg-upgrade-old',
      ])
        mkdirSync(join(work, name), { recursive: true })
      mkdirSync(join(work, 'upgrade/copy-orphan'), { recursive: true })
      writeFileSync(join(work, 'upgrade/binding.json.crashed.tmp'), '{')
      const source = await openFrozenSource(request)
      const evidence = source.evidenceRoot!
      await source.close()
      expect(readdirSync(work).filter((name) => /^(epoch1-|plan-snapshot-)/.test(name))).toEqual([])
      expect(existsSync(join(work, 'upgrade/copy-orphan'))).toBe(false)
      expect(existsSync(join(work, 'upgrade/binding.json.crashed.tmp'))).toBe(false)
      expect(existsSync(evidence)).toBe(true)
      const binding = JSON.parse(readFileSync(join(work, 'upgrade/binding.json'), 'utf8'))
      expect(binding.directory.startsWith('copy-')).toBe(true)
      expect(binding.sqlitePath.startsWith('/')).toBe(false)
    })
    test('upgrade binding and pre-upgrade evidence re-materialise under a fresh Job root', async () => {
      await installFrozenSqlite(h.sqlite, 1)
      const request = await input()
      const durable = createLocalSourceArtifacts(join(h.operationRoot, 'durable'))
      const references = new Map<string, string>()
      const job1 = join(h.operationRoot, 'job1')
      const job2 = join(h.operationRoot, 'job2')
      const port = (root: string): EpochSwitchArtifactPort => ({
        async put(name, bytes) {
          const digest = await durable.put(name, bytes)
          references.set(name, digest)
          return digest
        },
        async get(name, digest) {
          const path = await durable.get(name, digest)
          const local = join(root, name)
          await atomicSourceFile(local, readFileSync(path))
          return local
        },
      })
      const first = await openLiveSnapshotSource({
        ...request,
        operationRoot: job1,
        artifacts: port(job1),
      })
      const expected = {
        watermark: first.watermark,
        preUpgradeWatermark: first.preUpgrade!.preflight.watermark,
        sourceGenerationId: first.preflight.sourceGenerationId,
      }
      await first.close()
      expect([...references.keys()].some((name) => name.endsWith('/binding.json'))).toBe(true)
      expect([...references.keys()].some((name) => name.includes('/pre-upgrade/'))).toBe(true)
      rmSync(job1, { recursive: true, force: true })
      const restoredPort = port(job2)
      for (const [name, digest] of [...references]) await restoredPort.get(name, digest)
      const second = await openFrozenSource({
        ...request,
        operationRoot: job2,
        artifacts: restoredPort,
        expected,
      })
      try {
        expect(second.watermark).toBe(expected.watermark)
        expect(second.evidenceRoot!.startsWith(job2)).toBe(true)
      } finally {
        await second.close()
      }
    })
    test('discovery snapshot remains readable while another process commits WAL writes', async () => {
      await h.install()
      await h.seed()
      h.sqlite.exec('PRAGMA journal_mode=WAL')
      const script = `import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); db.exec('PRAGMA busy_timeout=30000'); for(let n=0;n<200;n++){db.query("UPDATE maintenance_state SET value=? WHERE key='v1-a'").run(String(n)); if(n===0)console.log('writing'); await Bun.sleep(2)} db.close()`
      const writer = Bun.spawn([process.execPath, '-e', script, h.sqlitePath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = writer.stdout.getReader()
      await stdout.read()
      stdout.releaseLock()
      try {
        const source = await openLiveSnapshotSource(await input())
        try {
          const first = await source.reader.readChunk('maintenance_state', null, 100)
          expect(await writer.exited).toBe(0)
          await source.reader.assertUnchanged(source.preflight)
          expect(await source.reader.readChunk('maintenance_state', null, 100)).toEqual(first)
        } finally {
          await source.close()
        }
      } finally {
        writer.kill()
        await writer.exited
      }
    })

    test('restart in a subprocess sees the same watermark and removes only leftover reader copies', async () => {
      await h.install()
      const request = await input()
      const source = await openFrozenSource(request)
      const expected = {
        watermark: source.watermark,
        preUpgradeWatermark: null,
        sourceGenerationId: source.preflight.sourceGenerationId,
      }
      await source.close()
      const leftover = join(request.operationRoot, 'frozen/source-access/epoch1-source-crashed')
      const retained = join(request.operationRoot, 'frozen/source-access/retained-evidence')
      mkdirSync(leftover, { recursive: true })
      mkdirSync(retained, { recursive: true })
      const script = `import {openFrozenSource} from ${JSON.stringify(resolve(import.meta.dirname, '../src/platform/persistence/migration/freeze/sourceAccess.ts'))}; import {loadSupportedSourceManifest} from ${JSON.stringify(resolve(import.meta.dirname, '../src/platform/persistence/migration/supportedSources.ts'))}; const input=JSON.parse(process.argv[1]); const h=await openFrozenSource({...input,manifest:await loadSupportedSourceManifest()}); console.log(h.watermark); await h.close()`
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          script,
          JSON.stringify({
            location: request.location,
            operationRoot: request.operationRoot,
            emptyTables: [],
            expected,
          }),
        ],
        { cwd: resolve(import.meta.dirname, '..'), stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      expect(stdout.trim()).toBe(expected.watermark)
      expect(existsSync(leftover)).toBe(false)
      expect(existsSync(retained)).toBe(true)
    })
  }
})

describeV3Providers('RFC-395 V3 PostgreSQL scratch upgrade', (h) => {
  if (h.sourceProvider !== 'postgresql') return
  test('one operator scratch resets a partial copy on retry and re-copies an advanced live source', async () => {
    await h.source.install('pre-seq')
    await h.source.sourceHarness.seed()
    const sourceRuntime = h.source.sourceHarness.runtime
    let fail = true
    const pool = h.runtime.providerPool()
    // Construct the production runtime over a real Bun.SQL pool. Only the single
    // failure is injected; all successful SQL and transaction methods stay native.
    let injected = 0
    let reserved = 0
    const runtime = h.createTargetRuntime((options) => {
      const native = new SQL(options.url, {
        max: options.max,
        idleTimeout: options.idleTimeout,
        connectionTimeout: options.connectionTimeout,
      }) as unknown as PostgresqlPool
      return {
        async reserve(options) {
          const connection = await native.reserve(options)
          reserved++
          return new Proxy(connection, {
            get(target, key) {
              if (key === 'unsafe')
                return (query: string, values?: readonly unknown[]) => {
                  if (
                    fail &&
                    query.startsWith('INSERT INTO "agent_workflow"."maintenance_state"')
                  ) {
                    fail = false
                    injected++
                    throw new Error('injected-partial-copy')
                  }
                  return target.unsafe(query, values)
                }
              const value = Reflect.get(target, key)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
        unsafe: (query, values) => native.unsafe(query, values),
        close: (options) => native.close(options),
      }
    })
    const scratch = async () => ({ runtime, async close() {} })
    const store = createLocalSourceArtifacts(join(h.operationRoot, 'durable'))
    const references = new Map<string, string>()
    const port = (root: string): EpochSwitchArtifactPort => ({
      async put(name, bytes) {
        const digest = await store.put(name, bytes)
        references.set(name, digest)
        return digest
      },
      async get(name, digest) {
        const path = await store.get(name, digest)
        const local = join(root, name)
        await atomicSourceFile(local, readFileSync(path))
        return local
      },
    })
    const job1 = join(h.operationRoot, 'job1')
    const job2 = join(h.operationRoot, 'job2')
    const request: SourceAccessInput = {
      location: { kind: 'postgresql-database', profileRef: 'env:V3_SOURCE' },
      operationRoot: job1,
      artifacts: port(job1),
      emptyTables: [],
      manifest: await h.source.sourceHarness.manifest(),
      postgresql: () => sourceRuntime,
      createScratchPostgresql: scratch,
      reopenScratchPostgresql: scratch,
    }
    try {
      await expect(openLiveSnapshotSource(request)).rejects.toThrow('injected-partial-copy')
      expect(injected).toBe(1)
      expect(reserved).toBeGreaterThan(0)
      expect(
        (await pool.unsafe("SELECT to_regclass('agent_workflow.maintenance_state') AS name"))[0]!
          .name,
      ).not.toBeNull()
      rmSync(job1, { recursive: true, force: true })
      const artifacts = port(job2)
      for (const [name, digest] of [...references]) await artifacts.get(name, digest)
      const retry = { ...request, operationRoot: job2, artifacts }
      const planned = await openLiveSnapshotSource(retry)
      const firstWatermark = planned.watermark
      await planned.close()
      await expect(
        openLiveSnapshotSource({
          ...request,
          artifacts: undefined,
          operationRoot: join(h.operationRoot, 'other-operation'),
        }),
      ).rejects.toThrow('postgresql-scratch-owned-by-another-operation')
      await h.source.sourceHarness.native.execute(
        `UPDATE ${h.source.sourceHarness.table('maintenance_state')} SET value='advanced' WHERE key='v1-a'`,
      )
      const refreshed = await openLiveSnapshotSource(retry)
      expect(refreshed.watermark).not.toBe(firstWatermark)
      const expected = {
        watermark: refreshed.watermark,
        preUpgradeWatermark: refreshed.preUpgrade!.preflight.watermark,
        sourceGenerationId: refreshed.preflight.sourceGenerationId,
      }
      await refreshed.close()
      const frozen = await openFrozenSource({ ...retry, expected })
      try {
        expect(
          (await frozen.reader.readChunk('maintenance_state', null, 10)).decodedRows.find(
            (row) => row.key === 'v1-a',
          )?.value,
        ).toBe('advanced')
      } finally {
        await frozen.close()
      }
    } finally {
      await runtime.close()
      await pool.unsafe('DROP TABLE IF EXISTS public.aw_epoch1_upgrade_scratch')
    }
  })
  test('upgrading a logical backup preserves its source kind and provider in the exposed preflight', async () => {
    const version = await h.source.install('pre-seq')
    const backup = await h.source.sourceHarness.backup(version)
    const scratch = async () => ({ runtime: h.runtime, async close() {} })
    try {
      const source = await openFrozenSource({
        location: {
          kind: 'backup',
          sourceKind: 'logical-backup',
          artifact: backup.root,
          root: backup.root,
        },
        manifest: await h.source.sourceHarness.manifest(),
        operationRoot: h.operationRoot,
        emptyTables: [],
        createScratchPostgresql: scratch,
        reopenScratchPostgresql: scratch,
      })
      try {
        expect(source.reader.kind).toBe('logical-backup')
        expect(source.preflight.kind).toBe('logical-backup')
        expect(source.preflight.fingerprint.provider).toBe(h.sourceProvider)
        expect(source.preUpgrade!.preflight.kind).toBe('logical-backup')
        expect(frozenSourceDetails(source).originalPreflight.kind).toBe('logical-backup')
      } finally {
        await source.close()
      }
    } finally {
      backup.close()
      await h.runtime.providerPool().unsafe('DROP TABLE IF EXISTS public.aw_epoch1_upgrade_scratch')
    }
  })
  test('an older PostgreSQL source requires scratch, retains original evidence and reopens the same upgrade', async () => {
    await h.source.install('pre-seq')
    await h.source.sourceHarness.seed()
    const major = (await h.catalog()).postgresqlMajor
    const sourceRuntime = h.source.sourceHarness.runtime
    const sourceFingerprint = (await sourceRuntime.readiness()).databaseFingerprint
    const scratch = async (requireEmpty: boolean) => {
      // The harness owns the database lifetime; production closes only the pool.
      await openPostgresqlScratch({
        runtime: h.runtime,
        sourceFingerprint,
        supportedMajors: [major],
        profileRef: 'env:V3_SCRATCH',
        requireEmpty,
      })
      return { runtime: h.runtime, async close() {} }
    }
    const request: SourceAccessInput = {
      location: { kind: 'postgresql-database', profileRef: 'env:V3_SOURCE' },
      operationRoot: h.operationRoot,
      emptyTables: [],
      manifest: await h.source.sourceHarness.manifest(),
      postgresql: () => sourceRuntime,
    }
    await expect(openFrozenSource(request)).rejects.toThrow('postgresql-scratch-required')
    const options = {
      ...request,
      createScratchPostgresql: () => scratch(true),
      reopenScratchPostgresql: () => scratch(false),
    }
    try {
      const planned = await openLiveSnapshotSource(request)
      expect(planned.preflight.requiresOfflineUpgrade).toBe(true)
      await planned.close()
      const source = await openLiveSnapshotSource(options)
      const expected = {
        watermark: source.watermark,
        preUpgradeWatermark: source.preUpgrade!.preflight.watermark,
        sourceGenerationId: source.preflight.sourceGenerationId,
      }
      expect(frozenSourceDetails(source).databaseFingerprint).toBe(sourceFingerprint)
      expect(source.preUpgrade!.preflight.identityHighWater).toEqual(
        frozenSourceDetails(source).originalPreflight.identityHighWater,
      )
      await source.close()
      const reopened = await openFrozenSource({ ...options, expected })
      expect((await reopened.reader.readChunk('maintenance_state', null, 10)).rows).toHaveLength(3)
      await reopened.close()
    } finally {
      await h.runtime.providerPool().unsafe('DROP TABLE IF EXISTS public.aw_epoch1_upgrade_scratch')
    }
  })
})

for (const [message, category] of [
  ['postgresql-target-not-empty', 'scratch-required'],
  ['postgresql-scratch-not-empty', 'scratch-required'],
  ['Offline copy differs from the planned source fingerprint', 'source-changed'],
  ['Backup changed during preflight', 'source-changed'],
  ['unknown source catalog', 'source-blocked'],
] as const)
  test(`source adapter classifies ${message}`, async () => {
    const adapter = createEpochSourceAdapter({
      async resolve() {
        throw new Error(message)
      },
    })
    await expect(
      adapter.discover({
        location: { kind: 'postgresql-database', profileRef: 'env:SOURCE' },
        emptyTables: [],
        operationRoot: '/unused',
      }),
    ).rejects.toMatchObject({ category })
  })

describeV3CrossProvider('RFC-395 V3 upgraded SQLite-origin logical artifact', (h) => {
  test('PostgreSQL scratch does not change the original source provider or artifact kind', async () => {
    const version = await h.source.install('pre-seq')
    const backup = await h.source.sourceHarness.backup(version)
    const scratch = async () => ({ runtime: h.runtime, async close() {} })
    try {
      // This fixture starts on SQLite but upgrades a logical copy on PostgreSQL.
      // Its admission manifest must describe both physical engines. Compile the
      // frozen PG plans while the owned scratch is still empty (DDL rolls back).
      const manifest = await loadSupportedSourceManifest({
        async postgresqlCatalog(version) {
          const reference = await h.runtime.providerPool().reserve()
          try {
            return await compileEpoch1PostgresqlCatalog(reference, version)
          } finally {
            reference.release()
          }
        },
      })
      const request: SourceAccessInput = {
        location: {
          kind: 'backup',
          sourceKind: 'logical-artifact',
          artifact: backup.artifactRoot,
          root: backup.artifactRoot,
        },
        operationRoot: h.operationRoot,
        emptyTables: [],
        manifest,
        createScratchPostgresql: scratch,
        reopenScratchPostgresql: scratch,
      }
      const source = await openFrozenSource(request)
      const expected = {
        watermark: source.watermark,
        preUpgradeWatermark: source.preUpgrade!.preflight.watermark,
        sourceGenerationId: source.preflight.sourceGenerationId,
      }
      try {
        expect(source.reader.kind).toBe('logical-artifact')
        expect(source.preflight.kind).toBe('logical-artifact')
        expect(source.preflight.fingerprint.provider).toBe('sqlite')
        expect(source.preUpgrade!.preflight.fingerprint.provider).toBe('sqlite')
        await source.reader.assertUnchanged(source.preflight)
      } finally {
        await source.close()
      }
      const reopened = await openFrozenSource({ ...request, expected })
      try {
        expect(reopened.preflight.kind).toBe('logical-artifact')
        expect(reopened.preflight.fingerprint.provider).toBe('sqlite')
        expect(reopened.watermark).toBe(expected.watermark)
        await reopened.reader.assertUnchanged(reopened.preflight)
      } finally {
        await reopened.close()
      }
    } finally {
      backup.close()
      await h.runtime.providerPool().unsafe('DROP TABLE IF EXISTS public.aw_epoch1_upgrade_scratch')
    }
  })
})
