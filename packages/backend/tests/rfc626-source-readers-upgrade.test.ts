// RFC-626 §4.1 / §3.3 / §4.1 last paragraph, against real databases (the V1 harness skips a
// provider that is not configured, as every RFC-395 / RFC-398 source suite does).
//
// Why these tests exist:
//   - PostgreSQL: "has the source changed?" restarted the snapshot and digested the whole
//     database every time (60–90 s, ~63 times per upgrade). Now the identity is measured once
//     per process; equal cheap evidence (row counts, sequence values) adopts it, moved evidence
//     measures again and only a different identity is reported as a change.
//   - PostgreSQL: JSON text that is not JSON and NaN / ±Infinity in a real column ended the
//     automatic upgrade in the copy to scratch and in the backup; under the transport rule they
//     travel through both (and the backup is read back under the rule its manifest records),
//     to be set aside by the conversion. A manual upgrade still refuses them.
//   - PostgreSQL: the automatic upgrade's scratch copy is not held to the business oracle — an
//     aggregate head without events (417 such rows in the reference data) used to end it.
//   - PostgreSQL: the scratch copy's identity measured while planning is adopted when the
//     execution step of the same process takes the copy over (implementation gate G3-3).
//   - SQLite: rows whose foreign key dangles after the remaining migrations are tolerated by the
//     automatic upgrade and still refused by the manual one; the offline upgrade no longer
//     captures the disposition rows a second time nor preflights a reader nobody reads.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describeV1Providers, type V1Harness } from './helpers/rfc395V1Harness'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  upgradeEpoch1Copy,
  type OfflinePostgresqlDatabase,
} from '@/platform/persistence/migration/offlineSourceUpgrade'
import { openEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceReader'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { exportEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceExport'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import {
  writeManifest,
  type BackupManifestV2,
} from '@/platform/persistence/migration/legacy/backupManifest'
import {
  createSourceWatch,
  type SourceWatch,
} from '@/platform/persistence/migration/freeze/sourceWatch'
import {
  openFrozenSource,
  type SourceAccessInput,
  type SourceExpected,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  SourceBlockedError,
  type SourceMeasurementObserver,
} from '@/platform/persistence/migration/sourceTypes'

async function createOffline(h: V1Harness): Promise<OfflinePostgresqlDatabase> {
  const name = `rfc626_offline_${crypto.randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!)
  url.pathname = `/${name}`
  await h.pool.unsafe(`CREATE DATABASE "${name}"`)
  const runtime = createPostgresqlDatabaseRuntime({
    generationId: 'dbg_rfc626_offline_copy',
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC626_OFFLINE_URL',
      poolMax: 2,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 120_000,
      idleTimeoutMs: 120_000,
    },
    env: { RFC626_OFFLINE_URL: url.toString() },
  })
  return {
    runtime,
    async close() {
      await runtime.close()
      await h.pool.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    },
  }
}
/** Values the physical columns hold and the strict value rule refuses. */
const REFUSED = [
  ['rfc626-rt-inf', 'Infinity', '[]'],
  ['rfc626-rt-nan', 'NaN', 'not json'],
  ['rfc626-rt-ninf', '-Infinity', '{'],
] as const
async function seedRefusedRuntimes(h: V1Harness): Promise<void> {
  for (const [id, temperature, extra] of REFUSED)
    await h.native.execute(
      `INSERT INTO ${h.table('runtimes')} (id, name, protocol, temperature, extra_args_json) VALUES ($1, $2, 'opencode', $3::double precision, $4)`,
      [id, `rfc626 ${id}`, temperature, extra],
    )
}
function backupManifest(
  receipt: Awaited<ReturnType<typeof exportEpoch1PostgresqlSource>>,
  valueRule?: 'transport',
): BackupManifestV2 {
  return {
    manifestVersion: 2,
    kind: 'pre-migration',
    createdAt: 123,
    appVersion: 'rfc626-source-readers',
    includesWorktrees: false,
    migration: { lastHash: null, lastCreatedAt: null },
    database: {
      format: 'agent-workflow-logical-database-v1',
      provider: 'postgresql',
      sourceGenerationId: receipt.envelope.payload.sourceGenerationId,
      schemaDigest: receipt.envelope.payload.schemaDigest,
      logicalPath: 'database/logical',
      envelopeFileDigest: receipt.envelopeFileDigest,
      rawSqlitePath: null,
      ...(valueRule ? { valueRule } : {}),
    },
  }
}
const bornHosted = { kind: 'born-hosted' as const, async assertProvenance() {} }
/** Every file under `root`, keyed by its `/`-separated relative path. */
function filesOf(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
    else files.set(relative(root, path).split(sep).join('/'), readFileSync(path).toString('base64'))
  }
  visit(root)
  return files
}

describeV1Providers('RFC-626 source readers and the offline upgrade', (h) => {
  if (h.provider === 'postgresql') {
    test('the content identity is measured once and adopted while the cheap evidence holds', async () => {
      await h.install()
      await h.seed()
      const manifest = await h.manifest()
      const watch = createSourceWatch()
      // RFC-626 §7: every reader of this case counts its whole-database digests here.
      let digests = 0
      const onMeasure: SourceMeasurementObserver = (kind) => {
        if (kind === 'postgresql-content') digests += 1
      }
      let forget = false
      const forgetful: SourceWatch = {
        ...watch,
        baseline: (key) => (forget ? undefined : watch.baseline(key)),
      }
      const open = (borrowed?: SourceWatch) =>
        openEpoch1PostgresqlSource({
          runtime: h.runtime,
          manifest,
          contentRoot: h.operationRoot,
          onMeasure,
          ...(borrowed ? { watch: borrowed } : {}),
        })
      // The fixture pool has two connections and every open reader holds one: at most one
      // other reader is open next to `first`, and none while the fixture itself writes.
      const during = async <T>(
        reader: ReturnType<typeof open>,
        body: () => Promise<T>,
      ): Promise<T> => {
        try {
          return await body()
        } finally {
          await reader.close()
        }
      }
      const first = open(watch)
      try {
        const measured = () => digests
        const plan = await first.preflight()
        expect(measured()).toBe(1)
        await first.assertUnchanged(plan)
        expect(await first.preflight()).toBe(plan)
        expect(measured()).toBe(1)

        // Another handle on the same database borrowing the same watch adopts the identity.
        const second = open(watch)
        await during(second, async () => {
          const adopted = await second.preflight()
          expect(adopted.watermark).toBe(plan.watermark)
          expect(adopted.sourceGenerationId).toBe(plan.sourceGenerationId)
          expect(adopted.fingerprint.digest).toBe(plan.fingerprint.digest)
          await second.assertUnchanged(adopted)
        })
        expect(measured()).toBe(1)

        // Without a watch the baseline lives only in that reader.
        const alone = open()
        await during(alone, async () => {
          expect((await alone.preflight()).watermark).toBe(plan.watermark)
        })
        expect(measured()).toBe(2)

        // Evidence the reader cannot vouch for is measured again; the same identity continues.
        const refreshed = open(forgetful)
        await during(refreshed, async () => {
          const refreshedPlan = await refreshed.preflight()
          expect(measured()).toBe(2)
          forget = true
          await refreshed.assertUnchanged(refreshedPlan)
          forget = false
        })
        expect(measured()).toBe(3)

        // A committed change moves the evidence: measured again, reported as a change.
        await h.native.execute(
          `INSERT INTO ${h.table('maintenance_state')} (key,value,updated_at) VALUES ($1,$2,$3)`,
          ['rfc626-new', '{ "added": true }', 456],
        )
        await expect(first.assertUnchanged(plan)).rejects.toThrow('changed after preflight')
        expect(measured()).toBe(4)

        // That measurement is the shared baseline now: the next handle adopts the new identity
        // without measuring the database again.
        const third = open(watch)
        await during(third, async () => {
          expect((await third.preflight()).watermark).not.toBe(plan.watermark)
        })
        expect(measured()).toBe(4)
      } finally {
        await first.close()
        watch.close()
      }
    }, 300_000)

    test('the transport read moves NaN, ±Infinity and invalid JSON text; strict reads refuse them', async () => {
      await h.install()
      await h.seed()
      await seedRefusedRuntimes(h)
      const manifest = await h.manifest()
      const strict = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
      })
      const automatic = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
        resolution: 'automatic',
      })
      try {
        const preflight = await automatic.preflight()
        await strict.preflight()
        const runtimes = preflight.contract!.tables.find((table) => table.id === 'runtimes')!
        const at = (name: string) => runtimes.columns.findIndex((column) => column.name === name)
        await expect(strict.readChunk('runtimes', null, 10)).rejects.toBeInstanceOf(
          SourceBlockedError,
        )
        // The conversion still reads strictly through an automatic reader.
        await expect(automatic.readChunk('runtimes', null, 10)).rejects.toBeInstanceOf(
          SourceBlockedError,
        )
        await expect(strict.readTransportChunk('runtimes', null, 10)).rejects.toBeInstanceOf(
          SourceBlockedError,
        )
        const moved = await automatic.readTransportChunk('runtimes', null, 10)
        const byId = new Map(
          moved.rows.map((row) => [JSON.stringify(row.values[at('id')]), row.values] as const),
        )
        for (const [id, temperature, extra] of REFUSED) {
          const values = byId.get(JSON.stringify({ type: 'text', value: id }))!
          expect(values[at('temperature')]).toEqual({ type: 'real', value: temperature })
          expect(values[at('extra_args_json')]).toEqual({ type: 'text', value: extra })
        }
        // Paging keeps the order guard and the cursor of the strict read.
        const page = await automatic.readTransportChunk('runtimes', null, 1)
        const rest = await automatic.readTransportChunk('runtimes', page.lastKey, 10)
        expect([...page.rows, ...rest.rows]).toEqual([...moved.rows])
        // Rows the strict rule accepts come out exactly as the strict read gives them.
        const strictRows = await automatic.readChunk('maintenance_state', null, 10)
        const transportRows = await automatic.readTransportChunk('maintenance_state', null, 10)
        expect(transportRows.rows).toEqual(strictRows.rows)
        expect(transportRows.lastKey).toEqual(strictRows.lastKey)
      } finally {
        await strict.close()
        await automatic.close()
      }
    }, 300_000)

    test('the automatic backup carries refused values and is read back under its recorded rule', async () => {
      await h.install()
      await h.seed()
      await seedRefusedRuntimes(h)
      const manifest = await h.manifest()
      const strict = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
      })
      const automatic = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
        resolution: 'automatic',
      })
      const root = mkdtempSync(join(h.operationRoot, 'rfc626-backup-'))
      const artifactRoot = join(root, 'database/logical')
      try {
        await expect(
          exportEpoch1PostgresqlSource({
            source: strict,
            artifactRoot: join(h.operationRoot, 'rfc626-strict-export'),
            operationId: 'dbm_rfc626_strict_export',
            chunkRows: 2,
            emptyArchive: bornHosted,
          }),
        ).rejects.toThrow()
        const receipt = await exportEpoch1PostgresqlSource({
          source: automatic,
          artifactRoot,
          operationId: 'dbm_rfc626_automatic_export',
          chunkRows: 2,
          emptyArchive: bornHosted,
          resolution: 'automatic',
        })
        expect(receipt.valueRule).toBe('transport')
        const open = () =>
          openEpoch1LogicalArtifactSource({
            artifactRoot,
            backupRoot: root,
            envelopeFileDigest: receipt.envelopeFileDigest,
            supportedSources: manifest,
          })
        writeManifest(root, backupManifest(receipt, 'transport'))
        const backup = open()
        try {
          const preflight = await backup.preflight()
          expect(preflight.kind).toBe('logical-backup')
          const raw = await backup.readRawChunk('runtimes', null, 10)
          expect(raw.rows).toHaveLength(REFUSED.length)
          const text = JSON.stringify(raw.rows)
          for (const [, temperature, extra] of REFUSED) {
            expect(text).toContain(`"value":"${temperature}"`)
            expect(text).toContain(JSON.stringify({ type: 'text', value: extra }))
          }
        } finally {
          await backup.close()
        }
        // Without the recorded rule the same backup is read strictly, and refused.
        writeManifest(root, backupManifest(receipt))
        const strictBackup = open()
        try {
          await expect(strictBackup.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
        } finally {
          await strictBackup.close()
        }
      } finally {
        await strict.close()
        await automatic.close()
      }
      // A database both rules accept: the manual export records the strict rule, and the
      // automatic export writes the same chunk and evidence files byte for byte. Only the
      // files that carry creation times differ. (One reader at a time: each holds one of the
      // fixture pool's two connections.)
      await h.native.execute(`DELETE FROM ${h.table('runtimes')} WHERE id LIKE 'rfc626-rt-%'`)
      const exported = async (resolution: 'automatic' | undefined, directory: string) => {
        const reader = openEpoch1PostgresqlSource({
          runtime: h.runtime,
          manifest,
          contentRoot: h.operationRoot,
          ...(resolution ? { resolution } : {}),
        })
        try {
          return await exportEpoch1PostgresqlSource({
            source: reader,
            artifactRoot: join(h.operationRoot, directory),
            operationId: 'dbm_rfc626_accepted_export',
            chunkRows: 2,
            emptyArchive: bornHosted,
            ...(resolution ? { resolution } : {}),
          })
        } finally {
          await reader.close()
        }
      }
      const manual = await exported(undefined, 'rfc626-manual-export')
      const transport = await exported('automatic', 'rfc626-transport-export')
      expect(manual.valueRule).toBe('strict')
      expect(transport.valueRule).toBe('transport')
      expect(transport.manifest.payload.tables).toEqual(manual.manifest.payload.tables)
      const timed = new Set([
        'logical-manifest.json',
        'logical-backup.json',
        'source-evidence/binding.json',
      ])
      const files = (directory: string) =>
        new Map([...filesOf(join(h.operationRoot, directory))].filter(([path]) => !timed.has(path)))
      const manualFiles = files('rfc626-manual-export')
      expect(
        [...manualFiles.keys()].some((path) => path.startsWith('chunks/maintenance_state/')),
      ).toBe(true)
      expect(files('rfc626-transport-export')).toEqual(manualFiles)
    }, 300_000)

    test('the automatic copy to scratch carries refused values; the manual copy refuses them', async () => {
      await h.install('pre-seq')
      const manifest = await h.manifest()
      const probe = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
      })
      try {
        const columns = (await probe.preflight())
          .contract!.tables.find((table) => table.id === 'runtimes')!
          .columns.map((column) => column.name)
        expect(columns).toEqual(expect.arrayContaining(['temperature', 'extra_args_json']))
      } finally {
        await probe.close()
      }
      await seedRefusedRuntimes(h)
      // One reader at a time: each holds one of the fixture pool's two connections, and the
      // scratch database is created through the other.
      const strict = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
      })
      try {
        await expect(
          upgradeEpoch1Copy({
            source: strict,
            manifest,
            operationRoot: h.operationRoot,
            createEmptyDatabase: () => createOffline(h),
          }),
        ).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await strict.close()
      }
      const automatic = openEpoch1PostgresqlSource({
        runtime: h.runtime,
        manifest,
        contentRoot: h.operationRoot,
        resolution: 'automatic',
      })
      try {
        expect((await automatic.preflight()).requiresOfflineUpgrade).toBe(true)
        const copy = await upgradeEpoch1Copy({
          source: automatic,
          manifest,
          operationRoot: h.operationRoot,
          resolution: 'automatic',
          createEmptyDatabase: () => createOffline(h),
        })
        try {
          expect('sourceEvidence' in copy).toBe(false)
          const work = readdirSync(h.operationRoot).filter((name) =>
            name.startsWith('epoch1-pg-upgrade-'),
          )
          expect(work).toHaveLength(1)
          expect(existsSync(join(h.operationRoot, work[0]!, 'pre-upgrade'))).toBe(false)
          const after = await copy.reader.preflight()
          expect(after.contract?.digest).toBe(manifest.headDigest)
          // The conversion reads the scratch strictly and takes its raw channel for these rows.
          await expect(copy.reader.readChunk('runtimes', null, 10)).rejects.toBeInstanceOf(
            SourceBlockedError,
          )
          const raw = JSON.stringify((await copy.reader.readRawChunk('runtimes', null, 10)).rows)
          for (const [id, temperature, extra] of REFUSED) {
            expect(raw).toContain(id)
            expect(raw).toContain(`"value":"${temperature}"`)
            expect(raw).toContain(JSON.stringify({ type: 'text', value: extra }))
          }
        } finally {
          await copy.close()
        }
      } finally {
        await automatic.close()
      }
    }, 300_000)

    // RFC-626 implementation gate G3-3: the scratch copy's reader of the planning step borrowed no
    // watch, so the execution step of the same process, reopening the copy under the watch scoped
    // to it, found no baseline and read the whole scratch database again (about a minute on the
    // reference data). Planning now remembers the copy's identity in that same scope.
    test('the scratch copy measured while planning is adopted by the execution step of the same process', async () => {
      await h.install('pre-seq')
      await h.seed()
      const manifest = await h.manifest()
      const watch = createSourceWatch()
      let digests = 0
      const onMeasure: SourceMeasurementObserver = (kind) => {
        if (kind === 'postgresql-content') digests += 1
      }
      // One scratch database for both steps, as the automatic upgrade provisions it.
      const scratch = await createOffline(h)
      const borrowed: OfflinePostgresqlDatabase = { runtime: scratch.runtime, async close() {} }
      const request: SourceAccessInput = {
        location: { kind: 'postgresql-database', profileRef: 'env:RFC626_SOURCE' },
        operationRoot: join(h.operationRoot, 'access'),
        emptyTables: [],
        manifest,
        postgresql: () => h.runtime,
        resolution: 'automatic',
        watch,
        onMeasure,
        createScratchPostgresql: async () => borrowed,
        reopenScratchPostgresql: async () => borrowed,
      }
      try {
        const planned = await openFrozenSource(request)
        let expected!: SourceExpected
        try {
          expect(planned.preflight.contract?.digest).toBe(manifest.headDigest)
          expected = {
            watermark: planned.watermark,
            preUpgradeWatermark: planned.preUpgrade!.preflight.watermark,
            sourceGenerationId: planned.preflight.sourceGenerationId,
          }
        } finally {
          await planned.close()
        }
        // Planning measured the old database and the scratch copy, once each.
        expect(digests).toBe(2)
        const executed = await openFrozenSource({ ...request, expected })
        try {
          expect(executed.watermark).toBe(expected.watermark)
          expect(
            (await executed.reader.readChunk('maintenance_state', null, 10)).decodedRows,
          ).toHaveLength(3)
          await executed.reader.assertUnchanged(executed.preflight)
        } finally {
          await executed.close()
        }
        // Taking the copy over read neither database again.
        expect(digests).toBe(2)
      } finally {
        watch.close()
        await scratch.close()
      }
    }, 300_000)

    test('an aggregate head without events fails only the manual copy to scratch', async () => {
      await h.install('pre-seq')
      const manifest = await h.manifest()
      const source = await h.source()
      const before = await source.preflight()
      expect(
        before.contract!.tables.some((table) => table.id === 'committed_event_aggregate_heads'),
      ).toBe(true)
      // Its snapshot predates the write below, and it holds a connection the copy needs.
      await source.close()
      await h.native.execute(
        `INSERT INTO ${h.table('committed_event_aggregate_heads')} (producer, family, aggregate_kind, aggregate_id, last_seq, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        ['task-execution', 'task-lifecycle', 'task', 'rfc626-head-without-events', 3, 123],
      )
      const changed = await h.source()
      await expect(
        upgradeEpoch1Copy({
          source: changed,
          manifest,
          operationRoot: h.operationRoot,
          createEmptyDatabase: () => createOffline(h),
        }),
      ).rejects.toThrow('committed-event-head')
      const copy = await upgradeEpoch1Copy({
        source: changed,
        manifest,
        operationRoot: h.operationRoot,
        resolution: 'automatic',
        createEmptyDatabase: () => createOffline(h),
      })
      try {
        const after = await copy.reader.preflight()
        expect(after.contract?.digest).toBe(manifest.headDigest)
        expect(after.fingerprint.tableRows['agent_workflow.committed_event_aggregate_heads']).toBe(
          1,
        )
      } finally {
        await copy.close()
      }
    }, 300_000)
  }

  if (h.provider === 'sqlite')
    test('rows whose foreign key dangles after the remaining migrations fail only the manual upgrade', async () => {
      await h.install('pre-seq')
      h.sqlite.exec('PRAGMA foreign_keys = OFF')
      h.sqlite
        .query('INSERT INTO node_run_outputs (node_run_id, port_name, content) VALUES (?, ?, ?)')
        .run('rfc626-missing-run', 'out', 'orphaned output')
      h.sqlite.exec('PRAGMA foreign_keys = ON')
      const manifest = await h.manifest()
      const source = openEpoch1SqliteSource({
        path: h.sqlitePath,
        manifest,
        operationRoot: h.operationRoot,
        resolution: 'automatic',
      })
      try {
        const expected = await source.preflight()
        expect(expected.requiresOfflineUpgrade).toBe(true)
        await expect(
          upgradeEpoch1Copy({ source, expected, manifest, operationRoot: h.operationRoot }),
        ).rejects.toThrow('foreign-key violation')
        const copy = await upgradeEpoch1Copy({
          source,
          expected,
          manifest,
          operationRoot: h.operationRoot,
          resolution: 'automatic',
        })
        try {
          expect('sourceEvidence' in copy).toBe(false)
          expect(existsSync(join(dirname(copy.path), 'pre-upgrade'))).toBe(false)
          expect(copy.after.tableRows.node_run_outputs).toBe(1)
          const after = await copy.reader.preflight()
          expect(after.contract?.digest).toBe(manifest.headDigest)
          expect(after.watermark).not.toBe(expected.watermark)
          await source.assertUnchanged(expected)
        } finally {
          await copy.close()
        }
      } finally {
        await source.close()
      }
    }, 300_000)
})
