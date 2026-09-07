// RFC-050 — locks enqueueDistillJob's output-language plumbing.
//
//   - explicit `outputLang` wins over the ambient provider
//   - ambient provider (registered by cli/start.ts via
//     setMemoryDistillLangProvider) is consulted when the call site omits
//     outputLang — this is the production path for review.ts /
//     clarify.ts / taskFeedback.ts which never pass it explicitly
//   - no provider + no explicit → DB row keeps NULL (RFC-041 baseline)
//   - merged-sibling reruns sharing one debounce_key all carry the
//     same outputLang because each enqueue snapshots independently
//     and distillTick passes the head row's MemoryDistillJob.outputLang
//     into runDistill; we lock the per-row capture invariant here.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { memoryDistillJobs } from '../src/db/schema'
import {
  enqueueDistillJob,
  resetMemoryDistillLangProviderForTest,
  setMemoryDistillLangProvider,
} from '../src/modules/memory/application/distill/schedule'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { createMemoryDistillSessionCapture } from '../src/modules/memory/infrastructure/memoryDistillSessionCapture'

describeEachProvider('RFC-050 enqueueDistillJob — output language snapshot', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: { store: DrizzleMemoryDistillWorkStore }

  beforeEach(() => {
    resetBroadcastersForTests()
    resetMemoryDistillLangProviderForTest()
    db = harness.db
    memory = { store: new DrizzleMemoryDistillWorkStore(db, createMemoryDistillSessionCapture(db)) }
  })

  afterEach(() => {
    resetMemoryDistillLangProviderForTest()
  })

  test('explicit outputLang wins over the ambient provider', async () => {
    setMemoryDistillLangProvider(() => 'en-US')
    const { jobId } = await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'evt-1',
      taskId: null,
      outputLang: 'zh-CN',
    })
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBe('zh-CN')
  })

  test('ambient provider used when explicit outputLang omitted (production path)', async () => {
    setMemoryDistillLangProvider(() => 'zh-CN')
    const { jobId } = await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'evt-2',
      taskId: null,
    })
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBe('zh-CN')
  })

  test('no provider + no explicit → DB row carries NULL (RFC-041 baseline)', async () => {
    const { jobId } = await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'evt-3',
      taskId: null,
    })
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBeNull()
  })

  test('explicit null overrides a provider-set language → DB row NULL', async () => {
    setMemoryDistillLangProvider(() => 'zh-CN')
    const { jobId } = await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'evt-4',
      taskId: null,
      outputLang: null,
    })
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBeNull()
  })

  test('two enqueues sharing one debounce_key each snapshot independently', async () => {
    // The scheduler will later merge siblings sharing the same debounce_key
    // into one distill batch and pass the HEAD row to runDistill. We lock
    // that each row independently captures whatever the provider returns
    // at the moment of its own enqueue — so even if admin flips the config
    // between the two enqueues, the HEAD row's language is well-defined
    // and stable through retry.
    let current: 'zh-CN' | 'en-US' = 'zh-CN'
    setMemoryDistillLangProvider(() => current)
    const a = await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'sibling-a',
      taskId: 't-shared',
    })
    current = 'en-US'
    const b = await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'sibling-b',
      taskId: 't-shared',
    })
    // (Same debounceKey because (taskId, sourceKind) identical for feedback.)
    expect(a.debounceKey).toBe(b.debounceKey)
    const rowA = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, a.jobId))
      .get()
    const rowB = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, b.jobId))
      .get()
    expect(rowA?.outputLang).toBe('zh-CN')
    expect(rowB?.outputLang).toBe('en-US')
  })
})
