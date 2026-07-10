import { rimrafDir } from './helpers/cleanup'
// RFC-098 B3 (audit S-20 + adversarial-review revision #7) — the fanout
// consumed GENERATION GATE and its PERSISTED reuseDisabled flag.
//
// WHY THIS FILE EXISTS (regression intent): the per-shard value hash
// (migration 0043) is blind for the path family — shard.value IS the path
// string, so "same path, different upstream content" hashes identically. The
// compensating gate compares the wrapper's previously recorded consumed
// provenance with the freshly resolved one at EVERY wrapper entry (resume:
// the row's own consumed; fresh mint: the previous generation's). A mismatch
// disables ALL done-row reuse for the pass (full re-run) and — revision #7 —
// is PERSISTED into wrapperProgressJson, because the entry path immediately
// overwrites the consumed column: an in-memory flag would vanish on a daemon
// crash and the resumed run's comparison would wrongly pass, replaying stale
// path-family shards. markWrapperTerminal clears the flag (by then every
// shard owns a row from the disabled generation).
//
// Four locks:
//   1. resume-path gate: recorded consumed ≠ resolved consumed → full re-run
//      even though every value hash matches; flag cleared after terminal.
//   2. crash-resume backdoor (revision #7 PRIMARY oracle): consumed already
//      overwritten (matches) but persisted reuseDisabled=true → STILL full
//      re-run; flag cleared after terminal.
//   3. control: consumed matches + no flag → full replay, ZERO spawns (also
//      pins "resume keeps exactly one done row per shard" economics).
//   4. cross-generation gate: previous FAILED generation's consumed ≠ new →
//      fresh wrapper generation re-runs every shard (no cross-gen replay).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { decodeWrapperProgress, encodeWrapperProgress } from '../src/services/wrapperProgress'

// Same-ms ULID ordering guard (precedent: scheduler-clarify-dispatch.test.ts).
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc098-consumed-gate-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return taskId
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

// input docs (list<path<md>> → PATH-FAMILY shardKeys = the path strings; the
// value hash is therefore content-blind — exactly the gate's territory)
// → fan{inner}. No aggregator: spawn count == re-run shard count.
function fanoutDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'inner',
        kind: 'agent-single',
        agentName: 'worker',
        promptTemplate: 'Process {{doc}}',
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'inp', portName: 'docs' },
        target: { nodeId: 'fan', portName: 'docs' },
      },
      {
        id: 'eB',
        source: { nodeId: 'fan', portName: 'docs' },
        target: { nodeId: 'inner', portName: 'doc' },
        boundary: 'wrapper-input',
      },
    ],
  }
}

const DOCS = 'a.md\nb.md'

/** Pre-seed a done io-virtual run for the input node so the wrapper's
 * resolved consumed is a KNOWN id (the gate comparison becomes
 * deterministic without running the input dispatch first). */
async function seedInputRun(h: Harness, taskId: string): Promise<string> {
  const id = ulid()
  await h.db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'inp',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
  await h.db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'docs', content: DOCS })
  return id
}

/** Pre-seed the wrapper row + two DONE children whose value hashes MATCH the
 * current shard values (path strings) — without the consumed gate these are
 * always replayable. */
async function seedWrapperAndDoneChildren(
  h: Harness,
  taskId: string,
  over: {
    wrapperStatus: 'pending' | 'failed'
    consumed: Record<string, string> | null
    progressJson?: string
  },
): Promise<{ wrapperRunId: string; childIds: string[] }> {
  const wrapperRunId = ulid()
  await h.db.insert(nodeRuns).values({
    id: wrapperRunId,
    taskId,
    nodeId: 'fan',
    status: over.wrapperStatus,
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: null,
    shardKey: null,
    consumedUpstreamRunsJson: over.consumed === null ? null : JSON.stringify(over.consumed),
    wrapperProgressJson: over.progressJson ?? null,
    startedAt: Date.now(),
    ...(over.wrapperStatus === 'failed' ? { finishedAt: Date.now() } : {}),
  })
  const childIds: string[] = []
  for (const key of ['a.md', 'b.md']) {
    const id = ulid()
    childIds.push(id)
    await h.db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId: 'inner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: wrapperRunId,
      shardKey: key,
      shardValueHash: sha256Hex(key), // path-family value IS the path
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await h.db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'result', content: 'OLD' })
  }
  return { wrapperRunId, childIds }
}

function readInvocations(argvCapture: string): Array<{ agent: string; argv: string[] }> {
  if (!existsSync(argvCapture)) return []
  return readFileSync(argvCapture, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { agent: string; argv: string[] })
}

async function runWithMock(h: Harness, taskId: string, argvCapture: string): Promise<void> {
  await withEnv(
    {
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'FRESH' }),
      MOCK_OPENCODE_CAPTURE_ARGV_TO: argvCapture,
    },
    () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
  )
}

describe('RFC-098 B3 — fanout consumed generation gate (S-20) + persisted reuseDisabled (revision #7)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('1. resume: recorded consumed ≠ resolved consumed → full re-run despite matching hashes; flag cleared at terminal', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const taskId = await seedWorkflowAndTask(h, fanoutDef(), { docs: DOCS })
    const inputRunId = await seedInputRun(h, taskId)
    // The wrapper recorded an OLDER input run id — i.e. the input/upstream
    // re-ran while this wrapper was parked. Every child hash still matches
    // (path family!) so only the gate can force the re-run.
    const { wrapperRunId, childIds } = await seedWrapperAndDoneChildren(h, taskId, {
      wrapperStatus: 'pending',
      consumed: { inp: '01STALEINPUTRUN0000000000' },
    })

    const argvCapture = join(h.appHome, 'argv.jsonl')
    await runWithMock(h, taskId, argvCapture)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // HEADLINE: both shards re-spawned — done rows were NOT replayed.
    const invocations = readInvocations(argvCapture)
    expect(invocations.length).toBe(2)
    expect(invocations.every((i) => i.agent === 'worker')).toBe(true)

    // Fresh rows minted under the same (resumed) wrapper; stale done rows
    // remain as history → 2 rows per shardKey.
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRunId)
    for (const key of ['a.md', 'b.md']) {
      const rows = innerRows.filter((r) => r.shardKey === key)
      expect(rows.length).toBe(2)
      const fresh = rows.find((r) => !childIds.includes(r.id))!
      expect(fresh.status).toBe('done')
    }

    // The wrapper's consumed was overwritten to the resolved value, and the
    // persisted gate flag was CLEARED by markWrapperTerminal (kind/phase
    // breadcrumb may remain — only reuseDisabled must be gone).
    const wrapper = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, wrapperRunId)))[0]!
    expect(wrapper.status).toBe('done')
    expect(JSON.parse(wrapper.consumedUpstreamRunsJson ?? 'null')).toEqual({ inp: inputRunId })
    const progress = decodeWrapperProgress(wrapper.wrapperProgressJson, () => {})
    expect(progress?.reuseDisabled).toBeUndefined()
  }, 60_000)

  test('2. crash-resume backdoor (revision #7 primary oracle): consumed matches but PERSISTED reuseDisabled=true → still full re-run; flag cleared at terminal', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const taskId = await seedWorkflowAndTask(h, fanoutDef(), { docs: DOCS })
    const inputRunId = await seedInputRun(h, taskId)
    // Replay of the post-crash state: the crashed (gate-tripped) run already
    // OVERWROTE the consumed column — the comparison alone would pass — but
    // it persisted reuseDisabled=true before dying. The door must stay shut.
    const { wrapperRunId, childIds } = await seedWrapperAndDoneChildren(h, taskId, {
      wrapperStatus: 'pending',
      consumed: { inp: inputRunId },
      progressJson: encodeWrapperProgress({
        kind: 'fanout',
        phase: 'inner-running',
        reuseDisabled: true,
      }),
    })

    const argvCapture = join(h.appHome, 'argv.jsonl')
    await runWithMock(h, taskId, argvCapture)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // HEADLINE: matching consumed + matching hashes would replay both shards
    // (test 3 proves it) — the persisted flag alone forces the re-run.
    const invocations = readInvocations(argvCapture)
    expect(invocations.length).toBe(2)

    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRunId)
    for (const key of ['a.md', 'b.md']) {
      const rows = innerRows.filter((r) => r.shardKey === key)
      expect(rows.length).toBe(2)
      expect(rows.some((r) => !childIds.includes(r.id) && r.status === 'done')).toBe(true)
    }

    // Terminal clears the flag — the NEXT resume/retry may reuse again.
    const wrapper = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, wrapperRunId)))[0]!
    expect(wrapper.status).toBe('done')
    const progress = decodeWrapperProgress(wrapper.wrapperProgressJson, () => {})
    expect(progress).not.toBeNull() // breadcrumb retained…
    expect(progress?.reuseDisabled).toBeUndefined() // …flag gone
  }, 60_000)

  test('3. control: consumed matches + no flag → full replay, ZERO spawns, one done row per shard', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const taskId = await seedWorkflowAndTask(h, fanoutDef(), { docs: DOCS })
    const inputRunId = await seedInputRun(h, taskId)
    const { wrapperRunId, childIds } = await seedWrapperAndDoneChildren(h, taskId, {
      wrapperStatus: 'pending',
      consumed: { inp: inputRunId },
    })

    const argvCapture = join(h.appHome, 'argv.jsonl')
    await runWithMock(h, taskId, argvCapture)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Zero spawns: both done children replayed from their persisted outputs.
    expect(readInvocations(argvCapture).length).toBe(0)

    // Row economics: exactly one row per shardKey — the pre-seeded ones.
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRunId)
    expect(innerRows.map((r) => r.id).sort()).toEqual([...childIds].sort())
  }, 60_000)

  test('4. cross-generation gate: FAILED previous generation with mismatching consumed → new generation re-runs every shard', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const taskId = await seedWorkflowAndTask(h, fanoutDef(), { docs: DOCS })
    await seedInputRun(h, taskId)
    // Previous generation went terminal-failed with consumed recorded for an
    // OLDER input run. findResumableWrapperRun treats failed as terminal →
    // a FRESH wrapper generation is minted; its gate compares against this
    // prior generation's consumed and must trip (no cross-gen replay of the
    // hash-matching done children).
    const { wrapperRunId: oldWrapperId, childIds } = await seedWrapperAndDoneChildren(h, taskId, {
      wrapperStatus: 'failed',
      consumed: { inp: '01STALEINPUTRUN0000000000' },
    })

    const argvCapture = join(h.appHome, 'argv.jsonl')
    await runWithMock(h, taskId, argvCapture)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Both shards re-spawned under the NEW wrapper generation.
    expect(readInvocations(argvCapture).length).toBe(2)
    const wrapperRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRows.length).toBe(2)
    const newWrapper = wrapperRows.find((r) => r.id !== oldWrapperId)!
    expect(newWrapper.status).toBe('done')
    const newChildren = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === newWrapper.id)
    expect(newChildren.map((r) => r.shardKey).sort()).toEqual(['a.md', 'b.md'])
    expect(newChildren.every((r) => r.status === 'done')).toBe(true)
    expect(newChildren.every((r) => !childIds.includes(r.id))).toBe(true)
  }, 60_000)
})
