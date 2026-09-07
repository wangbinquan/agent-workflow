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

import { beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { memoryDistillJobs } from '../src/db/schema'
import { composeMemoryDistillQueries } from '../src/modules/memory/composition'

function getDistillJobDetail(db: ProviderNeutralDatabase, jobId: string) {
  return composeMemoryDistillQueries(db).getJobDetail(jobId)
}

async function seedJob(
  db: ProviderNeutralDatabase,
  outputLang: string | null | undefined,
): Promise<string> {
  const id = ulid()
  await db.insert(memoryDistillJobs).values({
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
  return id
}

describeEachProvider('RFC-050 getDistillJobDetail — outputLang', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = harness.db
  })

  test('zh-CN job → detail.job.outputLang === "zh-CN"', async () => {
    const jobId = await seedJob(db, 'zh-CN')
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBe('zh-CN')
  })

  test('en-US job → detail.job.outputLang === "en-US"', async () => {
    const jobId = await seedJob(db, 'en-US')
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBe('en-US')
  })

  test('legacy row (NULL) → detail.job.outputLang === null', async () => {
    const jobId = await seedJob(db, null)
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBeNull()
  })

  test('omitted on insert (driver default) → detail.job.outputLang === null', async () => {
    const jobId = await seedJob(db, undefined)
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBeNull()
  })

  test('corrupt value (manual SQL edit) sanitised to null', async () => {
    const jobId = await seedJob(db, 'zh-CN')
    // Simulate someone manually flipping the column to a stray value.
    await db
      .update(memoryDistillJobs)
      .set({ outputLang: 'ja-JP' })
      .where(eq(memoryDistillJobs.id, jobId))
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.outputLang).toBeNull()
  })
})
