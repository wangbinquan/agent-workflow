import { createFrozenEpoch1Db, freezeAt } from './migration-freeze'
import { frozenRawRows as rawRows } from './migration-freeze'
import { rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

describe('migration 0221 — RFC-342 memory scope move events', () => {
  test('adds the durable receipt table, indexes, and closed scope/version invariants', () => {
    const db = createFrozenEpoch1Db(freezeAt(220))
    expect(
      rawRows<{ name: string }>(
        db,
        sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_scope_move_events'
      `,
      ),
    ).toEqual([{ name: 'memory_scope_move_events' }])
    expect(
      rawRows<{
        name: string
        unique: number
      }>(db, sql`SELECT name, "unique" FROM pragma_index_list('memory_scope_move_events')`, {
        unique: 'int',
      }).map((row) => ({ name: row.name, unique: row.unique })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'idx_memory_scope_move_events_memory_version', unique: 1 },
        { name: 'idx_memory_scope_move_events_occurred', unique: 0 },
      ]),
    )

    rawExec(
      db,
      sql`
      INSERT INTO memory_scope_move_events (
        id, memory_id, actor_user_id, actor_source,
        from_scope_type, from_scope_id, to_scope_type, to_scope_id,
        expected_version, resulting_version, correlation_id, occurred_at
      ) VALUES (
        'move-ok', 'memory-1', 'user-1', 'session',
        'agent', 'agent-1', 'global', NULL,
        1, 2, 'correlation-1', 1
      )
    `,
    )

    expect(() =>
      rawExec(
        db,
        sql`
        INSERT INTO memory_scope_move_events (
          id, memory_id, actor_user_id, actor_source,
          from_scope_type, from_scope_id, to_scope_type, to_scope_id,
          expected_version, resulting_version, correlation_id, occurred_at
        ) VALUES (
          'move-noop', 'memory-2', 'user-1', 'session',
          'agent', 'agent-1', 'agent', 'agent-1',
          1, 2, 'correlation-2', 1
        )
      `,
      ),
    ).toThrow()
    expect(() =>
      rawExec(
        db,
        sql`
        INSERT INTO memory_scope_move_events (
          id, memory_id, actor_user_id, actor_source,
          from_scope_type, from_scope_id, to_scope_type, to_scope_id,
          expected_version, resulting_version, correlation_id, occurred_at
        ) VALUES (
          'move-bad-scope', 'memory-3', 'user-1', 'session',
          'global', 'must-be-null', 'workflow', 'workflow-1',
          1, 2, 'correlation-3', 1
        )
      `,
      ),
    ).toThrow()
    expect(() =>
      rawExec(
        db,
        sql`
        INSERT INTO memory_scope_move_events (
          id, memory_id, actor_user_id, actor_source,
          from_scope_type, from_scope_id, to_scope_type, to_scope_id,
          expected_version, resulting_version, correlation_id, occurred_at
        ) VALUES (
          'move-bad-version', 'memory-4', 'user-1', 'session',
          'agent', 'agent-1', 'workflow', 'workflow-1',
          1, 3, 'correlation-4', 1
        )
      `,
      ),
    ).toThrow()
  })
})
