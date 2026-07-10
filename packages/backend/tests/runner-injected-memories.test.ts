import { rimrafDir } from './helpers/cleanup'
// RFC-046 — locks the runner's persistence path for
// `node_runs.injected_memories_json`:
//   - Normal agent run with approved memories present → JSON array written.
//   - Four-scope-empty run → column stays NULL (matches "block was null,
//     prompt unchanged" contract).
//   - envelope-followup retry → column copied verbatim from retry_index=0
//     sibling (no new SELECT against memories; mirrors the model still
//     seeing the original block in its resumed opencode session).
//   - envelope-followup with NULL on attempt 0 → column stays NULL.
//   - grep guard: `formatMemoryBlock(` (RFC-041) and
//     `loadInjectedSnapshotFromFirstAttempt(` (RFC-046) only ever appear in
//     runner.ts's inject section — scheduler must not duplicate the path.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
const ulid = monotonicFactory() // RFC-074 PR-C: monotonic ids for synchronous seeding under pure-id freshness
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: '',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc046-runner-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rimrafDir(appHome),
  }
}

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  overrides: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'pending',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    ...overrides,
  })
  return id
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

function readJson(db: DbClient, nodeRunId: string): string | null {
  const row = db
    .select({ json: nodeRuns.injectedMemoriesJson })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .get()
  return row?.json ?? null
}

describe('RFC-046 — runner persists injected_memories_json', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('R1: approved global memory present → JSON snapshot written to column', async () => {
    h.db
      .insert(memories)
      .values({
        id: 'mem_g1',
        scopeType: 'global',
        scopeId: null,
        title: 'G',
        bodyMd: 'global body',
        tags: '["g"]',
        status: 'approved',
        sourceKind: 'review',
        version: 1,
        approvedAt: 1_700_000_000_000,
        createdAt: Date.now(),
      })
      .run()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    const raw = readJson(h.db, nodeRunId)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe('mem_g1')
    expect(parsed[0].title).toBe('G')
    expect(parsed[0].scopeType).toBe('global')
    expect(parsed[0].version).toBe(1)
    expect(parsed[0].tags).toEqual(['g'])
  })

  test('R2: no approved memories anywhere → column stays NULL', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    expect(readJson(h.db, nodeRunId)).toBeNull()
  })

  test('R3: envelope-followup retry copies attempt-0 sibling JSON verbatim', async () => {
    const attempt0Json = JSON.stringify([
      {
        id: 'attempt0_mem',
        version: 7,
        scopeType: 'agent',
        scopeId: 'a',
        title: 'A',
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: null,
      },
    ])
    // Pre-seed attempt 0: it ran inject (snapshot persisted) then FAILED an
    // envelope check — the only state that triggers an envelope-followup
    // (scheduler decideEnvelopeFollowup requires prev.status === 'failed').
    // RFC-074 PR-C: the generation anchor walks by id and treats a `failed`
    // predecessor as same-generation, so the followup resolves to THIS attempt.
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'agent-x',
      retryIndex: 0,
      status: 'failed',
      injectedMemoriesJson: attempt0Json,
      opencodeSessionId: 'sess_resume',
    })
    // Create the followup attempt-1 row in 'pending'.
    const followupId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'agent-x',
      retryIndex: 1,
      status: 'pending',
    })
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId: followupId,
          nodeId: 'agent-x',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          envelopeFollowup: true,
          resumeSessionId: 'sess_resume',
          envelopeFollowupReason: 'envelope-missing',
        }),
    )
    const raw = readJson(h.db, followupId)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe('attempt0_mem')
    expect(parsed[0].version).toBe(7)
  })

  test('R4: envelope-followup retry inherits NULL when attempt 0 has NULL', async () => {
    // Attempt 0 failed envelope validation (the followup trigger) with a NULL
    // snapshot — RFC-074 PR-C anchor walks to this `failed` predecessor.
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'agent-y',
      retryIndex: 0,
      status: 'failed',
      injectedMemoriesJson: null,
      opencodeSessionId: 'sess_resume_null',
    })
    const followupId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'agent-y',
      retryIndex: 1,
      status: 'pending',
    })
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId: followupId,
          nodeId: 'agent-y',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          envelopeFollowup: true,
          resumeSessionId: 'sess_resume_null',
          envelopeFollowupReason: 'envelope-missing',
        }),
    )
    expect(readJson(h.db, followupId)).toBeNull()
  })
})

describe('RFC-046 — runner.ts source-code grep guards', () => {
  test('R5: runner.ts wires injectedMemoriesJson into the final node_runs UPDATE', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'), 'utf8')
    expect(src).toContain('injectedMemoriesJson')
    // The legacy formatMemoryBlock grep guard from RFC-041 is kept intact:
    // the runner must still go through injectMemoryForRun, which delegates
    // to formatMemoryBlockWithSnapshot internally.
    expect(src).toContain('injectMemoryForRun(')
    // RFC-046 followup helper must be called from runner only (scheduler
    // and other services have no business reading attempt 0's snapshot).
    expect(src).toContain('loadInjectedSnapshotFromFirstAttempt(')
  })

  test('R6: scheduler.ts does not call the followup-inherit helper', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).not.toContain('loadInjectedSnapshotFromFirstAttempt(')
    expect(src).not.toContain('injectedMemoriesJson')
  })
})
