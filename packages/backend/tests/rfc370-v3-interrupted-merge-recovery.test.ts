// RFC-370 hosted acceptance (2026-10-17): a blue/green handoff — like a daemon
// crash — stopped a run's merge-back after the run had gone `done` but before
// its final snapshot pinned the node tree (merge_state 'isolating'). Two things
// went wrong on resume:
//
//   1. nothing completed such a row, so its scope stalled ("scheduler stalled /
//      no ready nodes in scope") — on the hosted instance the old holder even
//      stamped `merge-failed` after losing its lease (fenced separately, see
//      rfc370-v3-hosted-execution-control.test.ts);
//   2. merge recovery replayed every frame into the TASK worktree at task
//      entry, so a run inside a git wrapper landed past its wrapper and the
//      wrapper's `git_diff` never listed it.
//
// Locks, on both engines with real git: a revived git wrapper completes its
// body's interrupted run into the wrapper's own worktree before driving the
// body, without re-running the run; the wrapper's `git_diff` lists the run's
// file and the wrapper's own merge carries it to the task worktree.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createNodeIso, type CanonRepo } from '../src/services/nodeIsolation'
import { runGit } from '../src/util/git'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  createProviderTaskExecutionTestTopology,
  type ProviderTaskExecutionTestTopology,
} from './helpers/providerTaskExecutionTestTopology'

const ulid = monotonicFactory()
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function registerCases(provider: ProviderHarness) {
  let appHome: string
  let worktreePath: string
  let execution: ProviderTaskExecutionTestTopology | undefined

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc370-interrupted-merge-'))
    worktreePath = join(appHome, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    await runGit(worktreePath, ['init', '-q', '-b', 'main'])
    await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
    await runGit(worktreePath, ['config', 'user.name', 't'])
    writeFileSync(join(worktreePath, 'base.txt'), 'base\n')
    await runGit(worktreePath, ['add', '.'])
    await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
    execution = await createProviderTaskExecutionTestTopology(provider, appHome)
  })
  afterEach(async () => {
    try {
      await execution?.dispose()
    } finally {
      execution = undefined
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('a revived git wrapper completes its body run into the wrapper worktree, then merges it', async () => {
    const { db } = provider
    const agentId = ulid()
    const { agents, workflows, tasks, nodeRuns, nodeRunOutputs } = tablesOf(db)
    await insertOne(db, agents, { id: agentId, name: 'a', outputs: JSON.stringify(['summary']) })
    const definition = {
      $schema_version: 3,
      inputs: [],
      nodes: [
        { id: 'gw', kind: 'wrapper-git', nodeIds: ['A'] } as unknown as WorkflowNode,
        { id: 'A', kind: 'agent-single', agentId, agentName: 'a' } as WorkflowNode,
      ],
      edges: [],
    } as WorkflowDefinition
    const workflowId = ulid()
    const taskId = ulid()
    await insertOne(db, workflows, {
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify(definition),
    })
    await insertOne(db, tasks, {
      id: taskId,
      name: 'interrupted-merge',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktreePath,
      worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
    })

    // The state the interrupted holder left behind: the wrapper generation is
    // mid-body; its body run finished in its own worktree (branched from the
    // wrapper's) and went `done`, but the final snapshot never landed.
    const wrapperRunId = ulid()
    const runId = ulid()
    const canon: CanonRepo[] = [
      { repoPath: worktreePath, worktreePath, worktreeDirName: '', baseBranch: 'main' },
    ]
    const wrapperIso = await createNodeIso({
      appHome,
      taskId,
      nodeRunId: wrapperRunId,
      canonRepos: canon,
    })
    const wrapperWorktree = wrapperIso.repos[0]!.isoWorktreePath
    const baseline = (await runGit(wrapperWorktree, ['rev-parse', 'HEAD'])).stdout.trim()
    const runIso = await createNodeIso({
      appHome,
      taskId,
      nodeRunId: runId,
      canonRepos: [{ ...canon[0]!, worktreePath: wrapperWorktree }],
    })
    writeFileSync(join(runIso.repos[0]!.isoWorktreePath, 'produced.txt'), 'by the body run\n')
    await insertOne(db, nodeRuns, {
      id: wrapperRunId,
      taskId,
      nodeId: 'gw',
      iteration: 0,
      retryIndex: 0,
      status: 'interrupted',
      mergeState: 'isolating',
      isoBaseSnapshot: wrapperIso.repos[0]!.baseSnapshot,
      isoWorktreePath: wrapperIso.containerPath,
      wrapperProgressJson: JSON.stringify({
        kind: 'git',
        baseline,
        preDirty: {},
        baselines: { '': baseline },
        preDirtyByRepo: { '': {} },
        phase: 'inner-running',
      }),
      startedAt: Date.now(),
    })
    await insertOne(db, nodeRuns, {
      id: runId,
      taskId,
      nodeId: 'A',
      containerRunId: wrapperRunId,
      iteration: 0,
      retryIndex: 0,
      status: 'done',
      mergeState: 'isolating',
      isoBaseSnapshot: runIso.repos[0]!.baseSnapshot,
      isoWorktreePath: runIso.containerPath,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await insertOne(db, nodeRunOutputs, { nodeRunId: runId, portName: 'summary', content: 'ok' })

    await execution!.runTask({
      taskId,
      db,
      appHome,
      binaryOverride: ['bun', 'run', MOCK_OPENCODE],
    })

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect({ status: task.status, error: task.errorMessage }).toEqual({
      status: 'done',
      error: null,
    })
    // The body run was completed, not re-run.
    const bodyRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'A')))
    expect(bodyRuns.map((row) => ({ id: row.id, mergeState: row.mergeState }))).toEqual([
      { id: runId, mergeState: 'merged' },
    ])
    expect(bodyRuns[0]!.isoNodeTree).not.toBeNull()
    // It reached the wrapper first: the wrapper's diff lists it…
    const gitDiff = (
      await db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(eq(nodeRunOutputs.nodeRunId, wrapperRunId), eq(nodeRunOutputs.portName, 'git_diff')),
        )
    )[0]
    expect(gitDiff?.content).toBe('produced.txt')
    const wrapper = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, wrapperRunId)))[0]!
    expect({ status: wrapper.status, mergeState: wrapper.mergeState }).toEqual({
      status: 'done',
      mergeState: 'merged',
    })
    // …and the wrapper's own merge carried it to the task worktree.
    expect(readFileSync(join(worktreePath, 'produced.txt'), 'utf8')).toBe('by the body run\n')
    expect(existsSync(runIso.repos[0]!.isoWorktreePath)).toBe(false)
  }, 60_000)
}

describeEachProvider('RFC-370 interrupted merge-back recovery (real git)', (provider) => {
  describe('runtime fixture', () => registerCases(provider))
})
