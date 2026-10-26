// Q-3: install-only seed bytes agree on all three paths in each native engine.
import { expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { compileInstallSeeds, type InstallPath } from '@/platform/persistence/schema/seeds'
import { describeR2Providers } from './helpers/rfc395R2Harness'

const installedAt = 1800000000123
const paths: readonly InstallPath[] = ['new-install', 'test-baseline', 'hosted-installation']

describeR2Providers('Q-3 installation seeds', (h) => {
  for (const path of paths)
    test(`${path}: native values equal the shared seed bytes with only explicit hosted bootstrap completion`, async () => {
      const seeds = compileInstallSeeds(persistenceSchema, { path, installedAt })
      for (const other of paths)
        expect(compileInstallSeeds(persistenceSchema, { path: other, installedAt })).toEqual(seeds)
      expect(seeds.rows.length).toBeGreaterThan(0)
      await h.installHead(createHistoryVersion({ registry: persistenceSchema, slug: 'q3-seeds' }), {
        now: () => installedAt,
        installPath: path,
      })
      for (const tableId of new Set(seeds.rows.map((row) => row.table))) {
        const table = persistenceSchema.tables.find((value) => value.id === tableId)!
        const expected = seeds.rows
          .filter((row) => row.table === tableId)
          .map((row) => {
            const values = { ...row.values }
            // AD-4 / AF-D4: hosted install completes bootstrap after identical seed insertion.
            if (path === 'hosted-installation' && tableId === 'auth_login_policy') {
              values.bootstrap_completed_at = installedAt
              values.updated_at = installedAt
            }
            return values
          })
        const actual = (await h.native.execute(`SELECT * FROM ${h.table(tableId)}`)).map((row) =>
          Object.fromEntries(
            Object.values(table.columns).map((column) => {
              const value = row[column.name]
              return [
                column.name,
                value === null
                  ? null
                  : column.codec === 'bool'
                    ? Boolean(value)
                    : [
                          'int',
                          'epochMs',
                          'seq',
                          'identity',
                          'durationMs',
                          'bigint',
                          'real',
                        ].includes(column.codec)
                      ? Number(value)
                      : value,
              ]
            }),
          ),
        )
        expect(actual).toHaveLength(expected.length)
        for (const row of expected) expect(actual).toContainEqual(row)
      }
    }, 180000)
})
