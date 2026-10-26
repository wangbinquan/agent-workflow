// RFC-395 II-b V1: physical identification on both real engines, including negative source drift.
import { expect, test } from 'bun:test'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import { identifySource } from '@/platform/persistence/migration/supportedSources'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'
import { tableCatalogDigest } from '@/platform/persistence/migration/sourceDispositions'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'

describeV1Providers('RFC-395 V1 physical source identification', (h) => {
  for (const version of ['head', 'pre-seq', 'root'] as const) {
    test(`identifies the ${version} physical contract from catalog and journal`, async () => {
      const installed = await h.install(version)
      const fingerprint = await h.fingerprint()
      const identified = identifySource({ fingerprint, manifest: await h.manifest() })
      expect(identified.source.contract!.digest).toBe(installed.contract.digest)
      expect(new Set(identified.tables.map((table) => table.table)).size).toBe(
        Object.keys(fingerprint.tableRows).length,
      )
      expect(identified.tables.every((table) => table.disposition !== 'blocked')).toBe(true)
      if (version === 'pre-seq') {
        expect(
          identified.source.contract!.tables.some(
            (table) => table.id === 'node_run_seq_allocations',
          ),
        ).toBe(false)
        expect(
          identified.source
            .contract!.tables.find((table) => table.id === 'node_runs')!
            .columns.some((column) => column.name === 'seq'),
        ).toBe(false)
      }
    }, 180_000)
  }
  test('identifies a non-empty source without treating row counts as schema identity', async () => {
    await h.install()
    await h.seed()
    const identified = identifySource({
      fingerprint: await h.fingerprint(),
      manifest: await h.manifest(),
    })
    expect(identified.source.contract!.digest).toBe(frozenEpoch1Contract.digest)
    expect(
      identified.tables.find((table) => table.table.endsWith('maintenance_state'))!.rows,
    ).toBeGreaterThanOrEqual(3)
  }, 180_000)
  test('unknown non-empty tables block; empty tables require an explicit schema-bound decision', async () => {
    await h.install()
    const name = h.provider === 'sqlite' ? 'v1_unknown' : 'agent_workflow.v1_unknown'
    await h.native.execute(`CREATE TABLE ${h.table('v1_unknown')} (id text PRIMARY KEY)`)
    let fingerprint = await h.fingerprint()
    const manifest = await h.manifest()
    expect(() => identifySource({ fingerprint, manifest })).toThrow(SourceBlockedError)
    const emptyTables = [
      {
        table: name,
        catalogDigest: tableCatalogDigest(fingerprint, name),
        disposition: 'archived' as const,
        reason: 'fixture explicitly archives unused historical schema',
      },
    ]
    expect(
      identifySource({ fingerprint, manifest, emptyTables }).tables.find(
        (table) => table.physicalTable === name,
      )?.disposition,
    ).toBe('archived')
    await h.native.execute(`INSERT INTO ${h.table('v1_unknown')} VALUES ('kept')`)
    fingerprint = await h.fingerprint()
    expect(() => identifySource({ fingerprint, manifest, emptyTables })).toThrow(SourceBlockedError)
  }, 180_000)
  for (const drift of ['column', 'type', 'index', 'constraint', 'trigger'] as const) {
    test(`unknown ${drift} yields a precise physical diff`, async () => {
      await h.install()
      const table = h.table('maintenance_state')
      if (drift === 'column')
        await h.native.execute(`ALTER TABLE ${table} ADD COLUMN v1_unknown text`)
      if (drift === 'type') {
        if (h.provider === 'postgresql')
          await h.native.execute(
            `ALTER TABLE ${table} ALTER COLUMN updated_at TYPE text USING updated_at::text`,
          )
        else {
          await h.native.execute(`ALTER TABLE ${table} RENAME COLUMN updated_at TO old_updated_at`)
          await h.native.execute(
            `ALTER TABLE ${table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT '0'`,
          )
        }
      }
      if (drift === 'index')
        await h.native.execute(`CREATE INDEX v1_unknown_index ON ${table}(value)`)
      if (drift === 'constraint') {
        if (h.provider === 'postgresql')
          await h.native.execute(
            `ALTER TABLE ${table} ADD CONSTRAINT v1_unknown_check CHECK(length(value)>0)`,
          )
        else {
          h.sqlite.exec('PRAGMA foreign_keys=OFF')
          const ddl = h.sqlite
            .query<
              { sql: string },
              []
            >("SELECT sql FROM sqlite_schema WHERE type='table' AND name='maintenance_state'")
            .get()!.sql
          h.sqlite.exec(`ALTER TABLE ${table} RENAME TO v1_original`)
          h.sqlite.exec(ddl.replace(/\)\s*$/, ', CHECK(length(value)>0))'))
          h.sqlite.exec(`INSERT INTO ${table} SELECT * FROM v1_original; DROP TABLE v1_original`)
        }
      }
      if (drift === 'trigger') {
        if (h.provider === 'postgresql') {
          await h.native.execute(
            'CREATE FUNCTION agent_workflow.v1_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
          )
          await h.native.execute(
            `CREATE TRIGGER v1_unknown_trigger BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION agent_workflow.v1_trigger()`,
          )
        } else
          await h.native.execute(
            `CREATE TRIGGER v1_unknown_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`,
          )
      }
      const fingerprint = await h.fingerprint()
      try {
        identifySource({ fingerprint, manifest: await h.manifest() })
        throw new Error('unexpected admission')
      } catch (error) {
        expect(error).toBeInstanceOf(SourceBlockedError)
        expect(
          (error as SourceBlockedError).differences.some((entry) =>
            entry.path.includes('maintenance_state'),
          ),
        ).toBe(true)
      }
    }, 180_000)
  }
  test('equal journal row counts cannot impersonate a supported version', async () => {
    await h.install()
    const before = await h.fingerprint()
    await h.native.execute(
      h.provider === 'sqlite'
        ? "UPDATE __drizzle_migrations SET hash='unpublished' WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)"
        : "UPDATE agent_workflow_meta.schema_migrations SET plan_digest='sha256:0000000000000000000000000000000000000000000000000000000000000000'",
    )
    const after = await h.fingerprint()
    expect(after.journalEntryCount).toBe(before.journalEntryCount)
    const manifest = await h.manifest()
    expect(() => identifySource({ fingerprint: after, manifest })).toThrow(SourceBlockedError)
  }, 180_000)
})
