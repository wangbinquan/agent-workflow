import {
  distillTick,
  startMemoryDistillLoop,
  type RunDistillOptions,
} from './helpers/memoryDistill'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
// RFC-041 — distill scheduler tests (PR2 scope).
//
// Drives `distillTick` synchronously (no setInterval) with a deterministic
// `now` and a fake `runFn` (RFC-367 seam; was `spawnFn`). Locks: debounce_key construction, sibling
// merge, exp-backoff retry math, max-attempts flip to `failed`, recovery
// of leftover `running` rows.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_SOURCE_CONTEXT_BUDGET,
  QUARANTINED_SNAPSHOT_AGENT_ID,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  agents,
  cachedRepos,
  clarifyRounds,
  memoryDistillJobs,
  nodeRunEvents,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  buildDebounceKey,
  cancelPendingJob,
  computeEligibleScopes,
  DISTILL_BACKOFF_BASE_MS,
  DISTILL_MAX_ATTEMPTS,
  enqueueDistillJob,
  extractAgentIdsFromSnapshot,
  extractAgentIdsFromWorkgroupConfig,
  listDistillJobs,
  recoverRunning,
  retryFailedJob,
} from '../src/modules/memory/application/distill/schedule'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { DrizzleMemoryDistillRuntimeResolver } from '../src/modules/memory/infrastructure/memoryDistillRuntimeResolver'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { MemoryDistillSettlementPendingError } from '../src/modules/memory/application/distill/settlement'
import { IndeterminateRuntimeProcessError } from '../src/modules/memory/application/distill/memoryDistiller'

/**
 * RFC-366: `enqueueDistillJob` now returns null when the admission gate declines
 * the event. Every case in this file uses a manual-origin (or task-less) fixture,
 * so a null here means the gate regressed — fail loudly rather than `!`-away.
 */
function admitted<T>(result: T | null): T {
  if (result === null) throw new Error('distill enqueue was unexpectedly rejected')
  return result
}

function createMemoryDistillTestContext(db: ProviderNeutralDatabase) {
  const previousHome = process.env.AGENT_WORKFLOW_HOME
  const root = mkdtempSync(join(tmpdir(), 'memory-distill-provider-'))
  process.env.AGENT_WORKFLOW_HOME = root
  return {
    store: new DrizzleMemoryDistillWorkStore(db),
    runtimeResolver: new DrizzleMemoryDistillRuntimeResolver(db),
    nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(root, 'runs')),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(
      db,
      createFileReviewArtifactContent(root),
    ),
    cleanup() {
      if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type MemoryTestContext = ReturnType<typeof createMemoryDistillTestContext>

function workerDeps(memory: MemoryTestContext) {
  return {
    store: memory.store,
    nodeRunPrompts: memory.nodeRunPrompts,
    reviewedArtifacts: memory.reviewedArtifacts,
    runtimeResolver: memory.runtimeResolver,
  }
}

/** RFC-367: the distiller consumes `runSystemAgent`'s normalized assistant text,
 *  so a fake returns `eventText` rather than raw stdout. The nonce comes back
 *  out of the prompt — the same place the real agent reads it from. */
function emptyDistillerEnvelope(opts: SystemAgentRunOptions): string {
  const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
  return `<workflow-output nonce="${nonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`
}

function okRun(opts: SystemAgentRunOptions, eventText?: string): SystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    eventText: eventText ?? emptyDistillerEnvelope(opts),
    stderrTail: '',
    durationMs: 1,
    scratchDir: `${opts.scratchParent}/${opts.scratchName ?? 'unnamed'}`,
    scratchRetained: true,
    outputEvidence: emptySystemAgentOutputEvidence(),
    capturedSessionId: 'ses_scheduler_probe',
  }
}

const EMPTY_ENVELOPE_RUN: RunDistillOptions['runFn'] = async (opts) => okRun(opts)

async function seedTask(
  db: ProviderNeutralDatabase,
  opts: {
    repoUrl?: string | null
    cachedRepoId?: string | null
    snapshotAgents?: Array<{ id?: string; name: string }>
    workgroupAgentIds?: string[]
  } = {},
): Promise<{ taskId: string; workflowId: string }> {
  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const snapshot = {
    nodes: (opts.snapshotAgents ?? []).map((agent) => ({
      id: `n-${agent.name}`,
      kind: 'agent-single',
      agentName: agent.name,
      ...(agent.id !== undefined ? { agentId: agent.id } : {}),
    })),
  }
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(snapshot),
    repoPath: '/tmp/wt',
    repoUrl: opts.repoUrl ?? null,
    cachedRepoId: opts.cachedRepoId ?? null,
    workgroupConfigJson:
      opts.workgroupAgentIds === undefined
        ? null
        : JSON.stringify({
            workgroupId: 'workgroup-fixture',
            workgroupName: 'fixture',
            mode: 'leader_worker',
            leaderMemberId: 'member-0',
            switches: {
              shareOutputs: true,
              directMessages: false,
              blackboard: false,
            },
            maxRounds: 3,
            completionGate: false,
            instructions: '',
            goal: 'test',
            members: opts.workgroupAgentIds.map((agentId, index) => ({
              id: `member-${index}`,
              memberType: 'agent',
              agentId,
              agentName: `display-${index}`,
              userId: null,
              displayName: `member-${index}`,
              roleDesc: '',
            })),
          }),
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId, workflowId: wfId }
}

describe('buildDebounceKey', () => {
  test('task-scoped events collapse by (task, kind)', () => {
    expect(buildDebounceKey({ sourceKind: 'clarify', sourceEventId: 'e1', taskId: 't1' })).toBe(
      't1:clarify',
    )
    expect(buildDebounceKey({ sourceKind: 'review', sourceEventId: 'e2', taskId: 't1' })).toBe(
      't1:review',
    )
  })
  test('task-less events become unique per source event', () => {
    expect(buildDebounceKey({ sourceKind: 'feedback', sourceEventId: 'e1', taskId: null })).toBe(
      'noTask:feedback:e1',
    )
  })
})

describe('extractAgentIdsFromSnapshot', () => {
  test('returns unique canonical ids and ignores name-only nodes', () => {
    const snap = JSON.stringify({
      nodes: [
        { id: 'a', kind: 'agent-single', agentId: 'ag-codegen', agentName: 'codegen' },
        { id: 'b', kind: 'agent-single', agentId: 'ag-auditor', agentName: 'auditor' },
        { id: 'c', kind: 'wrapper-git' },
        { id: 'd', kind: 'agent-single', agentId: 'ag-codegen', agentName: 'codegen' },
        { id: 'e', kind: 'agent-single', agentName: 'legacy-name-only' },
      ],
    })
    expect(extractAgentIdsFromSnapshot(snap).sort()).toEqual(['ag-auditor', 'ag-codegen'])
  })
  test('malformed JSON → []', () => {
    expect(extractAgentIdsFromSnapshot('{not-json')).toEqual([])
  })
  test('empty nodes → []', () => {
    expect(extractAgentIdsFromSnapshot(JSON.stringify({ nodes: [] }))).toEqual([])
  })
})

describe('extractAgentIdsFromWorkgroupConfig', () => {
  test('returns unique frozen member ids and ignores malformed or quarantined entries', () => {
    expect(
      extractAgentIdsFromWorkgroupConfig(
        JSON.stringify({
          workgroupId: 'workgroup-fixture',
          workgroupName: 'fixture',
          mode: 'leader_worker',
          leaderMemberId: 'member-0',
          switches: {
            shareOutputs: true,
            directMessages: false,
            blackboard: false,
          },
          maxRounds: 3,
          completionGate: false,
          instructions: '',
          goal: 'test',
          members: [
            {
              id: 'member-0',
              memberType: 'agent',
              agentId: 'agent-lead',
              agentName: 'lead',
              userId: null,
              displayName: 'lead',
              roleDesc: '',
            },
            {
              id: 'member-1',
              memberType: 'agent',
              agentId: 'agent-lead',
              agentName: 'lead-again',
              userId: null,
              displayName: 'lead-again',
              roleDesc: '',
            },
            {
              id: 'member-2',
              memberType: 'agent',
              agentId: QUARANTINED_SNAPSHOT_AGENT_ID,
              agentName: 'quarantined',
              userId: null,
              displayName: 'quarantined',
              roleDesc: '',
            },
          ],
        }),
      ),
    ).toEqual(['agent-lead'])
    expect(extractAgentIdsFromWorkgroupConfig('{not-json')).toEqual([])
    expect(
      extractAgentIdsFromWorkgroupConfig(
        JSON.stringify({
          members: [{ memberType: 'agent', agentName: 'legacy-name-only' }],
        }),
      ),
    ).toEqual([])
  })
})

describeEachProvider('computeEligibleScopes', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: MemoryTestContext
  beforeEach(() => {
    db = harness.db
    memory = createMemoryDistillTestContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => memory.cleanup())
  test('null taskId → empty agentIds + workflowId=null + includeGlobal=true', async () => {
    const r = await computeEligibleScopes(memory.store, null)
    expect(r).toEqual({ agentIds: [], workflowId: null, repoId: null, includeGlobal: true })
  })
  test('resolves workflowId + agentIds from frozen ids only', async () => {
    await db.insert(agents).values({
      id: 'agent-codegen',
      name: 'codegen',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
    })
    const { taskId, workflowId } = await seedTask(db, {
      snapshotAgents: [
        { id: 'agent-codegen', name: 'codegen' },
        { name: 'codegen' },
        { name: 'no-such-agent' },
      ],
    })
    const r = await computeEligibleScopes(memory.store, taskId)
    expect(r.workflowId).toBe(workflowId)
    expect(r.agentIds).toEqual(['agent-codegen']) // unknown agent silently dropped
    expect(r.includeGlobal).toBe(true)
  })
  test('includes frozen workgroup member ids when host snapshot nodes are display-only', async () => {
    const { taskId } = await seedTask(db, {
      snapshotAgents: [{ name: 'workgroup-member' }],
      workgroupAgentIds: ['agent-lead', 'agent-worker', 'agent-lead'],
    })
    const r = await computeEligibleScopes(memory.store, taskId)
    expect(r.agentIds).toEqual(['agent-lead', 'agent-worker'])
  })
  // RFC-204: resolves through tasks.cached_repo_id. The previous URL join
  // compared a redacted tasks.repo_url against the plaintext cached_repos.url,
  // so private repos never matched (and once the credential column is blanked it
  // would have matched arbitrary rows on '').
  test('resolves repoId via tasks.cached_repo_id', async () => {
    await db.insert(cachedRepos).values({
      id: 'cr-1',
      urlHash: 'aabbccdd',
      urlRedacted: 'https://github.com/acme/web.git',
      localPath: '/tmp/r',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    const { taskId } = await seedTask(db, {
      repoUrl: 'https://github.com/acme/web.git',
      cachedRepoId: 'cr-1',
    })
    const r = await computeEligibleScopes(memory.store, taskId)
    expect(r.repoId).toBe('cr-1')
  })

  test('a task with no cached mirror resolves to no repo scope', async () => {
    const { taskId } = await seedTask(db, { repoUrl: 'https://github.com/acme/web.git' })
    const r = await computeEligibleScopes(memory.store, taskId)
    expect(r.repoId).toBeNull()
  })
})

describeEachProvider('enqueueDistillJob', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: MemoryTestContext
  beforeEach(() => {
    db = harness.db
    memory = createMemoryDistillTestContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => memory.cleanup())
  test('writes a pending row with next_run_at = now + 5s + correct debounce key', async () => {
    const { taskId } = await seedTask(db)
    const before = Date.now()
    const r = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'c1',
        taskId,
      }),
    )
    expect(r.debounceKey).toBe(`${taskId}:clarify`)
    expect(r.nextRunAt).toBeGreaterThanOrEqual(before + 5_000 - 50)
    const rows = await db.select().from(memoryDistillJobs).all()
    expect(rows.length).toBe(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.attempts).toBe(0)
  })
  test('respects debounceMs override (used by tests + manual control)', async () => {
    const before = Date.now()
    const r = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'feedback',
        sourceEventId: 'f1',
        taskId: null,
        debounceMs: 0,
      }),
    )
    expect(r.nextRunAt).toBeLessThanOrEqual(before + 50)
  })
})

describeEachProvider('distillTick', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: MemoryTestContext
  beforeEach(() => {
    db = harness.db
    memory = createMemoryDistillTestContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => memory.cleanup())

  test('RFC-370 done after a lost write ACK retries its original receipt without failing or executing the bundle again', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'done-ack-lost',
        taskId,
        debounceMs: 0,
      }),
    )
    let now = Date.now() + 1000,
      current = true,
      runs = 0,
      writes = 0
    const finishedAt = now
    const original = memory.store.markDone.bind(memory.store)
    const done = spyOn(memory.store, 'markDone').mockImplementation(async (ids, at) => {
      writes += 1
      await original(ids, at)
      if (writes === 1) throw new Error('original done ACK lost')
    })
    const failed = spyOn(memory.store, 'markFailed').mockImplementation(async () => {
      throw new Error('a completed runtime must not be requeued')
    })
    try {
      const receipt = await distillTick({
        ...workerDeps(memory),
        execution: { current: () => current },
        now: () => now,
        runFn: async (input) => {
          runs += 1
          return okRun(input)
        },
      }).catch((error) => error as unknown)
      expect(receipt).toBeInstanceOf(MemoryDistillSettlementPendingError)
      expect(
        (await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)))[0],
      ).toMatchObject({ status: 'done', attempts: 0, finishedAt })
      current = false
      now += 100_000
      await (receipt as MemoryDistillSettlementPendingError).retryOriginalSettlement()
      await (receipt as MemoryDistillSettlementPendingError).retryOriginalSettlement()
      expect(writes).toBe(2)
      expect(runs).toBe(1)
      expect(failed.mock.calls).toHaveLength(0)
      expect(
        (await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)))[0],
      ).toMatchObject({ status: 'done', attempts: 0, finishedAt })
    } finally {
      done.mockRestore()
      failed.mockRestore()
    }
  })

  test('RFC-370 a lost failure ACK retries the same attempt and backoff without another runtime execution', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'failed-ack-lost',
        taskId,
        debounceMs: 0,
      }),
    )
    let now = Date.now() + 1000,
      runs = 0,
      writes = 0
    const retryAt = now + DISTILL_BACKOFF_BASE_MS
    const original = memory.store.markFailed.bind(memory.store)
    const failed = spyOn(memory.store, 'markFailed').mockImplementation(async (input) => {
      writes += 1
      await original(input)
      if (writes === 1) throw new Error('original failure ACK lost')
    })
    try {
      const receipt = await distillTick({
        ...workerDeps(memory),
        execution: { current: () => true },
        now: () => now,
        runFn: async () => {
          runs += 1
          throw new Error('original runtime failure')
        },
      }).catch((error) => error as unknown)
      expect(receipt).toBeInstanceOf(MemoryDistillSettlementPendingError)
      now += 100_000
      await (receipt as MemoryDistillSettlementPendingError).retryOriginalSettlement()
      expect(writes).toBe(2)
      expect(runs).toBe(1)
      expect(failed.mock.calls[0]![0]).toEqual(failed.mock.calls[1]![0])
      expect(
        (await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)))[0],
      ).toMatchObject({ status: 'pending', attempts: 1, nextRunAt: retryAt })
    } finally {
      failed.mockRestore()
    }
  })

  test('RFC-370 a missing original receipt cannot acknowledge completion or rewrite a replacement job', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'missing-receipt',
        taskId,
        debounceMs: 0,
      }),
    )
    let runs = 0
    let originalRow: typeof memoryDistillJobs.$inferSelect | undefined
    const original = memory.store.markDone.bind(memory.store)
    const done = spyOn(memory.store, 'markDone').mockImplementation(async (ids, at) => {
      await original(ids, at)
      originalRow = (
        await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
      )[0]
      await db.delete(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
      throw new Error('original done ACK lost and receipt missing')
    })
    try {
      const receipt = await distillTick({
        ...workerDeps(memory),
        execution: { current: () => true },
        now: () => Date.now() + 1000,
        runFn: async (input) => {
          runs += 1
          return okRun(input)
        },
      }).catch((error) => error as unknown)
      expect(receipt).toBeInstanceOf(MemoryDistillSettlementPendingError)
      await expect(
        (receipt as MemoryDistillSettlementPendingError).retryOriginalSettlement(),
      ).rejects.toThrow('memory-distill-original-settlement-unproven')
      if (!originalRow) throw new Error('original receipt row was not captured')
      await db.insert(memoryDistillJobs).values({
        ...originalRow,
        sourceEventId: 'replacement-receipt',
        status: 'pending',
        finishedAt: null,
      })
      await expect(
        (receipt as MemoryDistillSettlementPendingError).retryOriginalSettlement(),
      ).rejects.toThrow('memory-distill-original-settlement-unproven')
      expect(
        (await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)))[0],
      ).toMatchObject({ sourceEventId: 'replacement-receipt', status: 'pending', finishedAt: null })
      expect(done.mock.calls).toHaveLength(1)
      expect(runs).toBe(1)
    } finally {
      done.mockRestore()
    }
  })

  test('RFC-370 loss during candidate resolution leaves every unadmitted job pending', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'host-unadmitted',
      taskId,
      debounceMs: 0,
    })
    let current = true,
      runs = 0
    const original = memory.store.listPendingSiblings.bind(memory.store)
    const read = spyOn(memory.store, 'listPendingSiblings').mockImplementation(async (key) => {
      const rows = await original(key)
      current = false
      return rows
    })
    try {
      expect(
        await distillTick({
          ...workerDeps(memory),
          execution: { current: () => current },
          runFn: async (input) => {
            runs++
            return okRun(input)
          },
        }),
      ).toEqual({ picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 })
      expect(runs).toBe(0)
      expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
        startedAt: null,
      })
    } finally {
      read.mockRestore()
    }
  })

  test('RFC-370 an already issued runtime settles after loss and never admits a second bundle', async () => {
    for (const sourceEventId of ['issued-original', 'unissued-next']) {
      const { taskId } = await seedTask(db)
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId,
        taskId,
        debounceMs: 0,
      })
    }
    let current = true,
      runs = 0
    const result = await distillTick({
      ...workerDeps(memory),
      execution: { current: () => current },
      runFn: async (input) => {
        runs += 1
        current = false
        return okRun(input)
      },
    })
    expect(result).toEqual({ picked: 1, succeeded: 1, failed: 0, candidatesCreated: 0 })
    const rows = await db.select().from(memoryDistillJobs)
    expect(rows.filter((row) => row.status === 'done')).toHaveLength(1)
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(rows.every((row) => row.attempts === 0)).toBe(true)
    expect(runs).toBe(1)
  })

  test('RFC-370 a lost claim ACK returns only its original unissued subjects and does not execute them', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'claim-ack-lost',
        taskId,
        debounceMs: 0,
      }),
    )
    let runs = 0
    const original = memory.store.markRunning.bind(memory.store)
    const claim = spyOn(memory.store, 'markRunning').mockImplementation(async (ids, at) => {
      await original(ids, at)
      throw new Error('original claim ACK lost')
    })
    try {
      await expect(
        distillTick({
          ...workerDeps(memory),
          execution: { current: () => true },
          runFn: async (input) => {
            runs += 1
            return okRun(input)
          },
        }),
      ).rejects.toThrow('original claim ACK lost')
      expect((await memory.store.loadJobs([jobId]))[0]).toMatchObject({
        status: 'pending',
        startedAt: null,
        attempts: 0,
      })
      expect(runs).toBe(0)
    } finally {
      claim.mockRestore()
    }
  })

  test('RFC-370 a lost defer ACK retries only the original claim return with no execution or budget change', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'defer-ack-lost',
        taskId,
        debounceMs: 0,
      }),
    )
    let current = true,
      runs = 0,
      returns = 0
    const originalClaim = memory.store.markRunning.bind(memory.store),
      originalDefer = memory.store.deferUnissued.bind(memory.store)
    const claim = spyOn(memory.store, 'markRunning').mockImplementation(async (ids, at) => {
      await originalClaim(ids, at)
      current = false
    })
    const returning = spyOn(memory.store, 'deferUnissued').mockImplementation(async (input) => {
      returns += 1
      const result = await originalDefer(input)
      if (returns === 1) throw new Error('original defer ACK lost')
      return result
    })
    try {
      const receipt = await distillTick({
        ...workerDeps(memory),
        execution: { current: () => current },
        runFn: async (input) => {
          runs += 1
          return okRun(input)
        },
      }).catch((error) => error as unknown)
      expect(receipt).toBeInstanceOf(MemoryDistillSettlementPendingError)
      await (receipt as MemoryDistillSettlementPendingError).retryOriginalSettlement()
      expect(returning.mock.calls[0]![0]).toEqual(returning.mock.calls[1]![0])
      expect(claim.mock.calls).toHaveLength(1)
      expect(runs).toBe(0)
      expect((await memory.store.loadJobs([jobId]))[0]).toMatchObject({
        status: 'pending',
        startedAt: null,
        attempts: 0,
      })
    } finally {
      claim.mockRestore()
      returning.mockRestore()
    }
  })

  test('RFC-370 a cancellation racing the original claim remains canceled and leaves the other unissued sibling pending', async () => {
    const { taskId } = await seedTask(db)
    const first = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'cancel-original',
        taskId,
        debounceMs: 0,
      }),
    )
    const second = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'preserve-sibling',
        taskId,
        debounceMs: 0,
      }),
    )
    let runs = 0
    const original = memory.store.markRunning.bind(memory.store)
    const claim = spyOn(memory.store, 'markRunning').mockImplementation(async (ids, at) => {
      expect(await memory.store.cancelPending(first.jobId, at)).toBe(true)
      await original(ids, at)
    })
    try {
      expect(
        await distillTick({
          ...workerDeps(memory),
          execution: { current: () => true },
          runFn: async (input) => {
            runs += 1
            return okRun(input)
          },
        }),
      ).toEqual({ picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 })
      const rows = await memory.store.loadJobs([first.jobId, second.jobId])
      expect(rows.find((row) => row.id === first.jobId)).toMatchObject({
        status: 'canceled',
        attempts: 0,
      })
      expect(rows.find((row) => row.id === second.jobId)).toMatchObject({
        status: 'pending',
        attempts: 0,
        startedAt: null,
      })
      expect(runs).toBe(0)
    } finally {
      claim.mockRestore()
    }
  })

  test('RFC-370 unissued return refuses an actual changed execution receipt without clearing the running record', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'issued-receipt',
        taskId,
        debounceMs: 0,
      }),
    )
    const original = await memory.store.loadJobs([jobId]),
      startedAt = Date.now()
    await memory.store.markRunning([jobId], startedAt)
    await db
      .update(memoryDistillJobs)
      .set({
        userPromptMd: 'original actual execution prompt',
        opencodeSessionId: 'actual-execution-session',
      })
      .where(eq(memoryDistillJobs.id, jobId))
    expect(await memory.store.deferUnissued({ original, startedAt })).toBe(false)
    expect((await memory.store.loadJobs([jobId]))[0]).toMatchObject({
      status: 'running',
      startedAt,
      userPromptMd: 'original actual execution prompt',
      opencodeSessionId: 'actual-execution-session',
    })
  })

  test('RFC-370 loss during the claim ACK returns the original unissued bundle without running either bundle', async () => {
    for (const id of ['host-one', 'host-two']) {
      const { taskId } = await seedTask(db)
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: id,
        taskId,
        debounceMs: 0,
      })
    }
    let current = true,
      runs = 0
    const original = memory.store.markRunning.bind(memory.store)
    const claim = spyOn(memory.store, 'markRunning').mockImplementation(async (...args) => {
      await original(...args)
      current = false
    })
    try {
      expect(
        await distillTick({
          ...workerDeps(memory),
          execution: { current: () => current },
          runFn: async (input) => {
            runs++
            return okRun(input)
          },
        }),
      ).toEqual({ picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 })
      expect(runs).toBe(0)
      const rows = await db.select().from(memoryDistillJobs)
      expect(rows.filter((row) => row.status === 'done')).toHaveLength(0)
      expect(rows.filter((row) => row.status === 'pending')).toHaveLength(2)
      expect(rows.every((row) => row.attempts === 0)).toBe(true)
    } finally {
      claim.mockRestore()
    }
  })

  test('RFC-370 an unreaped original runtime rejects host drain without manufacturing a failed retry', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'host-unreaped',
      taskId,
      debounceMs: 0,
    })
    await expect(
      distillTick({
        ...workerDeps(memory),
        execution: { current: () => true },
        runFn: async (input) => ({ ...okRun(input), status: 'unreaped', exitCode: null }),
      }),
    ).rejects.toMatchObject({ name: 'IndeterminateRuntimeProcessError' })
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      status: 'running',
      attempts: 0,
      finishedAt: null,
    })
  })

  test('RFC-370 explicit original recovery settles its fixed failure receipt and retries only a lost settlement ACK', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'original-recovery',
        taskId,
        debounceMs: 0,
      }),
    )
    let now = Date.now() + 1000
    const originalNow = now
    let runs = 0,
      physical = 0,
      permitReap = false,
      writes = 0
    const markFailed = memory.store.markFailed.bind(memory.store)
    const write = spyOn(memory.store, 'markFailed').mockImplementation(async (input) => {
      writes += 1
      await markFailed(input)
      if (writes === 1) throw new Error('original recovery failure ACK lost')
    })
    try {
      const error = await distillTick({
        ...workerDeps(memory),
        execution: { current: () => true },
        now: () => now,
        runFn: async (input) => {
          runs += 1
          return {
            ...okRun(input),
            status: 'unreaped',
            exitCode: null,
            executionRecovery: {
              executionRef: 'original:memory-execution',
              recoverOriginal: async () => {
                physical += 1
                return permitReap
              },
            },
          }
        },
      }).catch((error) => error as unknown)
      expect(error).toBeInstanceOf(IndeterminateRuntimeProcessError)
      const original = error as IndeterminateRuntimeProcessError
      expect(original.originalJobIds).toEqual([jobId])
      expect(await original.recoverOriginal()).toBe(false)
      expect((await memory.store.loadJobs([jobId]))[0]).toMatchObject({
        status: 'running',
        attempts: 0,
      })
      expect(writes).toBe(0)
      permitReap = true
      now += 1000000
      await expect(original.recoverOriginal()).rejects.toThrow('original recovery failure ACK lost')
      expect(original.originalRecoveryAcknowledged()).toBe(false)
      expect(await original.recoverOriginal()).toBe(true)
      expect(await original.recoverOriginal()).toBe(true)
      expect(original.originalRecoveryAcknowledged()).toBe(true)
      expect((await memory.store.loadJobs([jobId]))[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        startedAt: null,
        nextRunAt: originalNow + DISTILL_BACKOFF_BASE_MS,
        lastError: 'distiller runtime process could not be reaped',
      })
      expect(runs).toBe(1)
      expect(physical).toBe(2)
      expect(writes).toBe(2)
    } finally {
      write.mockRestore()
    }
  })

  test('RFC-370 proof of original process death cannot settle a replacement memory job', async () => {
    const { taskId } = await seedTask(db)
    const { jobId } = admitted(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'original-replaced-recovery',
        taskId,
        debounceMs: 0,
      }),
    )
    let runs = 0
    const error = await distillTick({
      ...workerDeps(memory),
      execution: { current: () => true },
      now: () => Date.now() + 1000,
      runFn: async (input) => {
        runs += 1
        return {
          ...okRun(input),
          status: 'unreaped',
          exitCode: null,
          executionRecovery: {
            executionRef: 'original:memory-execution',
            recoverOriginal: async () => true,
          },
        }
      },
    }).catch((error) => error as unknown)
    expect(error).toBeInstanceOf(IndeterminateRuntimeProcessError)
    await db
      .update(memoryDistillJobs)
      .set({ sourceEventId: 'replacement:source' })
      .where(eq(memoryDistillJobs.id, jobId))
    const before = (await memory.store.loadJobs([jobId]))[0]
    await expect((error as IndeterminateRuntimeProcessError).recoverOriginal()).rejects.toThrow(
      'memory-distill-original-settlement-unproven',
    )
    expect((await memory.store.loadJobs([jobId]))[0]).toEqual(before)
    expect(runs).toBe(1)
  })

  test('idle: no pending due rows → no-op', async () => {
    const r = await distillTick({ ...workerDeps(memory), runFn: EMPTY_ENVELOPE_RUN })
    expect(r).toEqual({ picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 })
  })

  test('happy path: one row due → status flips to done', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    const r = await distillTick({ ...workerDeps(memory), runFn: EMPTY_ENVELOPE_RUN })
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.candidatesCreated).toBe(0)
    const row = (await db.select().from(memoryDistillJobs).all())[0]!
    expect(row.status).toBe('done')
    expect(row.finishedAt).not.toBeNull()
  })

  test('debounce: 3 pending rows on same key → one merged distill run', async () => {
    const { taskId } = await seedTask(db)
    for (const e of ['c1', 'c2', 'c3']) {
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: e,
        taskId,
        debounceMs: 0,
      })
    }
    let runCalls = 0
    const runFn: RunDistillOptions['runFn'] = async (opts) => {
      runCalls += 1
      return okRun(opts)
    }
    const r = await distillTick({ ...workerDeps(memory), runFn })
    expect(runCalls).toBe(1)
    expect(r.succeeded).toBe(1)
    const rows = await db.select().from(memoryDistillJobs).all()
    for (const row of rows) expect(row.status).toBe('done')
  })

  test('failure: attempt 1 / 2 → pending with exp backoff, attempt 3 → failed', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    const explodeRun: RunDistillOptions['runFn'] = async () => {
      throw new Error('boom')
    }

    // Tick clock starts just after enqueue's stored next_run_at so the row
    // is immediately due. Each subsequent attempt jumps to the new
    // backoff-shifted next_run_at.
    let now = Date.now() + 1
    await distillTick({ ...workerDeps(memory), runFn: explodeRun, now: () => now })
    let row = (await db.select().from(memoryDistillJobs).all())[0]!
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('pending')
    expect(row.nextRunAt).toBeGreaterThanOrEqual(now + DISTILL_BACKOFF_BASE_MS - 50)

    // Attempt 2 — pump time past backoff.
    now = row.nextRunAt + 1
    await distillTick({ ...workerDeps(memory), runFn: explodeRun, now: () => now })
    row = (await db.select().from(memoryDistillJobs).all())[0]!
    expect(row.attempts).toBe(2)
    expect(row.status).toBe('pending')

    // Attempt 3 = max — flip to failed.
    now = row.nextRunAt + 1
    await distillTick({ ...workerDeps(memory), runFn: explodeRun, now: () => now })
    row = (await db.select().from(memoryDistillJobs).all())[0]!
    expect(row.attempts).toBe(DISTILL_MAX_ATTEMPTS)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('boom')
  })

  test('ordinary runtime failure follows the normal retry budget', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'runtime-failure',
      taskId,
      debounceMs: 0,
    })
    const failure = new Error('runtime launch failed')

    const result = await distillTick({
      ...workerDeps(memory),
      runFn: async () => {
        throw failure
      },
      now: () => Date.now() + 1,
    })
    const row = (await db.select().from(memoryDistillJobs).all())[0]!
    expect(result.failed).toBe(1)
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toBe('runtime launch failed')
    expect(row.finishedAt).toBeNull()
  })

  test('honors DISTILL_BATCH_LIMIT (≤ 5 distinct debounce keys per tick)', async () => {
    // 6 distinct tasks → 6 distinct keys; only 5 should execute.
    for (let i = 0; i < 6; i++) {
      const { taskId } = await seedTask(db)
      await enqueueDistillJob(memory.store, {
        sourceKind: 'clarify',
        sourceEventId: 'c' + i,
        taskId,
        debounceMs: 0,
      })
    }
    let calls = 0
    const r = await distillTick({
      ...workerDeps(memory),
      runFn: async (opts) => {
        calls += 1
        return okRun(opts)
      },
    })
    expect(calls).toBe(5)
    expect(r.picked).toBeLessThanOrEqual(5)
  })

  test('not yet due: tick at t < next_run_at → no pick', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 60_000, // due 1 min in the future
    })
    const r = await distillTick({
      ...workerDeps(memory),
      runFn: EMPTY_ENVELOPE_RUN,
      now: () => Date.now(),
    })
    expect(r.picked).toBe(0)
  })

  test('RFC-044: sourceContextBudget = {0,0} is plumbed through to user prompt', async () => {
    // End-to-end check: scheduler → runDistill → buildDistillerUserPrompt.
    // When the scheduler hands sourceContextBudget = {0, 0} down the stack,
    // the resulting user prompt must NOT contain the new block headers.
    // This locks the wiring so a missed argument silently disabling the
    // feature does not slip past tests.
    const { taskId } = await seedTask(db)
    // Seed an actual clarify_session with a source-agent node_run + events so
    // the loader path runs end-to-end (rather than the empty-clarify branch).
    const sourceRunId = ulid()
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_human',
      promptText: 'hi',
      startedAt: Date.now(),
      opencodeSessionId: 'sess-1',
    })
    const clarifyRunId = ulid()
    await db.insert(nodeRuns).values({
      id: clarifyRunId,
      taskId,
      nodeId: 'clarify-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_human',
    })
    const clarifyId = ulid()
    await db.insert(clarifyRounds).values({
      kind: 'self' as const,
      id: clarifyId,
      taskId,
      askingNodeId: 'agent-1',
      askingNodeRunId: sourceRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify-1',
      intermediaryNodeRunId: clarifyRunId,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      status: 'answered',
      createdAt: Date.now(),
    })
    await db.insert(nodeRunEvents).values({
      nodeRunId: sourceRunId,
      ts: 1,
      kind: 'text',
      payload: JSON.stringify({
        type: 'text',
        sessionID: 'sess-1',
        messageID: 'm1',
        part: { type: 'text', text: 'PLUMBING-MARKER' },
      }),
      sessionId: 'sess-1',
      parentSessionId: null,
    })

    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: clarifyId,
      taskId,
      debounceMs: 0,
    })

    let capturedPrompt: string | null = null
    const capturePromptRun: RunDistillOptions['runFn'] = async (opts) => {
      capturedPrompt = opts.prompt
      return okRun(opts)
    }
    await distillTick({
      ...workerDeps(memory),
      runFn: capturePromptRun,
      // RFC-366 扩了预算对象；本用例关心的仍是 clarify/review 两项归零。
      sourceContextBudget: {
        ...DEFAULT_SOURCE_CONTEXT_BUDGET,
        clarifyTranscriptMaxBytes: 0,
        reviewBodyMaxBytes: 0,
      },
    })
    expect(capturedPrompt).not.toBeNull()
    expect(capturedPrompt!).not.toContain('Source agent transcript:')
    expect(capturedPrompt!).not.toContain('PLUMBING-MARKER')

    // Counter-check: with default budget the marker IS visible. Resetting
    // the job state to pending re-runs the same source event.
    await db
      .update(memoryDistillJobs)
      .set({ status: 'pending', attempts: 0, nextRunAt: Date.now() - 1 })
    capturedPrompt = null
    await distillTick({ ...workerDeps(memory), runFn: capturePromptRun })
    expect(capturedPrompt!).toContain('Source agent transcript:')
    expect(capturedPrompt!).toContain('PLUMBING-MARKER')
  })
})

describeEachProvider('recoverRunning + manual control', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: MemoryTestContext
  beforeEach(() => {
    db = harness.db
    memory = createMemoryDistillTestContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => memory.cleanup())

  test('recoverRunning flips leftover running rows back to pending', async () => {
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    await db.update(memoryDistillJobs).set({ status: 'running' })
    const r = await recoverRunning(memory.store)
    expect(r.recovered).toBe(1)
    const row = (await db.select().from(memoryDistillJobs).all())[0]!
    expect(row.status).toBe('pending')
  })

  test('retryFailedJob: failed → pending with attempts reset to 0', async () => {
    const id = ulid()
    await db.insert(memoryDistillJobs).values({
      id,
      debounceKey: 'k',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: null,
      scopeResolvedJson: '{}',
      status: 'failed',
      attempts: 3,
      nextRunAt: Date.now(),
      lastError: 'old',
      createdAt: Date.now(),
    })
    expect(await retryFailedJob(memory.store, id)).toBe(true)
    const row = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).all()
    )[0]!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.lastError).toBeNull()
  })

  test('retryFailedJob rejects non-failed rows', async () => {
    const id = ulid()
    await db.insert(memoryDistillJobs).values({
      id,
      debounceKey: 'k',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: null,
      scopeResolvedJson: '{}',
      status: 'pending',
      attempts: 0,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
    })
    expect(await retryFailedJob(memory.store, id)).toBe(false)
  })

  test('cancelPendingJob: pending → canceled', async () => {
    const id = ulid()
    await db.insert(memoryDistillJobs).values({
      id,
      debounceKey: 'k',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: null,
      scopeResolvedJson: '{}',
      status: 'pending',
      attempts: 0,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
    })
    expect(await cancelPendingJob(memory.store, id)).toBe(true)
    const row = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).all()
    )[0]!
    expect(row.status).toBe('canceled')
  })

  test('listDistillJobs filters by status', async () => {
    await db.insert(memoryDistillJobs).values({
      id: 'a',
      debounceKey: 'k',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: null,
      scopeResolvedJson: '{}',
      status: 'pending',
      attempts: 0,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
    })
    await db.insert(memoryDistillJobs).values({
      id: 'b',
      debounceKey: 'k',
      sourceKind: 'review',
      sourceEventId: 'r1',
      taskId: null,
      scopeResolvedJson: '{}',
      status: 'failed',
      attempts: 3,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
    })
    expect((await listDistillJobs(memory.store, { status: 'failed' })).length).toBe(1)
    expect((await listDistillJobs(memory.store, {})).length).toBe(2)
  })
})

// RFC-041 / design/test-guard-audit-2026-07-21 gap B6-data-4 (Top-16) — the
// 1Hz loop must not run two ticks concurrently. distillTick awaits a real LLM
// spawn mid-tick; without a reentrancy guard, tick N+1 fires while tick N is
// still awaiting and claims a row tick N has not yet flipped to `running`,
// distilling the same debounce_key twice. startMemoryDistillLoop had ZERO test
// coverage before this.
describeEachProvider('startMemoryDistillLoop reentrancy', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: MemoryTestContext
  beforeEach(() => {
    db = harness.db
    memory = createMemoryDistillTestContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => memory.cleanup())

  test('a slow tick is not overlapped by the next interval fire', async () => {
    // Two jobs, DIFFERENT debounce keys, both due now. One tick (batch limit 5)
    // picks both and processes them SEQUENTIALLY. The first spawn blocks on a
    // gate; while it is blocked the interval keeps firing. With the guard the
    // second head is not reached until the first spawn returns, so at most one
    // spawn is ever in-flight. Without the guard, a second tick fires, finds the
    // still-`pending` second head, claims it and spawns CONCURRENTLY → 2.
    const { taskId } = await seedTask(db)
    await enqueueDistillJob(memory.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    await enqueueDistillJob(memory.store, {
      sourceKind: 'review',
      sourceEventId: 'r1',
      taskId,
      debounceMs: 0,
    })

    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slowRun: RunDistillOptions['runFn'] = async (opts) => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight -= 1
      return okRun(opts)
    }

    const loop = startMemoryDistillLoop({
      ...workerDeps(memory),
      runFn: slowRun,
      intervalMs: 5,
    })
    try {
      // Two waits, and they are NOT the same kind — conflating them is what made
      // this assertion flaky twice.
      //
      // (a) PRECONDITION, positive ⇒ poll. "The first spawn has started" is an
      //     observable event, so waiting a fixed 80ms for it is a bet on runner
      //     speed. CI run 31167085366 (macos shard 3/4) lost that bet and
      //     reported `maxInFlight` **0** — not 2. A guard failure would read 2;
      //     0 means the loop had not even reached its first spawn yet, i.e. the
      //     test never got to the thing it exists to check. Five local runs
      //     passed, including with six CPU burners pinned alongside.
      const startDeadline = Date.now() + 5_000
      while (calls === 0 && Date.now() < startDeadline) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(calls).toBe(1) // the loop is actually running now

      // (b) THE REAL ASSERTION, negative ⇒ wall clock. "No second spawn
      //     overlapped" cannot be polled for (you cannot poll for the absence of
      //     an event), so we hold the gate open across many interval fires
      //     (16 × 5ms) and then check. This wait now starts from a KNOWN state
      //     (first spawn in flight) instead of racing the loop's startup.
      await new Promise((r) => setTimeout(r, 80))
      // The guard serialises: exactly one spawn in-flight, only the first head
      // claimed so far.
      expect(maxInFlight).toBe(1)
      expect(calls).toBe(1)

      // Release; the tick finishes both heads sequentially, no duplicates.
      release()
      // POLL rather than sleeping a fixed 80ms: the negative assertion above
      // legitimately needs a wall-clock wait (you cannot poll for "nothing else
      // happened"), but this one is positive, and a fixed wait against a 5ms
      // interval loop is a bet a loaded runner loses — CI run 30886241395 saw
      // calls===1 here while five consecutive local runs passed.
      //
      // Poll the TERMINAL observable, both rows `done` — NOT the `calls`
      // counter. `calls` ticks when the second spawn STARTS, so waiting on it
      // races ahead of the status write and the final assertion below fails
      // instead (CI run 30888287151, the first version of this fix).
      const deadline = Date.now() + 5_000
      const doneCount = async (): Promise<number> =>
        (await db.select().from(memoryDistillJobs).all()).filter((r) => r.status === 'done').length
      while ((await doneCount()) < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(maxInFlight).toBe(1)
      expect(calls).toBe(2)
    } finally {
      loop.stop()
      release()
    }

    // Both jobs ended `done` exactly once — no double-distill.
    const rows = await db.select().from(memoryDistillJobs).all()
    expect(rows.map((r) => r.status).sort()).toEqual(['done', 'done'])
  })
})
