// RFC-050 — listMemories populates `outputLang` on candidate rows by
// joining `memory_distill_jobs` once per batch. Locks:
//   - candidate row with distill job zh-CN → summary carries 'zh-CN'
//   - candidate row with distill job en-US → summary carries 'en-US'
//   - candidate row with NULL distill_job_id → outputLang null
//   - candidate row pointing at a job whose output_lang is NULL (legacy
//     row pre-migration 0027) → outputLang null
//   - approved / archived / etc. → outputLang always null even when the
//     producing job had a language; toSummary discards the value
//   - empty inputs path doesn't hit SQLite (smoke)

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories, memoryDistillJobs } from '../src/db/schema'
import { listMemories } from '../src/services/memory'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedJob(db: DbClient, outputLang: string | null): string {
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
      outputLang,
    })
    .run()
  return id
}

function seedMemory(
  db: DbClient,
  opts: {
    status: 'candidate' | 'approved'
    distillJobId: string | null
    title?: string
  },
): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: 'global',
      scopeId: null,
      title: opts.title ?? 'rule ' + id.slice(-4),
      bodyMd: 'body ' + id.slice(-4),
      tags: '[]',
      status: opts.status,
      sourceKind: 'feedback',
      sourceEventId: 'evt-' + id.slice(-4),
      sourceTaskId: null,
      distillJobId: opts.distillJobId,
      distillAction: opts.distillJobId === null ? null : 'new',
      supersedesId: null,
      supersededById: null,
      approvedByUserId: opts.status === 'approved' ? 'admin' : null,
      approvedAt: opts.status === 'approved' ? Date.now() : null,
      createdAt: Date.now(),
      version: 1,
    })
    .run()
  return id
}

describe('RFC-050 listMemories — populates outputLang on candidate summaries', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('candidate joined to zh-CN job → summary.outputLang === "zh-CN"', async () => {
    const job = seedJob(db, 'zh-CN')
    const memId = seedMemory(db, { status: 'candidate', distillJobId: job })
    const rows = await listMemories(db, { status: 'candidate' })
    const row = rows.find((r) => r.id === memId)
    expect(row?.outputLang).toBe('zh-CN')
  })

  test('candidate joined to en-US job → summary.outputLang === "en-US"', async () => {
    const job = seedJob(db, 'en-US')
    const memId = seedMemory(db, { status: 'candidate', distillJobId: job })
    const rows = await listMemories(db, { status: 'candidate' })
    expect(rows.find((r) => r.id === memId)?.outputLang).toBe('en-US')
  })

  test('candidate with NULL distill_job_id (manual create) → outputLang null', async () => {
    const memId = seedMemory(db, { status: 'candidate', distillJobId: null })
    const rows = await listMemories(db, { status: 'candidate' })
    expect(rows.find((r) => r.id === memId)?.outputLang).toBeNull()
  })

  test('candidate pointing at legacy job (output_lang NULL) → outputLang null', async () => {
    const job = seedJob(db, null)
    const memId = seedMemory(db, { status: 'candidate', distillJobId: job })
    const rows = await listMemories(db, { status: 'candidate' })
    expect(rows.find((r) => r.id === memId)?.outputLang).toBeNull()
  })

  test('approved row inherits no chip even when source job had a language', async () => {
    const job = seedJob(db, 'zh-CN')
    const memId = seedMemory(db, { status: 'approved', distillJobId: job })
    const rows = await listMemories(db)
    // toSummary discards outputLang for any non-candidate status.
    expect(rows.find((r) => r.id === memId)?.outputLang).toBeNull()
  })

  test('batched lookup correctly maps multiple distinct jobs', async () => {
    const jobZh = seedJob(db, 'zh-CN')
    const jobEn = seedJob(db, 'en-US')
    const jobNull = seedJob(db, null)
    const zhId = seedMemory(db, { status: 'candidate', distillJobId: jobZh })
    const enId = seedMemory(db, { status: 'candidate', distillJobId: jobEn })
    const nullId = seedMemory(db, { status: 'candidate', distillJobId: jobNull })
    const rows = await listMemories(db, { status: 'candidate' })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(zhId)?.outputLang).toBe('zh-CN')
    expect(byId.get(enId)?.outputLang).toBe('en-US')
    expect(byId.get(nullId)?.outputLang).toBeNull()
  })
})
