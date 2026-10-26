// RFC-371 v2 §7 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// migration 0256 retires the v1 observation store. Upgrading from 0255 must
// drop every change-capture trigger v1 put on other contexts' tables and every
// v1 observation table, keep business rows, leave task / node-run writes with no
// observation side effects, and create exactly the three v2 tables. The
// PostgreSQL step 0032 must drop the capture triggers and their functions
// before it drops the tables.
import {
  migrateFrozenSqlite as migrate,
  freezeAt,
  FROZEN_MIGRATIONS,
  FROZEN_POSTGRESQL_MIGRATIONS,
} from './migration-freeze'
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

const V2_TABLES = ['observation_call_models', 'observation_calls', 'observation_prices']
/** Every v1 observation table name shape (v2 reuses only the `observation_` prefix). */
const RETIRED = /^observation_|native_usage|_observation_/
const THROUGH_0255 = 254

function statements(file: string): string[] {
  return readFileSync(resolve(FROZEN_MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
}

function schemaNames(raw: Database, type: 'table' | 'trigger'): string[] {
  return (
    raw.query(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as {
      name: string
    }[]
  ).map((row) => row.name)
}

function observationTriggers(raw: Database): string[] {
  return (
    raw
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND (name LIKE 'obs\\_%' ESCAPE '\\' OR sql LIKE '%observation\\_%' ESCAPE '\\')
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name)
}

function seedBusinessRows(raw: Database, suffix: string): void {
  raw
    .query(`INSERT INTO workflows (id, name, definition) VALUES (?, 'wf', '{}')`)
    .run(`wf-${suffix}`)
  raw
    .query(
      `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at)
       VALUES (?, 'task', ?, '{}', '/tmp/never-read', '/tmp/never-read', 'main', ?, 'running', '{}', 1)`,
    )
    .run(`t-${suffix}`, `wf-${suffix}`, `agent-workflow/t-${suffix}`)
  raw
    .query(
      `INSERT INTO node_runs (id, task_id, node_id, status, retry_index, iteration)
       VALUES (?, ?, 'plan', 'running', 0, 0)`,
    )
    .run(`nr-${suffix}`, `t-${suffix}`)
}

describe('migration 0256 — RFC-371 observation v2', () => {
  test('upgrading from 0255 removes the v1 store and keeps business rows', () => {
    const through0255 = freezeAt(THROUGH_0255)
    const raw = new Database(':memory:')
    try {
      raw.exec('PRAGMA foreign_keys = ON;')
      migrate(drizzle(raw), { migrationsFolder: through0255 })
      // 51 observation_* tables plus 30 task / system-agent native usage and source tables.
      const v1Tables = schemaNames(raw, 'table').filter((name) => RETIRED.test(name))
      expect(v1Tables.length).toBe(81)
      // v1 captured changes of other contexts' tables through triggers.
      const capture = observationTriggers(raw)
      expect(capture.length).toBeGreaterThan(0)
      expect(capture.some((name) => name.includes('_tasks_'))).toBe(true)
      seedBusinessRows(raw, 'before')

      raw.exec('BEGIN')
      for (const statement of statements('0256_rfc371_observation_v2.sql')) raw.exec(statement)
      raw.exec('COMMIT')

      expect(schemaNames(raw, 'table').filter((name) => RETIRED.test(name))).toEqual(V2_TABLES)
      expect(observationTriggers(raw)).toEqual([])
      expect(raw.query(`SELECT id, status FROM tasks`).all()).toEqual([
        { id: 't-before', status: 'running' },
      ])
      // Writes on the former capture sources no longer touch any observation table.
      raw.query(`UPDATE tasks SET status = 'done', finished_at = 2 WHERE id = 't-before'`).run()
      raw.query(`UPDATE node_runs SET status = 'done' WHERE id = 'nr-before'`).run()
      seedBusinessRows(raw, 'after')
      for (const table of V2_TABLES)
        expect(raw.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
      expect(raw.query(`PRAGMA foreign_key_check`).all()).toEqual([])
    } finally {
      raw.close()
      rmSync(through0255, { recursive: true, force: true })
    }
  })

  test('a fresh database has only the v2 tables, their indexes and checks', () => {
    const raw = new Database(':memory:')
    const all = freezeAt(255)
    try {
      raw.exec('PRAGMA foreign_keys = ON;')
      migrate(drizzle(raw), { migrationsFolder: all })
      expect(schemaNames(raw, 'table').filter((name) => name.startsWith('observation_'))).toEqual(
        V2_TABLES,
      )
      expect(observationTriggers(raw)).toEqual([])
      const indexes = (
        raw
          .query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN (${V2_TABLES.map(() => '?').join(',')})
             AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
          )
          .all(...V2_TABLES) as { name: string }[]
      ).map((row) => row.name)
      expect(indexes.length).toBeGreaterThanOrEqual(4)
      raw
        .query(
          `INSERT INTO observation_calls (id, purpose, agent_name, protocol, status, started_at, usage_state, cost_state, updated_at)
           VALUES ('c1', 'task', 'planner', 'opencode', 'running', 1, 'pending', 'none', 1)`,
        )
        .run()
      // CHECK constraints reject states outside the contract.
      expect(() =>
        raw
          .query(
            `INSERT INTO observation_calls (id, purpose, agent_name, protocol, status, started_at, usage_state, cost_state, updated_at)
             VALUES ('c2', 'task', 'planner', 'opencode', 'paused', 1, 'pending', 'none', 1)`,
          )
          .run(),
      ).toThrow()
      raw
        .query(
          `INSERT INTO observation_call_models (call_id, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_state)
           VALUES ('c1', 'm', 1, 0, 0, 1, 0, 'unpriced')`,
        )
        .run()
      // Model rows go with their call.
      raw.query(`DELETE FROM observation_calls WHERE id = 'c1'`).run()
      expect(raw.query(`SELECT count(*) AS n FROM observation_call_models`).get()).toEqual({ n: 0 })
    } finally {
      raw.close()
      rmSync(all, { recursive: true, force: true })
    }
  })

  test('PostgreSQL 0032 drops capture triggers and functions before the tables', () => {
    const sql = readFileSync(
      resolve(FROZEN_POSTGRESQL_MIGRATIONS, '0032_rfc371_observation_v2.sql'),
      'utf8',
    )
    const position = (pattern: RegExp) => {
      const found: number[] = []
      for (const match of sql.matchAll(pattern)) found.push(match.index ?? 0)
      return found
    }
    const triggers = position(/^DROP TRIGGER /gm)
    const functions = position(/^DROP FUNCTION /gm)
    const tables = position(/^DROP TABLE /gm)
    const creates = position(/^CREATE TABLE /gm)
    expect(triggers.length).toBeGreaterThan(0)
    expect(functions.length).toBeGreaterThan(0)
    expect(tables.length).toBe(81)
    expect(Math.max(...triggers, ...functions)).toBeLessThan(Math.min(...tables))
    expect(Math.max(...tables)).toBeLessThan(Math.min(...creates))
    for (const table of V2_TABLES) expect(sql).toContain(`CREATE TABLE "agent_workflow"."${table}"`)
    // Capture triggers on surviving business tables are dropped by name.
    expect(sql).toMatch(/DROP TRIGGER "[^"]+" ON "agent_workflow"\."tasks";/)
  })
})
