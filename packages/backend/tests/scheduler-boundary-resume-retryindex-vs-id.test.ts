import { rimrafDir } from './helpers/cleanup'
// Locked regression: resumeTask picks the rollback row by retryIndex instead of
// id (ULID) order.
//
// DEFECT (HIGH): resumeTask selects the latest-non-done run per node via
//   `if (prev === undefined || r.retryIndex > prev.retryIndex) latestPerNode.set(...)`
// at packages/backend/src/services/task.ts:982-990. But the scheduler's single
// source of truth for "which run is freshest" is pure ULID id order —
// `isFresherNodeRun` (packages/backend/src/services/scheduler.ts:436-442), whose
// docstring (scheduler.ts:420-434) EXPLICITLY rejects retryIndex / (retryIndex,id)
// ordering: a retry storm can inflate retryIndex on a stale row above a later,
// low-retryIndex clarify rerun. A clarify-driven rerun is minted with
// retryIndex:0 but a NEWER ULID; when an older failed retry carries a higher
// retryIndex, resumeTask rolls the worktree back to the WRONG (older) row's
// pre_snapshot instead of the freshest row's.
//
// RED until resumeTask is changed to pick the latest-non-done run per node by id
// order (the isFresherNodeRun authority), matching the scheduler.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { runGit, gitStashSnapshot, rollbackToSnapshot } from '../src/util/git'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { resumeTask } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-resume-rtidx-id-'))
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

describe('resumeTask freshest-row selection locks isFresherNodeRun id-order (NOT retryIndex)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('rolls back to the run with the NEWER ULID even when an older row has a higher retryIndex', async () => {
    const repo = h.worktreePath

    // Real git repo with a committed clean baseline (src.txt = 'base').
    await runGit(repo, ['init', '-q', '-b', 'main'])
    await runGit(repo, ['config', 'user.email', 't@e.com'])
    await runGit(repo, ['config', 'user.name', 'T'])
    writeFileSync(join(repo, 'src.txt'), 'base\n')
    await runGit(repo, ['add', '.'])
    await runGit(repo, ['commit', '-q', '-m', 'init'])

    // Two distinct stashes capturing two different dirty states. `git stash
    // create` does NOT modify the worktree, so we just rewrite src.txt between
    // snapshots.
    writeFileSync(join(repo, 'src.txt'), 'X\n')
    const shaX = await gitStashSnapshot(repo)
    writeFileSync(join(repo, 'src.txt'), 'Y\n')
    const shaY = await gitStashSnapshot(repo)
    // Leave the worktree dirty in a third state so the rollback is observable.
    writeFileSync(join(repo, 'src.txt'), 'Z\n')

    // Guard: snapshots must be real & distinct (tree was genuinely dirty).
    expect(shaX).not.toBe('')
    expect(shaY).not.toBe('')
    expect(shaX).not.toBe(shaY)

    // Sanity-check the snapshots actually restore the expected content. This
    // also asserts our assumption about which sha maps to which content, so the
    // headline assertion below is unambiguous.
    await rollbackToSnapshot(repo, shaX)
    expect(readFileSync(join(repo, 'src.txt'), 'utf-8')).toBe('X\n')
    await rollbackToSnapshot(repo, shaY)
    expect(readFileSync(join(repo, 'src.txt'), 'utf-8')).toBe('Y\n')
    // Re-dirty the tree so resumeTask's rollback is the thing under test.
    writeFileSync(join(repo, 'src.txt'), 'Z\n')

    // Seed a writer agent + a single-node workflow.
    await seedAgent(h.db, 'fixer', ['summary'])
    const definition = {
      nodes: [{ id: 'a1', kind: 'agent-single', agentName: 'fixer', promptTemplate: 'go' }],
      edges: [],
    } as unknown as WorkflowDefinition

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
      worktreePath: repo,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'interrupted',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })

    // Two node_runs for nodeId 'a1'. Plain ulid() is NOT monotonic within the
    // same millisecond, so derive the ids from explicit increasing timestamps:
    // a larger timestamp prefix makes idB lexicographically greater than idA
    // deterministically (no flakiness).
    const idA = ulid(1_000)
    const idB = ulid(2_000)
    expect(idB > idA).toBe(true)

    // Row A: OLDER id, FAILED, higher retryIndex, pre-snapshot = shaX ('X').
    await h.db.insert(nodeRuns).values({
      id: idA,
      taskId,
      nodeId: 'a1',
      status: 'failed',
      retryIndex: 3,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: null,
      preSnapshot: shaX,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    // Row B: NEWER id (clarify-style rerun), interrupted, retryIndex 0,
    // pre-snapshot = shaY ('Y'). This is the freshest row by id authority.
    await h.db.insert(nodeRuns).values({
      id: idB,
      taskId,
      nodeId: 'a1',
      status: 'interrupted',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: null,
      preSnapshot: shaY,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    // resumeTask performs the rollback synchronously before returning; the
    // subsequent runTask kick is void-ed (harmless `true` command).
    await resumeTask(h.db, taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })

    // HEADLINE: the freshest row by id (B) should drive the rollback → 'Y'.
    // Today resumeTask picks A (retryIndex 3) and applies shaX → 'X' → FAILS.
    expect(readFileSync(join(repo, 'src.txt'), 'utf-8')).toBe('Y\n')
  })
})
