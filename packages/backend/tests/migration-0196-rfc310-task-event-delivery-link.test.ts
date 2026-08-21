import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'

describe('migration 0196 — generic Event Center task provenance', () => {
  test('adds exact delivery links and admits the event launch origin', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskColumns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('tasks')`)
    expect(taskColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['event_subscription_id', 'event_delivery_id']),
    )

    db.run(sql`
      INSERT INTO tasks (
        id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
        base_branch, branch, status, inputs, started_at, launch_origin,
        event_subscription_id, event_delivery_id
      ) VALUES (
        'event-origin-migration-probe', 'probe', 'workflow-probe', '{}', '/repo', '/worktree',
        'main', 'probe', 'pending', '{}', 1, 'event', 'subscription-1', 'delivery-1'
      )
    `)
    expect(
      db.all<{ launchOrigin: string; deliveryId: string }>(sql`
        SELECT launch_origin AS launchOrigin, event_delivery_id AS deliveryId
        FROM tasks
        WHERE id = 'event-origin-migration-probe'
      `)[0],
    ).toEqual({ launchOrigin: 'event', deliveryId: 'delivery-1' })
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })
})
