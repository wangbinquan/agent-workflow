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

import {
  frozenTablesOf,
  createFrozenEpoch1Db,
  type FrozenDbClient,
  FROZEN_MIGRATIONS,
} from './migration-freeze'
import { insertOne } from '@/platform/persistence/singleInsert'
import { queryRows, rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
const MIGRATIONS = resolve(FROZEN_MIGRATIONS)

describe('migration 0014 (RFC-031 plugins + agents.plugins)', () => {
  let db: FrozenDbClient
  beforeEach(() => {
    db = createFrozenEpoch1Db(MIGRATIONS)
  })

  test('plugins table exists with unique name + sensible defaults', () => {
    const id = ulid()
    const { plugins } = frozenTablesOf(db)
    insertOne(db, plugins, {
      id,
      name: 'dd-trace',
      spec: '@mycorp/opencode-dd-trace@2.4.1',
      sourceKind: 'npm',
      cachedPath: '/home/u/.agent-workflow/plugins/dd/node_modules/@mycorp/opencode-dd-trace',
      resolvedVersion: '2.4.1',
      installedAt: Date.now(),
    })

    const rows = queryRows(db.select().from(plugins))
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
    const { plugins } = frozenTablesOf(db)
    insertOne(db, plugins, {
      id: ulid(),
      name: 'shared',
      spec: 'a@1',
      sourceKind: 'npm',
      cachedPath: '/tmp/a',
      installedAt: Date.now(),
    })
    expect(() => {
      return insertOne(db, plugins, {
        id: ulid(),
        name: 'shared',
        spec: 'b@2',
        sourceKind: 'npm',
        cachedPath: '/tmp/b',
        installedAt: Date.now(),
      })
    }).toThrow()
  })

  test('plugins.sourceKind accepts npm / file / git only', () => {
    for (const sk of ['npm', 'file', 'git'] as const) {
      const { plugins } = frozenTablesOf(db)
      insertOne(db, plugins, {
        id: ulid(),
        name: `p-${sk}`,
        spec: 's',
        sourceKind: sk,
        cachedPath: '/tmp',
        installedAt: Date.now(),
      })
    }
    const { plugins } = frozenTablesOf(db)
    expect(queryRows(db.select().from(plugins))).toHaveLength(3)
  })

  test('plugins.resolvedVersion may be NULL', () => {
    const { plugins } = frozenTablesOf(db)
    insertOne(db, plugins, {
      id: ulid(),
      name: 'partial',
      spec: 'file:///tmp/x',
      sourceKind: 'file',
      cachedPath: '/tmp/x',
      resolvedVersion: null,
      installedAt: Date.now(),
    })
    const r = queryRows(db.select().from(plugins))[0]!
    expect(r.resolvedVersion).toBeNull()
  })

  test('agents.plugins column defaults to "[]" on legacy rows', () => {
    // Insert a row using raw SQL so we *don't* pass plugins — proves the
    // column default kicks in for migrations on top of pre-RFC-031 data.
    rawExec(db, sql`INSERT INTO agents (id, name) VALUES ('a1', 'legacy')`)

    const { agents } = frozenTablesOf(db)
    const rows = queryRows(db.select().from(agents))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.plugins).toBe('[]')
    expect(JSON.parse(rows[0]!.plugins)).toEqual([])
  })

  test('agents.plugins stores JSON string[]', () => {
    const { agents } = frozenTablesOf(db)
    insertOne(db, agents, {
      id: ulid(),
      name: 'auditor',
      plugins: JSON.stringify(['dd-trace', 'opencode-changelog']),
    })

    const rows = queryRows(db.select().from(agents))
    expect(JSON.parse(rows[0]!.plugins)).toEqual(['dd-trace', 'opencode-changelog'])
  })
})
