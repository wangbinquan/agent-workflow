// RFC-370 v2 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md):
// migration 0257 retires the two tables only the v1 host execution path used —
// the host write contexts and the memory distill execution receipts. Upgrading
// from 0256 must drop exactly those two tables and keep every business row; the
// PostgreSQL step 0033 must drop the same two tables and nothing else.
import { FROZEN_POSTGRESQL_MIGRATIONS } from './migration-freeze'
import { migrateFrozenSqlite as migrate, freezeAt, FROZEN_MIGRATIONS } from './migration-freeze'
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

const RETIRED = ['memory_distill_execution_receipts', 'system_host_execution_write_contexts']
const THROUGH_0256 = 255
const THROUGH_0257 = 256

function statements(file: string): string[] {
  return readFileSync(resolve(FROZEN_MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
}

function tableNames(raw: Database): string[] {
  return (
    raw.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string
    }[]
  ).map((row) => row.name)
}

describe('migration 0257 — RFC-370 v2 retires the host execution tables', () => {
  test('upgrading from 0256 drops exactly the two host tables and keeps business rows', () => {
    const through0256 = freezeAt(THROUGH_0256)
    const raw = new Database(':memory:')
    try {
      raw.exec('PRAGMA foreign_keys = ON;')
      migrate(drizzle(raw), { migrationsFolder: through0256 })
      const before = tableNames(raw)
      for (const table of RETIRED) expect(before).toContain(table)
      raw.query(`INSERT INTO workflows (id, name, definition) VALUES ('wf-1', 'wf', '{}')`).run()

      raw.exec('BEGIN')
      for (const statement of statements('0257_rfc370_v2_retire_host_execution.sql'))
        raw.exec(statement)
      raw.exec('COMMIT')

      const after = tableNames(raw)
      for (const table of RETIRED) expect(after).not.toContain(table)
      expect(after).toEqual(before.filter((table) => !RETIRED.includes(table)))
      expect(raw.query(`SELECT id FROM workflows`).all()).toEqual([{ id: 'wf-1' }])
      expect(raw.query(`PRAGMA foreign_key_check`).all()).toEqual([])
    } finally {
      raw.close()
      rmSync(through0256, { recursive: true, force: true })
    }
  })

  test('a fresh database never has either host table', () => {
    const all = freezeAt(THROUGH_0257)
    const raw = new Database(':memory:')
    try {
      migrate(drizzle(raw), { migrationsFolder: all })
      const tables = tableNames(raw)
      for (const table of RETIRED) expect(tables).not.toContain(table)
    } finally {
      raw.close()
      rmSync(all, { recursive: true, force: true })
    }
  })

  test('PostgreSQL 0033 drops the same two tables and creates nothing', () => {
    const sql = readFileSync(
      resolve(FROZEN_POSTGRESQL_MIGRATIONS, '0033_rfc370_v2_retire_host_execution.sql'),
      'utf8',
    )
    const dropped = [...sql.matchAll(/^DROP TABLE "agent_workflow"\."([a-z_]+)";$/gm)].map(
      (match) => match[1],
    )
    expect(dropped.sort()).toEqual([
      'memory_distill_execution_receipts',
      'system_host_execution_write_contexts',
    ])
    expect(sql).not.toMatch(/^CREATE /m)
    expect(sql).not.toMatch(/^ALTER /m)
  })
})
