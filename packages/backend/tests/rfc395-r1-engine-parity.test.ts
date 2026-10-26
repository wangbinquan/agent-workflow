import { FROZEN_MIGRATIONS } from './migration-freeze'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import type { SchemaContribution } from '@/platform/persistence/schema/contribution'
// RFC-395 II-b R1: independent migrated seeds and real engine catalogs catch compiler self-comparison blind spots.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'

import { compileInstallSeeds } from '@/platform/persistence/schema/seeds'
import { quoteSchemaIdentifier as quote } from '@/platform/persistence/schema/expressions'
import { SchemaRowRuleError } from '@/platform/persistence/schema/rowRules'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { withR2TargetHarness } from './helpers/rfc395R2Harness'
import { describeEachProvider } from './helpers/eachProvider'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'

const installedAt = 1800000000123
const normalize = (value: unknown, codec: string): unknown =>
  value === null
    ? null
    : codec === 'bool'
      ? Boolean(value)
      : ['int', 'epochMs', 'seq', 'identity', 'durationMs', 'bigint', 'real'].includes(codec)
        ? Number(value)
        : value

describeEachProvider(
  'RFC-395 II-b R1 independent SQLite oracle',
  (oracle) => {
    describeEachProvider('target engine parity', (harness) => {
      withR2TargetHarness(harness, (h) => {
        test('every compiled seed cell equals the independently migrated epoch-1 row and the installed target', async () => {
          const binding = oracle.applicationBinding
          if (binding.provider !== 'sqlite') throw new Error('independent oracle must use SQLite')
          const fresh = binding.db
          await h.installHead(
            createHistoryVersion({ registry: persistenceSchema, slug: 'target' }),
            {
              now: () => installedAt,
            },
          )
          const rows = compileInstallSeeds(persistenceSchema, {
            path: 'new-install',
            installedAt,
          }).rows
          const seededTables: string[] = []
          for (const table of frozenEpoch1Registry.tables) {
            const count = fresh.$client
              .query(`SELECT COUNT(*) AS n FROM ${quote(table.id)}`)
              .get() as {
              n: number
            }
            if (count.n) seededTables.push(table.id)
          }
          expect(seededTables.sort()).toEqual([
            'auth_login_policy',
            'committed_event_family_cutovers',
            'employee_os_writer_state',
            'users',
          ])
          for (const tableId of new Set(rows.map((row) => row.table))) {
            const table = persistenceSchema.tables.find((table) => table.id === tableId)!
            const expected = fresh.$client.query(`SELECT * FROM ${quote(tableId)}`).all() as Record<
              string,
              unknown
            >[]
            const actual = await h.native.execute(`SELECT * FROM ${h.table(tableId)}`)
            const compiled = rows.filter((row) => row.table === tableId)
            expect(expected).toHaveLength(compiled.length)
            expect(actual).toHaveLength(compiled.length)
            const sameKey = (
              row: Record<string, unknown>,
              values: (typeof compiled)[number]['values'],
            ) => table.primaryKey.every((key) => row[key] === values[key])
            for (const row of compiled) {
              const source = expected.find((candidate) => sameKey(candidate, row.values))!
              const target = actual.find((candidate) => sameKey(candidate, row.values))!
              expect(source).toBeDefined()
              expect(target).toBeDefined()
              const declaration = persistenceSchema.contributions
                .flatMap((entry: SchemaContribution) => entry.seeds ?? [])
                .filter((seed) => seed.table === tableId)
                .flatMap((seed) => seed.rows)
                .find((candidate) => sameKey(candidate, row.values))!
              for (const column of Object.values(table.columns)) {
                const key = column.name
                expect(normalize(target[key], column.codec), `${tableId}.${key}`).toEqual(
                  row.values[key],
                )
                const declared: unknown = (declaration as Record<string, unknown>)[key]
                if (
                  declared &&
                  typeof declared === 'object' &&
                  'kind' in declared &&
                  declared.kind === 'install-time'
                ) {
                  expect(Number.isSafeInteger(source[key])).toBe(true)
                  expect(Number(source[key])).toBeGreaterThan(0)
                  expect(row.values[key]).toBe(installedAt)
                } else
                  expect(normalize(source[key], column.codec), `${tableId}.${key}`).toEqual(
                    row.values[key],
                  )
              }
            }
          }
        }, 180_000)

        test('real target DDL catalogs agree on column order, nullability, defaults and FK actions', async () => {
          const binding = oracle.applicationBinding
          if (binding.provider !== 'sqlite') throw new Error('independent oracle must use SQLite')
          const reference = binding.db.$client
          const objects = reference
            .query<
              { type: string; name: string },
              []
            >("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger', 'view', 'table') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END")
            .all()
          reference.exec('PRAGMA foreign_keys = OFF')
          try {
            for (const object of objects)
              reference.exec(`DROP ${object.type.toUpperCase()} ${quote(object.name)}`)
          } finally {
            reference.exec('PRAGMA foreign_keys = ON')
          }
          for (const statement of compileSqlitePlan(persistenceSchema).statements)
            reference.exec(statement.sql)
          const target = createHistoryVersion({ registry: persistenceSchema, slug: 'target' })
          expect(target.postgresql.head).toEqual(
            compilePostgresqlPlan(persistenceSchema).statements.filter(
              (statement) => !['metadata', 'seed'].includes(statement.kind),
            ),
          )
          await h.apply(target)
          const pgColumns =
            h.provider === 'postgresql'
              ? await h.native.execute(
                  `SELECT table_name, column_name AS name, ordinal_position AS ordinal, is_nullable, column_default AS dflt_value, is_identity FROM information_schema.columns WHERE table_schema = 'agent_workflow' ORDER BY table_name, ordinal_position`,
                )
              : []
          for (const table of persistenceSchema.tables) {
            const left = reference.query(`PRAGMA table_info(${quote(table.id)})`).all() as {
              name: string
              notnull: number
              dflt_value: string | null
            }[]
            const right =
              h.provider === 'postgresql'
                ? pgColumns.filter((row) => row.table_name === table.id)
                : await h.native.execute(`PRAGMA table_info(${quote(table.id)})`)
            expect(
              right.map((row) => row.name),
              table.id,
            ).toEqual(left.map((row) => row.name))
            for (const [i, column] of left.entries()) {
              const actual = right[i]!
              expect(
                h.provider === 'postgresql' ? actual.is_nullable === 'NO' : Boolean(actual.notnull),
                `${table.id}.${column.name}`,
              ).toBe(Boolean(column.notnull))
              const definition = Object.values(table.columns).find((c) => c.name === column.name)!
              if (definition.codec === 'identity') {
                if (h.provider === 'postgresql') expect(actual.is_identity).toBe('YES')
                continue
              }
              expect(
                actual.dflt_value === null,
                `${table.id}.${column.name} default presence`,
              ).toBe(column.dflt_value === null)
              if (column.dflt_value !== null) {
                const beforeDefault = Date.now()
                const expected = (
                  reference.query(`SELECT ${column.dflt_value} AS value`).get() as {
                    value: unknown
                  }
                ).value
                const found = (
                  await h.native.execute(`SELECT ${String(actual.dflt_value)} AS value`)
                )[0]!.value
                if (/unixepoch/i.test(column.dflt_value)) {
                  expect(String(actual.dflt_value)).toMatch(
                    h.provider === 'sqlite' ? /unixepoch/i : /clock_timestamp/i,
                  )
                  for (const value of [expected, found]) {
                    expect(Number(value)).toBeGreaterThanOrEqual(beforeDefault - 1000)
                    expect(Number(value)).toBeLessThanOrEqual(Date.now() + 1000)
                  }
                } else if (/randomblob/i.test(column.dflt_value)) {
                  expect(String(actual.dflt_value)).toMatch(
                    h.provider === 'sqlite' ? /randomblob/i : /random\(/i,
                  )
                  expect(expected).toMatch(/^[a-f0-9]{32}$/)
                  expect(found).toMatch(/^[a-f0-9]{32}$/)
                  const next = (
                    await h.native.execute(`SELECT ${String(actual.dflt_value)} AS value`)
                  )[0]!.value
                  expect(next).not.toBe(found)
                } else
                  expect(
                    normalize(found, definition.codec),
                    `${table.id}.${column.name} default value`,
                  ).toEqual(normalize(expected, definition.codec))
              }
            }
            const leftFks = reference
              .query(`PRAGMA foreign_key_list(${quote(table.id)})`)
              .all() as Record<string, unknown>[]
            const rightFks =
              h.provider === 'sqlite'
                ? await h.native.execute(`PRAGMA foreign_key_list(${quote(table.id)})`)
                : await h.native.execute(
                    `SELECT con.conname AS id, k.ordinality - 1 AS seq, foreign_table.relname AS "table", own.attname AS "from", dest.attname AS "to", con.confdeltype AS on_delete, con.confupdtype AS on_update FROM pg_constraint con JOIN pg_class own_table ON own_table.oid = con.conrelid JOIN pg_namespace n ON n.oid = own_table.relnamespace JOIN pg_class foreign_table ON foreign_table.oid = con.confrelid CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(own_num, dest_num, ordinality) JOIN pg_attribute own ON own.attrelid = con.conrelid AND own.attnum = k.own_num JOIN pg_attribute dest ON dest.attrelid = con.confrelid AND dest.attnum = k.dest_num WHERE con.contype = 'f' AND n.nspname = 'agent_workflow' AND own_table.relname = '${table.id}'`,
                  )
            const actions: Readonly<Record<string, string>> = {
              a: 'NO ACTION',
              r: 'RESTRICT',
              c: 'CASCADE',
              n: 'SET NULL',
              d: 'SET DEFAULT',
            }
            const action = (value: unknown) => actions[String(value)] ?? String(value)
            const shape = (rows: readonly Record<string, unknown>[]) =>
              rows
                .map((row) =>
                  JSON.stringify([
                    row.table,
                    row.from,
                    row.to,
                    Number(row.seq),
                    action(row.on_delete),
                    action(row.on_update),
                  ]),
                )
                .sort()
            expect(shape(rightFks), table.id).toEqual(shape(leftFks))
          }
        }, 180_000)

        test('provider construction maps row errors through raw, prepared and transaction statements without a caller registry', async () => {
          // Exercise the production constructors, including the pool's transaction adapter
          // and the automatically bound row-rule mapper, rather than a cast of the raw pool.
          const binding = harness.applicationBinding
          const insert = `INSERT INTO ${h.table('user_access_audit')} (id,target_user_id,actor_kind,operation_id,before_role,after_role,added_permissions_json,removed_permissions_json,access_revision,created_at) VALUES ('audit','__system__','system','op','guest','user','[]','[]',1,1)`
          const update = sql.raw(
            `UPDATE ${h.table('user_access_audit')} SET id = id WHERE id = 'audit'`,
          )
          if (binding.provider === 'sqlite') {
            const sqlite = binding.db
            sqlite.run(sql.raw(insert))
            expect(() => sqlite.run(update)).toThrow(SchemaRowRuleError)
            expect(() => sqlite.transaction((tx) => tx.run(update))).toThrow(SchemaRowRuleError)
          } else {
            const pg = binding.db
            await pg.execute(sql.raw(insert))
            await expect(pg.execute(update).execute()).rejects.toBeInstanceOf(SchemaRowRuleError)
            await expect(
              pg.transaction(async (tx) => {
                await tx.execute(update)
              }),
            ).rejects.toBeInstanceOf(SchemaRowRuleError)
          }
        }, 180_000)
      })
    })
  },
  { providers: ['sqlite'], bootstrap: 'required', sqliteMigrationsFolder: FROZEN_MIGRATIONS },
)
