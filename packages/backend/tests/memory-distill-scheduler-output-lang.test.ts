// RFC-050 — locks enqueueDistillJob's output-language plumbing.
//
//   - explicit `outputLang` wins over the ambient provider
//   - the ambient provider (registered by cli/start.ts) is consulted when the
//     call site omits outputLang — this is the production path for review.ts /
//     clarify.ts / taskFeedback.ts which never pass it explicitly.
//     RFC-366 T6/T8 folded the former standalone language provider into the
//     distill POLICY provider, so the language now arrives as
//     `DistillPolicy.outputLang`. The assertions below are unchanged: what is
//     locked is still "explicit wins / ambient fills in / neither ⇒ NULL", only
//     the seam that carries it is now the one the admission gate already reads.
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
  resetMemoryDistillPolicyProviderForTest,
  setMemoryDistillPolicyProvider,
} from '../src/modules/memory/application/distill/schedule'
import { DEFAULT_DISTILL_POLICY, type Language } from '@agent-workflow/shared'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'

/**
 * RFC-366: `enqueueDistillJob` now returns null when the admission gate declines
 * the event. Every case in this file uses a manual-origin (or task-less) fixture,
 * so a null here means the gate regressed — fail loudly rather than `!`-away.
 */
function admitted<T>(result: T | null): T {
  if (result === null) throw new Error('distill enqueue was unexpectedly rejected')
  return result
}

/**
 * Register only the language half of the policy and leave every admission knob
 * at its default. These cases are about `outputLang`, not about the gate, and a
 * hand-rolled policy literal here would start silently rejecting if the defaults
 * ever moved.
 */
function setAmbientLang(read: () => Language | null): void {
  setMemoryDistillPolicyProvider(() => ({ ...DEFAULT_DISTILL_POLICY, outputLang: read() }))
}

describeEachProvider('RFC-050 enqueueDistillJob — output language snapshot', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: { store: DrizzleMemoryDistillWorkStore }

  beforeEach(() => {
    resetBroadcastersForTests()
    resetMemoryDistillPolicyProviderForTest()
    db = harness.db
    memory = { store: new DrizzleMemoryDistillWorkStore(db) }
  })

  afterEach(() => {
    resetMemoryDistillPolicyProviderForTest()
  })

  test('explicit outputLang wins over the ambient provider', async () => {
    setAmbientLang(() => 'en-US')
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'evt-1',
        taskId: null,
        outputLang: 'zh-CN',
      }),
    )
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBe('zh-CN')
  })

  test('ambient provider used when explicit outputLang omitted (production path)', async () => {
    setAmbientLang(() => 'zh-CN')
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'evt-2',
        taskId: null,
      }),
    )
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBe('zh-CN')
  })

  test('no provider + no explicit → DB row carries NULL (RFC-041 baseline)', async () => {
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'evt-3',
        taskId: null,
      }),
    )
    const row = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .get()
    expect(row?.outputLang).toBeNull()
  })

  test('explicit null overrides a provider-set language → DB row NULL', async () => {
    setAmbientLang(() => 'zh-CN')
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'evt-4',
        taskId: null,
        outputLang: null,
      }),
    )
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
    setAmbientLang(() => current)
    const a = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'sibling-a',
        taskId: 't-shared',
      }),
    )
    current = 'en-US'
    const b = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'sibling-b',
        taskId: 't-shared',
      }),
    )
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
