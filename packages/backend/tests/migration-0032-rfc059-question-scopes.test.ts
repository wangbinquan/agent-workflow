// RFC-059 T2 — migration 0032 adds nullable `question_scopes_json TEXT`
// columns to BOTH `cross_clarify_sessions` (legacy reader for
// `buildExternalFeedbackContext`) and `clarify_rounds` (unified reader for
// `buildPromptContext` cross-questioner branch). The submit handler dual-
// writes the same JSON to both columns; readers may diverge over RFC-058's
// dual-write era, so the column has to land on both tables together or the
// dual-write will fail silently with a SQLite "no such column" error.
//
// Why these tests exist:
//   1. The migration must be `IDX 31` in the drizzle journal (we land
//      after RFC-058's 0031), AND the SQL file must define both ALTER
//      TABLE statements (single line each, plain TEXT NULLABLE).
//   2. New rows persisted post-migration must default `question_scopes_json`
//      to NULL on both tables (so RFC-056/058 behaviour is preserved when
//      the client doesn't send `questionScopes`).
//   3. Existing rows (seeded BEFORE this migration, via the migrator)
//      reach the new state with NULL in the new column — the runtime
//      reader treats NULL as "every question is 'designer'", and any
//      regression that fails to set NULL would break that compat path.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const MIGRATION_FILE = resolve(MIGRATIONS, '0032_rfc059_clarify_rounds_question_scopes.sql')

async function seedTask(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const id = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${id}`
  const def = { $schema_version: 3, inputs: [], nodes: [], edges: [], outputs: [] }
  await db.insert(workflows).values({
    id: wfId,
    name: 'mig-test',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id,
    name: 'mig-test',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-mig-0032/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return id
}

describe('RFC-059 migration 0032 — table schema changes', () => {
  test('migration file exists and ALTERs BOTH tables (cross_clarify_sessions + clarify_rounds)', () => {
    const sqlText = readFileSync(MIGRATION_FILE, 'utf8')
    expect(sqlText).toMatch(/ALTER TABLE [`"]?cross_clarify_sessions[`"]? ADD COLUMN/i)
    expect(sqlText).toMatch(/ALTER TABLE [`"]?clarify_rounds[`"]? ADD COLUMN/i)
    expect(sqlText).toContain('question_scopes_json')
  })

  test('cross_clarify_sessions has question_scopes_json TEXT NULLABLE post-migrate', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db
      .select({
        name: sql<string>`name`,
        type: sql<string>`type`,
        notnull: sql<number>`"notnull"`,
        dflt_value: sql<string | null>`dflt_value`,
      })
      .from(sql`pragma_table_info('cross_clarify_sessions')`)
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    const col = cols.find((c) => c.name === 'question_scopes_json')
    expect(col).toBeDefined()
    expect(col?.type.toUpperCase()).toBe('TEXT')
    expect(col?.notnull).toBe(0) // nullable
    expect(col?.dflt_value).toBeNull() // no default
  })

  test('clarify_rounds has question_scopes_json TEXT NULLABLE post-migrate', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db
      .select({
        name: sql<string>`name`,
        type: sql<string>`type`,
        notnull: sql<number>`"notnull"`,
        dflt_value: sql<string | null>`dflt_value`,
      })
      .from(sql`pragma_table_info('clarify_rounds')`)
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    const col = cols.find((c) => c.name === 'question_scopes_json')
    expect(col).toBeDefined()
    expect(col?.type.toUpperCase()).toBe('TEXT')
    expect(col?.notnull).toBe(0) // nullable
    expect(col?.dflt_value).toBeNull() // no default
  })
})

describe('RFC-059 migration 0032 — runtime behavior', () => {
  test('inserts into cross_clarify_sessions without questionScopesJson default to NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_c',
      taskId,
      nodeId: 'cc1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(crossClarifySessions).values({
      id: 'sess_a',
      taskId,
      crossClarifyNodeId: 'cc1',
      crossClarifyNodeRunId: 'nr_c',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      targetDesignerNodeId: 'designer',
      iteration: 0,
      questionsJson: '[]',
    })
    const rows = db
      .select({ q: crossClarifySessions.questionScopesJson })
      .from(crossClarifySessions)
      .all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.q).toBeNull()
  })

  test('inserts into clarify_rounds without questionScopesJson default to NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_c',
      taskId,
      nodeId: 'cc1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(clarifyRounds).values({
      id: 'rnd_a',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_c',
      iteration: 0,
      questionsJson: '[]',
      status: 'awaiting_human',
    })
    const rows = db.select({ q: clarifyRounds.questionScopesJson }).from(clarifyRounds).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.q).toBeNull()
  })

  test('roundtrips a JSON map through both tables (dual-write byte-equivalence)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q2',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_c2',
      taskId,
      nodeId: 'cc1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const payload = JSON.stringify({ q1: 'designer', q2: 'questioner' })
    await db.insert(crossClarifySessions).values({
      id: 'sess_b',
      taskId,
      crossClarifyNodeId: 'cc1',
      crossClarifyNodeRunId: 'nr_c2',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q2',
      targetDesignerNodeId: 'designer',
      iteration: 0,
      questionsJson: '[]',
      questionScopesJson: payload,
    })
    await db.insert(clarifyRounds).values({
      id: 'rnd_b',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q2',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_c2',
      iteration: 0,
      questionsJson: '[]',
      status: 'awaiting_human',
      questionScopesJson: payload,
    })
    const legacy = db
      .select({ q: crossClarifySessions.questionScopesJson })
      .from(crossClarifySessions)
      .all()
    const unified = db.select({ q: clarifyRounds.questionScopesJson }).from(clarifyRounds).all()
    expect(legacy[0]?.q).toBe(payload)
    expect(unified[0]?.q).toBe(payload)
  })
})
