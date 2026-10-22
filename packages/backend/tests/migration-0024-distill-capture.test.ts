// RFC-043 T1 — locks migration 0024: memory_distill_jobs gains 5 nullable
// columns (opencode_session_id / user_prompt_md / exit_code / stderr_excerpt
// / dedup_snapshot_ids_json) plus the new memory_distill_events table.
//
// If this test fails, the distill job detail page can no longer persist
// per-attempt artefacts; admin loses the ability to audit a distill run.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { queryWrite, first, queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedDistillJob(
  db: DbClient,
  overrides: Partial<PersistenceTables['memoryDistillJobs']['$inferInsert']> = {},
) {
  const jobId = ulid()
  const { memoryDistillJobs } = tablesOf(db)
  insertOne(db, memoryDistillJobs, {
    id: jobId,
    debounceKey: 'task-x:clarify',
    sourceKind: 'clarify',
    sourceEventId: 'src-1',
    taskId: null,
    scopeResolvedJson: '{}',
    status: 'pending',
    attempts: 0,
    nextRunAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  })
  return jobId
}

describe('migration 0024 (RFC-043 distill capture columns + events table)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('memory_distill_jobs accepts and reads back the 5 new RFC-043 columns', () => {
    const jobId = seedDistillJob(db)
    const { memoryDistillJobs } = tablesOf(db)
    queryWrite(
      db
        .update(memoryDistillJobs)
        .set({
          opencodeSessionId: 'sess-abc',
          userPromptMd: 'prompt body markdown',
          exitCode: 0,
          stderrExcerpt: 'truncated stderr',
          dedupSnapshotIdsJson: '{"snapshot":[]}',
        })
        .where(eq(memoryDistillJobs.id, jobId)),
    )
    const row = first(db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)))
    expect(row?.opencodeSessionId).toBe('sess-abc')
    expect(row?.userPromptMd).toBe('prompt body markdown')
    expect(row?.exitCode).toBe(0)
    expect(row?.stderrExcerpt).toBe('truncated stderr')
    expect(row?.dedupSnapshotIdsJson).toBe('{"snapshot":[]}')

    // Legacy (pre-RFC-043) jobs leave the columns as NULL.
    const legacyId = seedDistillJob(db)
    const legacy = first(
      db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, legacyId)),
    )
    expect(legacy?.opencodeSessionId).toBeNull()
    expect(legacy?.userPromptMd).toBeNull()
    expect(legacy?.exitCode).toBeNull()
    expect(legacy?.stderrExcerpt).toBeNull()
    expect(legacy?.dedupSnapshotIdsJson).toBeNull()
  })

  test('memory_distill_events stores rows and CASCADE-deletes with the parent job', () => {
    const jobId = seedDistillJob(db)
    const { memoryDistillEvents, memoryDistillJobs } = tablesOf(db)
    insertOne(db, memoryDistillEvents, {
      distillJobId: jobId,
      attemptIndex: 0,
      sessionId: 'sess-1',
      parentSessionId: null,
      ts: 1,
      kind: 'text',
      payload: '{"part":{"type":"text","text":"hi"}}',
    })
    insertOne(db, memoryDistillEvents, {
      distillJobId: jobId,
      attemptIndex: 1,
      sessionId: 'sess-2',
      parentSessionId: 'sess-1',
      ts: 2,
      kind: 'tool_use',
      payload: '{"part":{"type":"tool"}}',
    })
    expect(
      queryRows(
        db.select().from(memoryDistillEvents).where(eq(memoryDistillEvents.distillJobId, jobId)),
      ),
    ).toHaveLength(2)

    queryWrite(db.delete(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)))
    const remaining = queryRows(
      db.select().from(memoryDistillEvents).where(eq(memoryDistillEvents.distillJobId, jobId)),
    )
    expect(remaining).toHaveLength(0)

    // Both expected indexes carry the new columns.
    const indexes = queryRows(
      db
        .select({ name: sql<string>`name`, ddl: sql<string>`sql` })
        .from(sql`sqlite_master`)
        .where(sql`type = 'index' AND tbl_name = 'memory_distill_events'`),
    )
    const byName = new Map(indexes.map((r) => [r.name, r.ddl.toLowerCase()]))
    expect(byName.get('idx_distill_events_job_attempt')).toContain('attempt_index')
    expect(byName.get('idx_distill_events_session')).toContain('session_id')
  })
})
