// RFC-050 — locks migration 0027: memory_distill_jobs gains a nullable
// `output_lang` column. Legacy rows (pre-RFC-050, inserted without the
// field) come back with outputLang == NULL; the distiller layer treats
// NULL as 'en-US' so RFC-041 byte-level baseline is preserved.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memoryDistillJobs } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function baseJobRow(overrides: { id: string; outputLang?: string | null }) {
  return {
    id: overrides.id,
    debounceKey: 'fixture-' + overrides.id.slice(-6),
    sourceKind: 'feedback' as const,
    sourceEventId: 'evt-' + overrides.id.slice(-6),
    taskId: null,
    scopeResolvedJson: JSON.stringify({ scopeType: 'global', scopeId: null }),
    status: 'pending' as const,
    attempts: 0,
    nextRunAt: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    ...(overrides.outputLang !== undefined ? { outputLang: overrides.outputLang } : {}),
  }
}

describe('migration 0027 (RFC-050 memory_distill_jobs.output_lang)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('M1: column stores zh-CN / en-US and round-trips', () => {
    const zhId = ulid()
    const enId = ulid()
    db.insert(memoryDistillJobs)
      .values(baseJobRow({ id: zhId, outputLang: 'zh-CN' }))
      .run()
    db.insert(memoryDistillJobs)
      .values(baseJobRow({ id: enId, outputLang: 'en-US' }))
      .run()
    const rows = db.select().from(memoryDistillJobs).all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(zhId)?.outputLang).toBe('zh-CN')
    expect(byId.get(enId)?.outputLang).toBe('en-US')
  })

  test('M2: row inserted without output_lang comes back NULL (legacy / default)', () => {
    const id = ulid()
    db.insert(memoryDistillJobs).values(baseJobRow({ id })).run()
    const row = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).get()
    expect(row?.outputLang).toBeNull()
  })

  test('M3: explicit NULL is preserved (admin can revert from explicit to default)', () => {
    const id = ulid()
    db.insert(memoryDistillJobs)
      .values(baseJobRow({ id, outputLang: 'zh-CN' }))
      .run()
    db.update(memoryDistillJobs).set({ outputLang: null }).where(eq(memoryDistillJobs.id, id)).run()
    const row = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).get()
    expect(row?.outputLang).toBeNull()
  })
})
