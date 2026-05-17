// RFC-031 T2 — locks migration 0014: introduces `plugins` table and adds
// `agents.plugins` column (default '[]').
//
// Legacy agent rows inserted BEFORE this migration come back with plugins == '[]'
// (the column default), so AgentSchema validates them and downstream readers
// (services/runner.ts buildInlineConfig + services/scheduler.ts loadAgent)
// treat them as "no plugins declared".
//
// If this test fails, RFC-031's "DB stores agent plugin names" + "plugins table
// exists" assumptions (proposal §5, design §2) are broken.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, plugins } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0014 (RFC-031 plugins + agents.plugins)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('plugins table exists with unique name + sensible defaults', () => {
    const id = ulid()
    db.insert(plugins)
      .values({
        id,
        name: 'dd-trace',
        spec: '@mycorp/opencode-dd-trace@2.4.1',
        sourceKind: 'npm',
        cachedPath: '/home/u/.agent-workflow/plugins/dd/node_modules/@mycorp/opencode-dd-trace',
        resolvedVersion: '2.4.1',
        installedAt: Date.now(),
      })
      .run()

    const rows = db.select().from(plugins).all()
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe(id)
    expect(r.name).toBe('dd-trace')
    expect(r.spec).toBe('@mycorp/opencode-dd-trace@2.4.1')
    expect(r.optionsJson).toBe('{}') // default
    expect(r.description).toBe('') // default
    expect(r.enabled).toBe(true) // default
    expect(r.sourceKind).toBe('npm')
    expect(r.resolvedVersion).toBe('2.4.1')
    expect(r.schemaVersion).toBe(1)
    expect(r.createdAt).toBeGreaterThan(0)
    expect(r.updatedAt).toBeGreaterThan(0)
  })

  test('plugins.name UNIQUE constraint rejects duplicates', () => {
    db.insert(plugins)
      .values({
        id: ulid(),
        name: 'shared',
        spec: 'a@1',
        sourceKind: 'npm',
        cachedPath: '/tmp/a',
        installedAt: Date.now(),
      })
      .run()
    expect(() =>
      db
        .insert(plugins)
        .values({
          id: ulid(),
          name: 'shared',
          spec: 'b@2',
          sourceKind: 'npm',
          cachedPath: '/tmp/b',
          installedAt: Date.now(),
        })
        .run(),
    ).toThrow()
  })

  test('plugins.sourceKind accepts npm / file / git only', () => {
    for (const sk of ['npm', 'file', 'git'] as const) {
      db.insert(plugins)
        .values({
          id: ulid(),
          name: `p-${sk}`,
          spec: 's',
          sourceKind: sk,
          cachedPath: '/tmp',
          installedAt: Date.now(),
        })
        .run()
    }
    expect(db.select().from(plugins).all()).toHaveLength(3)
  })

  test('plugins.resolvedVersion may be NULL', () => {
    db.insert(plugins)
      .values({
        id: ulid(),
        name: 'partial',
        spec: 'file:///tmp/x',
        sourceKind: 'file',
        cachedPath: '/tmp/x',
        resolvedVersion: null,
        installedAt: Date.now(),
      })
      .run()
    const r = db.select().from(plugins).all()[0]!
    expect(r.resolvedVersion).toBeNull()
  })

  test('agents.plugins column defaults to "[]" on legacy rows', () => {
    // Insert a row using raw SQL so we *don't* pass plugins — proves the
    // column default kicks in for migrations on top of pre-RFC-031 data.
    db.run(sql`INSERT INTO agents (id, name) VALUES ('a1', 'legacy')`)

    const rows = db.select().from(agents).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.plugins).toBe('[]')
    expect(JSON.parse(rows[0]!.plugins)).toEqual([])
  })

  test('agents.plugins stores JSON string[]', () => {
    db.insert(agents)
      .values({
        id: ulid(),
        name: 'auditor',
        plugins: JSON.stringify(['dd-trace', 'opencode-changelog']),
      })
      .run()

    const rows = db.select().from(agents).all()
    expect(JSON.parse(rows[0]!.plugins)).toEqual(['dd-trace', 'opencode-changelog'])
  })
})
