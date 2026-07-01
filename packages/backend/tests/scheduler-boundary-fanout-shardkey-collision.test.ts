// Regression: duplicate items in a wrapper-fanout shardSource collide to the
// same shardKey.
//
// DEFECT (MED): the shardSource is split into items with NO de-dup
// (packages/backend/src/services/scheduler.ts:2383-2386):
//     const items = rawContent.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
// then each item's shardKey is minted via resolveKeyOf (scheduler.ts:2422-2428).
// For path-family kinds (e.g. list<path<md>>) resolveKeyOf returns the path
// STRING ITSELF as the shardKey (see packages/shared/src/shardingRegistry.ts:56
// and packages/shared/tests/sharding-registry.test.ts). Two identical items
// therefore mint two shard children carrying the IDENTICAL shardKey. Downstream,
// the aggregator's find-by-shardKey then returns the same row twice — one
// worker's output is silently dropped and the other is duplicated.
//
// CORRECT post-fix behavior: each minted shard child must have a UNIQUE shard
// identity. The fix is to uniquify duplicate path items (or reject duplicates)
// before sharding so that N items produce N distinct shardKeys.
//
// RED until scheduler.ts uniquifies/rejects duplicate shardSource items before
// minting shard children. Today both children share shardKey 'a.md' so the
// DISTINCT shardKey count is 1 instead of 2 → the headline assertion fails.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-shardkey-collision-'))
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

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(extra),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
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

describe('wrapper-fanout shardKey collision — duplicate shardSource items must mint distinct shard identities', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('two identical path items each get a UNIQUE shardKey (no collision)', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
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
    // The SAME path twice — this is the collision trigger.
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\na.md' })
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'r' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('done')

    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow.length).toBe(1)

    // Two items → two shard children, but each must own a DISTINCT shardKey.
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRow[0]!.id)
    expect(innerRows.length).toBe(2)

    // HEADLINE: each item must get a unique shard identity. Today both rows
    // share shardKey 'a.md' (path-family uses the path string as the key with
    // no de-dup), so the distinct count is 1 → this assertion FAILS until the
    // scheduler uniquifies/rejects duplicate path items before sharding.
    const distinctShardKeys = new Set(innerRows.map((r) => r.shardKey))
    expect(distinctShardKeys.size).toBe(2)
  })
})
