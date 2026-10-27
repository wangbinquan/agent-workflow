// RFC-395 V2 fix V1-1: one ordered cursor must preserve the former OFFSET digest bytes.
import { describe, expect, test } from 'bun:test'
import { postgresqlSourceContentDigest } from '@/platform/persistence/migration/postgresqlSourceReader'
import type {
  SourceFingerprint,
  SourceIdentityHighWater,
} from '@/platform/persistence/migration/sourceTypes'
import type {
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { createSha256DigestBuilder } from '@/util/hash'
import { describeEachProvider, resolveTestProviders } from './helpers/eachProvider'
import { withR2TargetHarness } from './helpers/rfc395R2Harness'

const identities: readonly SourceIdentityHighWater[] = [
  {
    name: 'agent_workflow.digest_seq',
    table: 'digest_rows',
    column: 'n',
    value: '9007199254740993',
    isCalled: true,
    increment: '1',
  },
]
function fingerprint(tableRows: Record<string, number>): SourceFingerprint {
  return {
    version: 1,
    evidence: 'physical-catalog-and-journal',
    provider: 'postgresql',
    catalog: [],
    catalogDigest: 'catalog-fixture',
    journal: [],
    journalEntryCount: 0,
    tableRows,
    digest: 'fingerprint-fixture',
  }
}

/** Frozen framing oracle: the old digest framed each text value, never decoded its JSON. */
function legacyDigest(
  source: SourceFingerprint,
  tables: Readonly<Record<string, readonly string[]>>,
) {
  const hash = createSha256DigestBuilder()
  for (const value of [
    { fingerprint: source, identities },
    ...Object.keys(source.tableRows)
      .sort()
      .flatMap((table) => [table, ...tables[table]!]),
  ]) {
    const text = canonicalSchemaJson(value)
    hash.update(`${Buffer.byteLength(text)}:`)
    hash.update(text)
  }
  return `sha256:${hash.digestHex()}`
}

interface Step {
  readonly sql: string
  readonly rows?: readonly Record<string, unknown>[]
  readonly error?: Error
}
function scriptedConnection(steps: readonly Step[]) {
  let position = 0
  const connection: Pick<PostgresqlReservedConnection, 'unsafe'> = {
    unsafe(sql, parameters): SqlRows {
      const promise = Promise.resolve().then(() => {
        const step = steps[position++]
        if (!step) throw new Error(`Unexpected digest query: ${sql}`)
        expect(sql).toBe(step.sql)
        expect(parameters ?? []).toEqual([])
        if (step.error) throw step.error
        return step.rows ?? []
      })
      return Object.assign(promise, {
        values: async () => (await promise).map((row) => Object.values(row)),
      })
    },
  }
  return { connection, consumed: () => expect(position).toBe(steps.length) }
}
const declaration = (table: string) =>
  `DECLARE rfc395_source_digest NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS value FROM "agent_workflow"."${table}" t ORDER BY to_jsonb(t)::text COLLATE "C", ctid`
const fetch = 'FETCH FORWARD 1000 FROM rfc395_source_digest'
const close = 'CLOSE rfc395_source_digest'

describe('RFC-395 V1 PostgreSQL digest cursor', () => {
  for (const count of [0, 1, 999, 1000, 1001, 2000, 2005])
    test(`${count} rows: one scan per table and byte-identical framing across fetch boundaries`, async () => {
      const values = Array.from(
        { length: count },
        (_, index) =>
          `{ "big": 9007199254740993, "text": "值-é-${Math.floor(index / 2)}", "enabled": true }`,
      )
      const source = fingerprint({ 'agent_workflow.rows': count, 'agent_workflow.empty': 0 })
      const steps: Step[] = []
      if (count > 0) {
        steps.push({ sql: declaration('rows') })
        for (let offset = 0; ; offset += 1000) {
          const rows = values.slice(offset, offset + 1000).map((value) => ({ value }))
          steps.push({ sql: fetch, rows })
          if (rows.length < 1000) break
        }
        steps.push({ sql: close })
      }
      const session = scriptedConnection(steps)
      expect(await postgresqlSourceContentDigest(session.connection, source, identities)).toBe(
        legacyDigest(source, { 'agent_workflow.rows': values, 'agent_workflow.empty': [] }),
      )
      session.consumed()
    })
  test('declaration failure is preserved without closing a cursor that was not opened', async () => {
    const failure = new Error('declaration failed')
    const session = scriptedConnection([{ sql: declaration('rows'), error: failure }])
    await expect(
      postgresqlSourceContentDigest(
        session.connection,
        fingerprint({ 'agent_workflow.rows': 1 }),
        identities,
      ),
    ).rejects.toBe(failure)
    session.consumed()
  })
  test('fetch failure closes the cursor and preserves its cause even if cleanup also fails', async () => {
    for (const cleanupFailure of [undefined, new Error('transaction aborted')]) {
      const failure = new Error('fetch failed')
      const session = scriptedConnection([
        { sql: declaration('rows') },
        { sql: fetch, error: failure },
        { sql: close, error: cleanupFailure },
      ])
      await expect(
        postgresqlSourceContentDigest(
          session.connection,
          fingerprint({ 'agent_workflow.rows': 1 }),
          identities,
        ),
      ).rejects.toBe(failure)
      session.consumed()
    }
  })
  test('a close failure after a successful scan remains a failure', async () => {
    const failure = new Error('close failed')
    const session = scriptedConnection([
      { sql: declaration('rows') },
      { sql: fetch, rows: [{ value: 'original' }] },
      { sql: close, error: failure },
    ])
    await expect(
      postgresqlSourceContentDigest(
        session.connection,
        fingerprint({ 'agent_workflow.rows': 1 }),
        identities,
      ),
    ).rejects.toBe(failure)
    session.consumed()
  })
})

describeEachProvider(
  'RFC-395 V1 PostgreSQL digest ordering',
  (harness) =>
    withR2TargetHarness(harness, (h) => {
      test('the real cursor equals the former OFFSET query for duplicate JSON, Unicode, bigint and numeric', async () => {
        const connection = await h.pool.reserve()
        try {
          await connection.unsafe('CREATE SCHEMA agent_workflow')
          await connection.unsafe(
            'CREATE TABLE agent_workflow.digest_rows (n bigint, amount numeric, label text, enabled boolean, payload text)',
          )
          await connection.unsafe(`INSERT INTO agent_workflow.digest_rows
          SELECT 9007199254740993::bigint, 12345678901234567890.123456789::numeric,
            CASE WHEN i % 3 = 0 THEN '值' WHEN i % 3 = 1 THEN 'é' ELSE 'z' END,
            i % 2 = 0, '{ "original": [2,1] }'
          FROM generate_series(1, 2005) AS s(i)`)
          await connection.unsafe('CREATE TABLE agent_workflow.digest_empty (value text)')
          await connection.unsafe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
          const source = fingerprint({
            'agent_workflow.digest_rows': 2005,
            'agent_workflow.digest_empty': 0,
          })
          const tables: Record<string, string[]> = {}
          for (const table of Object.keys(source.tableRows).sort()) {
            const values: string[] = []
            for (let offset = 0; ; offset += 1000) {
              const rows = await connection.unsafe(
                `SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C", ctid LIMIT 1000 OFFSET $1`,
                [offset],
              )
              values.push(...rows.map((row) => String(row.value)))
              if (rows.length < 1000) break
            }
            tables[table] = values
          }
          expect(tables['agent_workflow.digest_rows']).toHaveLength(2005)
          expect(tables['agent_workflow.digest_rows']![0]).toContain('9007199254740993')
          expect(tables['agent_workflow.digest_rows']![0]).toContain(
            '12345678901234567890.123456789',
          )
          const expected = legacyDigest(source, tables)
          for (let repeat = 0; repeat < 2; repeat++) {
            expect(await postgresqlSourceContentDigest(connection, source, identities)).toBe(
              expected,
            )
            expect(
              await connection.unsafe(
                "SELECT name FROM pg_cursors WHERE name = 'rfc395_source_digest'",
              ),
            ).toHaveLength(0)
          }
        } finally {
          try {
            await connection.unsafe('ROLLBACK')
          } finally {
            connection.release()
          }
        }
      }, 60_000)
    }),
  { providers: resolveTestProviders(process.env).filter((provider) => provider === 'postgresql') },
)
