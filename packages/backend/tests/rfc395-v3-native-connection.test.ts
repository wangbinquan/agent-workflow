import { expect, test } from 'bun:test'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import { parameters } from '@/platform/persistence/schema/history/connection'

describeV3Providers('RFC-395 native offline transaction connection', (h) => {
  test('one serialized connection commits, rolls back after await, and remains usable', async () => {
    const connection = openConversionTarget(
      h.targetProvider === 'sqlite'
        ? { databasePath: h.targetPath, create: false }
        : { runtime: h.runtime },
    )
    try {
      await connection.execute('CREATE TABLE offline_tx_probe (id integer PRIMARY KEY)')
      await expect(
        connection.transaction(async (tx) => {
          await tx.execute(`INSERT INTO offline_tx_probe VALUES (${parameters(tx, 1)})`, [1])
          await new Promise<void>((resolve) => setImmediate(resolve))
          throw new Error('rollback-proof')
        }),
      ).rejects.toThrow('rollback-proof')
      expect(await connection.execute('SELECT id FROM offline_tx_probe')).toEqual([])
      await Promise.all(
        [2, 3].map((id) =>
          connection.transaction(async (tx) => {
            await tx.execute(`INSERT INTO offline_tx_probe VALUES (${parameters(tx, 1)})`, [id])
          }),
        ),
      )
      expect(
        (await connection.execute('SELECT id FROM offline_tx_probe ORDER BY id')).map((row) =>
          Number(row.id),
        ),
      ).toEqual([2, 3])
      await expect(
        connection.transaction(async (tx) => {
          await tx.execute('INSERT INTO offline_tx_probe VALUES (2)')
        }),
      ).rejects.toThrow()
      expect(
        (await connection.execute('SELECT COUNT(*) AS n FROM offline_tx_probe')).map((row) =>
          Number(row.n),
        ),
      ).toEqual([2])
    } finally {
      await connection.execute('DROP TABLE offline_tx_probe')
      await connection.close()
    }
  })
})
