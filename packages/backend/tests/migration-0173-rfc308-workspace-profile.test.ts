import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { MIGRATIONS } from './migration-freeze'

describe('migration 0173 — RFC-308 workspace profile hard cut', () => {
  test('drops gitignore preset receipt and adds platform profile receipt', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const columns = db.all<{ name: string; notnull: number }>(
      sql`SELECT name, "notnull" FROM pragma_table_info('task_repos')`,
    )
    const byName = new Map(columns.map((column) => [column.name, column]))

    expect(byName.has('gitignore_commit')).toBe(false)
    expect(byName.get('workspace_profile_version')?.notnull).toBe(0)
    expect(byName.get('workspace_profile_digest')?.notnull).toBe(0)
  })
})
