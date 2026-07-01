// RFC-098 B3 (audit S-20) — shard value-hash gate: after a daemon restart, a
// shard whose UPSTREAM CONTENT changed must re-run; siblings whose content is
// unchanged are replayed from their done rows without a spawn.
//
// WHY THIS FILE EXISTS (regression intent): the pre-fix reuse predicate
// compared shardKey ONLY. For non-path lists the key is a bare 0-based index,
// so a restart that resumed a fanout whose upstream list had been edited
// in-place would happily replay the OLD shard result for the SAME index —
// silently stale output. Migration 0043 stamps sha256(shard.value) on every
// minted shard row; pickReusableShardRun (freshness.ts) refuses a done row
// whose stored hash mismatches the current value (NULL=match for legacy
// rows — locked separately by scheduler-boundary-fanout-resume-duplicate-
// shards + scheduler-audit-s21 test 1). This file is the survey §wp6b-fanout
// "重启后上游新内容 → 对应 shard 重跑" integration oracle: pre-seed done
// children carrying hashes of the OLD content, run with NEW content, assert
// exactly the changed shard re-spawns.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

// Same-ms ULID ordering guard (precedent: scheduler-clarify-dispatch.test.ts):
// pre-seeded wrapper/child rows are minted in the same millisecond — id order
// must equal insert order for the freshest-by-id reuse logic to be
// deterministic.
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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc098-hash-rerun-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
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

// input docs (list<string> → index shardKeys '0'/'1') → fan{inner}. No
// aggregator, so the spawn count is purely the shard count.
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
        inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
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

describe('RFC-098 B3 — restart + changed upstream content re-runs ONLY the affected shard', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('done shard with stale value hash re-runs; hash-matching sibling is replayed without a spawn', async () => {
    await seedAgent(h.db, 'worker', ['result'])

    // CURRENT upstream content: index 0 unchanged ('alpha'), index 1 EDITED
    // ('beta-NEW'). The pre-seeded done children below carry hashes of the
    // OLD content — same shardKeys ('0'/'1'), different value for key '1'.
    const taskId = await seedWorkflowAndTask(h, fanoutDef(), { docs: 'alpha\nbeta-NEW' })

    // Restart residue: the wrapper row survives as 'pending' (resume reuses
    // it, consumed NULL = legacy → the consumed generation gate stays open;
    // the value hash is the deciding mechanism here).
    const wrapperRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: wrapperRunId,
      taskId,
      nodeId: 'fan',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: null,
      startedAt: Date.now(),
    })
    const doneShard0 = ulid()
    const doneShard1 = ulid()
    for (const [id, key, oldValue, content] of [
      [doneShard0, '0', 'alpha', 'OLD-A'],
      [doneShard1, '1', 'beta-OLD', 'OLD-B'],
    ] as const) {
      await h.db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: 'inner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        parentNodeRunId: wrapperRunId,
        shardKey: key,
        shardValueHash: sha256Hex(oldValue),
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
      await h.db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'result', content })
    }

    const argvCapture = join(h.appHome, 'argv-capture.jsonl')
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

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Wrapper row reused (RFC-040 resume), not re-minted.
    const wrapperRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRows.length).toBe(1)
    expect(wrapperRows[0]?.id).toBe(wrapperRunId)
    expect(wrapperRows[0]?.status).toBe('done')

    // HEADLINE: exactly ONE spawn, and it processed the EDITED value — shard
    // '0' (hash match) was replayed without a process, shard '1' (hash
    // mismatch) re-ran with the new content.
    const invocations = readFileSync(argvCapture, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { agent: string; argv: string[] })
    expect(invocations.length).toBe(1)
    expect(invocations[0]?.agent).toBe('worker')
    const prompt = invocations[0]?.argv[1] ?? ''
    expect(prompt).toContain('beta-NEW')
    expect(prompt).not.toContain('alpha')

    // Row-level shape: shard '0' still owns exactly its pre-seeded row
    // (untouched, OLD-A output preserved); shard '1' gained a fresh row
    // stamped with the NEW value hash, while the stale row stays as history.
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRunId)
    const key0 = innerRows.filter((r) => r.shardKey === '0')
    const key1 = innerRows.filter((r) => r.shardKey === '1')
    expect(key0.length).toBe(1)
    expect(key0[0]?.id).toBe(doneShard0)
    expect(key0[0]?.status).toBe('done')
    expect(key1.length).toBe(2)
    const fresh1 = key1.find((r) => r.id !== doneShard1)!
    expect(fresh1.status).toBe('done')
    expect(fresh1.shardValueHash).toBe(sha256Hex('beta-NEW'))
    const fresh1Outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, fresh1.id))
    expect(fresh1Outs.find((o) => o.portName === 'result')?.content).toBe('FRESH')
    // The stale row keeps its original hash + output (history stays true).
    const stale1 = key1.find((r) => r.id === doneShard1)!
    expect(stale1.shardValueHash).toBe(sha256Hex('beta-OLD'))
    const stale1Outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, stale1.id))
    expect(stale1Outs.find((o) => o.portName === 'result')?.content).toBe('OLD-B')
  }, 60_000)
})
