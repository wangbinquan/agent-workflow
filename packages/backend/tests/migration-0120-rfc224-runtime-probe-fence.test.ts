// RFC-224 — a persisted runtime-probe generation closes the race between a
// long-running smoke receipt and execution-target mutations outside SQLite.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

function freezeThrough0119(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc224-0120-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 118)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0120 RFC-224 runtime probe fence', () => {
  test('upgrades an existing runtime and defaults both old and new rows to fence zero', () => {
    const raw = new Database(':memory:')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0119() })
    raw
      .query(
        `INSERT INTO runtimes (id, name, protocol, binary_path, last_probe_json)
         VALUES ('runtime-old', 'runtime-old', 'opencode', NULL, '{"legacy":true}')`,
      )
      .run()

    const before = raw.query("PRAGMA table_info('runtimes')").all() as Array<{ name: string }>
    expect(before.some((column) => column.name === 'probe_fence')).toBe(false)

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    const columns = raw.query("PRAGMA table_info('runtimes')").all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    expect(columns.find((column) => column.name === 'probe_fence')).toMatchObject({
      name: 'probe_fence',
      notnull: 1,
      dflt_value: '0',
    })
    expect(
      raw
        .query(
          `SELECT probe_fence AS probeFence, last_probe_json AS lastProbeJson
           FROM runtimes WHERE id = 'runtime-old'`,
        )
        .get(),
    ).toEqual({ probeFence: 0, lastProbeJson: '{"legacy":true}' })

    raw
      .query(
        `INSERT INTO runtimes (id, name, protocol)
         VALUES ('runtime-new', 'runtime-new', 'claude-code')`,
      )
      .run()
    expect(
      raw.query("SELECT probe_fence AS probeFence FROM runtimes WHERE id = 'runtime-new'").get(),
    ).toEqual({ probeFence: 0 })
  })
})
