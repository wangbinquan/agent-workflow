// RFC-050 — getDistillJobDetail surfaces the per-job output language.
//
// The detail page header renders "Output language: zh-CN / en-US / default".
// Behaviour locked here:
//   - row with explicit zh-CN / en-US → detail.job.outputLang matches
//   - legacy row (output_lang NULL, pre-migration 0027 or pre-RFC-050) →
//     detail.job.outputLang is null; the frontend renders "EN (default)"
//   - corrupt value persisted somehow (e.g. manual SQL edit) is sanitised
//     to null rather than leaking through (defence-in-depth at the
//     decorator boundary).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memoryDistillJobs } from '../src/db/schema'
import { getDistillJobDetail } from '../src/services/memoryDistillJobDetail'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedJob(db: DbClient, outputLang: string | null | undefined): string {
  const id = ulid()
  db.insert(memoryDistillJobs)
    .values({
      id,
      debounceKey: 'k-' + id.slice(-6),
      sourceKind: 'feedback',
      sourceEventId: 'evt-' + id.slice(-6),
      taskId: null,
      scopeResolvedJson: '{"agentIds":[],"workflowId":null,"repoId":null,"includeGlobal":true}',
      status: 'done',
      attempts: 0,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
      ...(outputLang !== undefined ? { outputLang } : {}),
    })
    .run()
  return id
}

describe('RFC-050 getDistillJobDetail — outputLang', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('zh-CN job → detail.job.outputLang === "zh-CN"', async () => {
    const jobId = seedJob(db, 'zh-CN')
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBe('zh-CN')
  })

  test('en-US job → detail.job.outputLang === "en-US"', async () => {
    const jobId = seedJob(db, 'en-US')
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBe('en-US')
  })

  test('legacy row (NULL) → detail.job.outputLang === null', async () => {
    const jobId = seedJob(db, null)
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBeNull()
  })

  test('omitted on insert (driver default) → detail.job.outputLang === null', async () => {
    const jobId = seedJob(db, undefined)
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBeNull()
  })

  test('corrupt value (manual SQL edit) sanitised to null', async () => {
    const jobId = seedJob(db, 'zh-CN')
    // Simulate someone manually flipping the column to a stray value.
    db.run(`UPDATE memory_distill_jobs SET output_lang='ja-JP' WHERE id='${jobId}'` as never)
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBeNull()
  })
})
