// RFC-395 I-b: session-bound native columns retain their identity and codecs while another provider is open.
// This replaces the former process-projection lock with simultaneous-client isolation.
import { insertOne } from '@/platform/persistence/singleInsert'
import { expect, test } from 'bun:test'
import { desc, eq, getTableName, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

describeEachProvider('RFC-395 I-b session-native column identity', (harness) => {
  test('captured columns keep encoding, decoding, tuple comparison and ordering semantics', async () => {
    const { missionInputUploads } = tablesOf(harness.db)
    const captured = {
      id: missionInputUploads.id,
      bytes: missionInputUploads.bytes,
      createdAt: missionInputUploads.createdAt,
    }
    const id = ulid()
    await insertOne(harness.db, missionInputUploads, {
      id,
      actorUserId: 'actor-1',
      originalName: 'spec.md',
      bytes: 3,
      sha256: 'b'.repeat(64),
      blobRef: 'blob-1',
      expiresAt: NOW + 60_000,
      createdAt: NOW,
    })
    const row = await first(
      harness.db
        .select({ bytes: captured.bytes, createdAt: captured.createdAt })
        .from(missionInputUploads)
        .where(eq(captured.id, id)),
    )
    expect(row).toEqual({ bytes: 3, createdAt: NOW })
    expect(typeof row?.createdAt).toBe('number')
    const page = await harness.db
      .select({ id: captured.id })
      .from(missionInputUploads)
      .where(sql`(${captured.createdAt}, ${captured.id}) <= (${NOW}, ${id})`)
      .orderBy(desc(captured.createdAt), desc(captured.id))
      .limit(1)
    expect(page).toEqual([{ id }])
    await harness.db
      .update(missionInputUploads)
      .set({ bytes: 4 })
      .where(eq(captured.createdAt, NOW))
    expect(
      await first(
        harness.db
          .select({ bytes: captured.bytes })
          .from(missionInputUploads)
          .where(eq(captured.id, id)),
      ),
    ).toEqual({ bytes: 4 })
    expect(missionInputUploads.createdAt).toBe(captured.createdAt)
    expect(getTableName(captured.createdAt.table)).toBe('mission_input_uploads')
    expect(captured.createdAt.name).toBe('created_at')
  })

  test('SQLite and the harness provider coexist and each transaction inherits its own table set', async () => {
    const originalTables = tablesOf(harness.db)
    const originalColumn = originalTables.users.createdAt
    const sqlite = createInMemoryDb()
    try {
      const sqliteTables = tablesOf(sqlite)
      const fixture = (id: string) => ({
        id,
        username: id,
        displayName: id,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await insertOne(harness.db, originalTables.users, fixture('session-native-primary'))
      await insertOne(sqlite, sqliteTables.users, fixture('session-native-sqlite'))
      const both = await Promise.all([
        first(
          harness.db
            .select({ id: originalTables.users.id, at: originalColumn })
            .from(originalTables.users)
            .where(eq(originalTables.users.id, 'session-native-primary')),
        ),
        first(
          sqlite
            .select({ id: sqliteTables.users.id, at: sqliteTables.users.createdAt })
            .from(sqliteTables.users)
            .where(eq(sqliteTables.users.id, 'session-native-sqlite')),
        ),
      ])
      expect(both).toEqual([
        { id: 'session-native-primary', at: NOW },
        { id: 'session-native-sqlite', at: NOW },
      ])
      expect(tablesOf(harness.db)).toBe(originalTables)
      expect(harness.session.tables).toBe(originalTables)
      expect(originalTables.users.createdAt).toBe(originalColumn)
      if (harness.capabilities.isolation !== 'exclusive')
        expect(originalColumn).not.toBe(sqliteTables.users.createdAt)
      await harness.session.transaction(async (tx) => {
        expect(tablesOf(tx)).toBe(originalTables)
      })
      dbTxSync(sqlite, (tx) => {
        expect(tablesOf(tx)).toBe(sqliteTables)
      })
      expect(
        await first(
          harness.db
            .select()
            .from(originalTables.users)
            .where(eq(originalTables.users.id, 'session-native-sqlite')),
        ),
      ).toBeUndefined()
      expect(
        await first(
          sqlite
            .select()
            .from(sqliteTables.users)
            .where(eq(sqliteTables.users.id, 'session-native-primary')),
        ),
      ).toBeUndefined()
    } finally {
      sqlite.$client.close()
    }
  })
})
