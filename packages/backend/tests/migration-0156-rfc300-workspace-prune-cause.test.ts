// RFC-300 — existing workspace_pruning_at claims predate provenance and must
// remain NULL-cause on upgrade, otherwise boot recovery could reinterpret an
// interrupted RFC-165/iso GC claim as permission to delete a Webhook workspace.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { rmSync } from 'node:fs'
import { freezeAt, MIGRATIONS } from './migration-freeze'

const frozenFolders: string[] = []

afterEach(() => {
  for (const folder of frozenFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

describe('migration 0156 RFC-300 workspace prune claim provenance', () => {
  test('backfills existing claims to NULL and constrains new provenance values', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    const through0154 = freezeAt(153)
    frozenFolders.push(through0154)
    migrate(drizzle(raw), { migrationsFolder: through0154 })
    raw
      .query(
        `INSERT INTO tasks (
           id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, status, inputs, started_at, finished_at,
           webhook_trigger_id, space_kind, workspace_pruning_at
         ) VALUES (
           'task-rfc300-upgrade', 'rfc300', 'missing-soft-workflow', '{}',
           '/source', '/workspace', 'main', 'agent-workflow/rfc300', 'done',
           '{}', 1, 2, 'deleted-trigger', 'scratch', 123
         )`,
      )
      .run()

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    expect(
      raw
        .query(
          "SELECT workspace_pruning_at, workspace_prune_cause FROM tasks WHERE id='task-rfc300-upgrade'",
        )
        .get(),
    ).toEqual({ workspace_pruning_at: 123, workspace_prune_cause: null })

    raw
      .query(
        "UPDATE tasks SET workspace_prune_cause='webhook-terminal' WHERE id='task-rfc300-upgrade'",
      )
      .run()
    expect(
      raw.query("SELECT workspace_prune_cause FROM tasks WHERE id='task-rfc300-upgrade'").get(),
    ).toEqual({ workspace_prune_cause: 'webhook-terminal' })
    expect(() =>
      raw
        .query("UPDATE tasks SET workspace_prune_cause='iso-gc' WHERE id='task-rfc300-upgrade'")
        .run(),
    ).toThrow()
    raw
      .query(
        "UPDATE tasks SET workspace_prune_cause=NULL, workspace_pruning_at=NULL WHERE id='task-rfc300-upgrade'",
      )
      .run()
    expect(() =>
      raw
        .query(
          "UPDATE tasks SET workspace_prune_cause='webhook-terminal' WHERE id='task-rfc300-upgrade'",
        )
        .run(),
    ).toThrow()
    raw.close()
  })
})
