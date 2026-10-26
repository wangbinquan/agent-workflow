import { createFrozenEpoch1Db, FROZEN_MIGRATIONS as MIGRATIONS } from './migration-freeze'
import { frozenRawRows as rawRows } from './migration-freeze'
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

describe('migration 0173 — RFC-308 workspace profile hard cut', () => {
  test('drops gitignore preset receipt and adds platform profile receipt', () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const columns = rawRows<{ name: string; notnull: number }>(
      db,
      sql`SELECT name, "notnull" FROM pragma_table_info('task_repos')`,
      { notnull: 'int' },
    )
    const byName = new Map(columns.map((column) => [column.name, column]))

    expect(byName.has('gitignore_commit')).toBe(false)
    expect(byName.get('workspace_profile_version')?.notnull).toBe(0)
    expect(byName.get('workspace_profile_digest')?.notnull).toBe(0)
  })
})
