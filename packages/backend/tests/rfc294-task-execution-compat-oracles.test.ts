// RFC-294 W1/W2/P0-D refactor compatibility oracles.
//
// These tests intentionally enter through today's public backend seams rather
// than freezing RFC-294's proposed classes. They protect the observable
// ownership/lifecycle contracts that TaskEngine -> WrapperRuntime ->
// NodeExecutor -> ExecutionKernel must preserve while those layers move:
//   1. the retained ownerless scheduler test seam still dispatches exactly once;
//   2. unlike-operation resume/retry races still have one owner and no loser
//      placeholder/process pollution;
//   3. daemon shutdown settles task + node as interrupted, then resume makes a
//      fresh generation and reaches one terminal result;
//   4. a route/call/workgroup pre-materialized handoff takes precedence over
//      JSON deferred repository preparation, including its failure arm.

import {
  DAEMON_RESTART_ERROR_SUMMARY,
  DAEMON_SHUTDOWN_ABORT_REASON,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  nodeRuns,
  taskExecutionEffects,
  taskExecutionOwners,
  tasks,
  workflows,
} from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import {
  abortAllActiveTasks,
  cancelTask,
  isTaskActive,
  resumeTask,
  retryNode,
  startTask,
  startTaskWithLocalRepo,
  type MaterializedSpace,
} from '../src/services/task'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  root: string
  appHome: string
  sourceRepo: string
  ctrlDir: string
  workflowId: string
  definition: WorkflowDefinition
  doneMock: string
  slowMock: string
  taskIds: Set<string>
}

let h: Harness | undefined

function doneMockSource(ctrlDir: string): string {
  return `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(ctrlDir, 'spawn-log'))}, 'F')
const argv = process.argv.slice(2)
const prompt = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1).join(' ') : (argv[1] ?? '')
const nonce = /\\bnonce="([^"]+)"/.exec(prompt)?.[1]
const open = nonce === undefined ? '<workflow-output>' : '<workflow-output nonce="' + nonce + '">'
const text = open + '\\n  <port name="out">OK</port>\\n</workflow-output>'
process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\\n')
`
}

function slowMockSource(ctrlDir: string): string {
  return `import { appendFileSync, writeFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(ctrlDir, 'spawn-log'))}, 'S')
writeFileSync(${JSON.stringify(join(ctrlDir, 'slow-started'))}, '1')
await Bun.sleep(120000)
`
}

async function buildHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc294-execution-'))
  const appHome = join(root, 'home')
  const sourceRepo = join(root, 'source')
  const ctrlDir = join(root, 'ctrl')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(sourceRepo, { recursive: true })
  mkdirSync(ctrlDir, { recursive: true })

  await runGit(sourceRepo, ['init', '-q', '-b', 'main'])
  await runGit(sourceRepo, ['config', 'user.email', 'rfc294@test.invalid'])
  await runGit(sourceRepo, ['config', 'user.name', 'RFC 294'])
  writeFileSync(join(sourceRepo, 'README.md'), '# RFC 294 execution oracle\n')
  await runGit(sourceRepo, ['add', '.'])
  await runGit(sourceRepo, ['commit', '-q', '-m', 'seed'])

  const doneMock = join(ctrlDir, 'done.ts')
  const slowMock = join(ctrlDir, 'slow.ts')
  writeFileSync(doneMock, doneMockSource(ctrlDir))
  writeFileSync(slowMock, slowMockSource(ctrlDir))

  const db = createInMemoryDb(MIGRATIONS)
  const agentId = ulid()
  await db.insert(agents).values({
    id: agentId,
    name: 'rfc294-worker',
    description: 'RFC-294 execution compatibility oracle',
    outputs: JSON.stringify(['out']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      {
        id: 'work',
        kind: 'agent-single',
        agentId,
        agentName: 'rfc294-worker',
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc294-execution-oracle',
    definition: JSON.stringify(definition),
  })
  return {
    db,
    root,
    appHome,
    sourceRepo,
    ctrlDir,
    workflowId,
    definition,
    doneMock,
    slowMock,
    taskIds: new Set(),
  }
}

async function seedTask(
  harness: Harness,
  status: 'pending' | 'failed',
): Promise<{ taskId: string; failedRunId?: string }> {
  const taskId = ulid()
  const branch = `rfc294/${taskId}`
  const worktreePath = join(harness.root, 'seeded-worktrees', taskId)
  mkdirSync(resolve(worktreePath, '..'), { recursive: true })
  await runGit(harness.sourceRepo, ['worktree', 'add', '-q', '-b', branch, worktreePath, 'main'])
  const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
  await harness.db.insert(tasks).values({
    id: taskId,
    name: `rfc294-${status}`,
    workflowId: harness.workflowId,
    workflowSnapshot: JSON.stringify(harness.definition),
    repoPath: harness.sourceRepo,
    worktreePath,
    baseBranch: 'main',
    branch,
    baseCommit: head,
    status,
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    finishedAt: status === 'failed' ? Date.now() - 500 : null,
    errorSummary: status === 'failed' ? 'seed failure' : null,
    errorMessage: status === 'failed' ? 'seed failure' : null,
    failedNodeId: status === 'failed' ? 'work' : null,
  })
  harness.taskIds.add(taskId)
  if (status === 'pending') return { taskId }

  const failedRunId = ulid()
  await harness.db.insert(nodeRuns).values({
    id: failedRunId,
    taskId,
    nodeId: 'work',
    status: 'failed',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1_000,
    finishedAt: Date.now() - 500,
    errorMessage: 'seed failure',
  })
  return { taskId, failedRunId }
}

function runtimeDeps(harness: Harness, mock: string) {
  return {
    db: harness.db,
    appHome: harness.appHome,
    binaryOverride: [process.execPath, 'run', mock],
    defaultNodeRetries: 0,
  }
}

function spawnLog(harness: Harness): string {
  const path = join(harness.ctrlDir, 'spawn-log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(`timeout waiting for ${what}`)
}

async function taskRow(db: DbClient, taskId: string) {
  return (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
}

async function waitForStatus(db: DbClient, taskId: string, status: string) {
  await waitFor(async () => (await taskRow(db, taskId))?.status === status, `task ${status}`)
  return (await taskRow(db, taskId))!
}

afterEach(async () => {
  const current = h
  h = undefined
  if (current === undefined) return
  for (const taskId of current.taskIds) {
    const row = await taskRow(current.db, taskId)
    if (
      row !== undefined &&
      ['pending', 'running', 'awaiting_review', 'awaiting_human'].includes(row.status)
    ) {
      try {
        await cancelTask(current.db, taskId)
      } catch {
        // A concurrently settling scheduler can legitimately win this cleanup race.
      }
    }
    await waitFor(() => !isTaskActive(taskId), `task ${taskId} driver release`)
  }
  current.db.$client.close()
  rmSync(current.root, { recursive: true, force: true })
})

describe('RFC-294 task execution/lifecycle compatibility oracles', () => {
  test('two simultaneous runTask kicks: pending claim, process dispatch and terminal settlement happen exactly once', async () => {
    h = await buildHarness()
    const { taskId } = await seedTask(h, 'pending')
    const opts = {
      taskId,
      db: h.db,
      appHome: h.appHome,
      binaryOverride: [process.execPath, 'run', h.doneMock],
      defaultNodeRetries: 0,
    }

    await Promise.all([runTask(opts), runTask(opts)])

    const final = await taskRow(h.db, taskId)
    expect(final?.status).toBe('done')
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const workRows = rows.filter((row) => row.nodeId === 'work')
    expect(workRows).toHaveLength(1)
    expect(workRows[0]?.status).toBe('done')
    expect(workRows[0]?.retryIndex).toBe(0)
    expect(spawnLog(h)).toBe('F')
  }, 30_000)

  test('resumeTask racing retryNode: one heterogeneous owner wins; loser mints no placeholder and starts no process', async () => {
    h = await buildHarness()
    const seeded = await seedTask(h, 'failed')
    const failedRunId = seeded.failedRunId!
    const deps = runtimeDeps(h, h.slowMock)

    const results = await Promise.allSettled([
      resumeTask(h.db, seeded.taskId, deps),
      retryNode(h.db, seeded.taskId, failedRunId, { cascade: true, deps }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    const error = rejected.reason as { code?: string; status?: number }
    expect(error.code === 'task-not-resumable' || error.code === 'task-still-running').toBe(true)
    expect(error.status).toBe(409)

    await waitFor(() => existsSync(join(h!.ctrlDir, 'slow-started')), 'single slow process')
    expect(spawnLog(h)).toBe('S')
    const beforeCancel = await h.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, seeded.taskId))
    const indexes = beforeCancel.filter((row) => row.nodeId === 'work').map((row) => row.retryIndex)
    expect(new Set(indexes).size).toBe(indexes.length)
    const placeholders = beforeCancel.filter((row) => row.errorMessage === 'queued for retry')
    const retryWon = results[1]?.status === 'fulfilled'
    expect(placeholders).toHaveLength(retryWon ? 1 : 0)

    await cancelTask(h.db, seeded.taskId)
    const final = await waitForStatus(h.db, seeded.taskId, 'canceled')
    expect(final.status).toBe('canceled')
    await waitFor(() => !isTaskActive(seeded.taskId), 'mixed-race owner release')
    expect(spawnLog(h)).toBe('S')
  }, 30_000)

  test('daemon shutdown settles node and task as interrupted; resume owns a fresh generation and reaches done', async () => {
    h = await buildHarness()
    const started = await startTaskWithLocalRepo(
      {
        workflowId: h.workflowId,
        name: 'rfc294-daemon-resume',
        inputs: {},
        repoPath: h.sourceRepo,
        baseBranch: 'main',
      },
      runtimeDeps(h, h.slowMock),
    )
    h.taskIds.add(started.id)

    await waitFor(() => existsSync(join(h!.ctrlDir, 'slow-started')), 'pre-shutdown process')
    await waitFor(() => isTaskActive(started.id), 'registered task driver')
    expect(abortAllActiveTasks(DAEMON_SHUTDOWN_ABORT_REASON)).toContain(started.id)

    const interrupted = await waitForStatus(h.db, started.id, 'interrupted')
    await waitFor(() => !isTaskActive(started.id), 'shutdown owner release')
    expect(interrupted.errorSummary).toBe(DAEMON_RESTART_ERROR_SUMMARY)
    const firstGeneration = await h.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, started.id))
    expect(firstGeneration.filter((row) => row.nodeId === 'work')).toHaveLength(1)
    expect(firstGeneration.find((row) => row.nodeId === 'work')?.status).toBe('interrupted')

    const resumed = await resumeTask(h.db, started.id, {
      ...runtimeDeps(h, h.doneMock),
      awaitScheduler: true,
    })
    expect(resumed.status).toBe('done')
    const generations = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, started.id)))
      .filter((row) => row.nodeId === 'work')
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(generations.map((row) => [row.retryIndex, row.status])).toEqual([
      [0, 'interrupted'],
      [1, 'done'],
    ])
    expect(spawnLog(h)).toBe('SF')
    expect(isTaskActive(started.id)).toBe(false)
    const owner = (
      await h.db
        .select({ epoch: taskExecutionOwners.epoch, state: taskExecutionOwners.state })
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, started.id))
    )[0]
    expect(owner).toEqual({ epoch: 2, state: 'released' })
    const processGenerations = (
      await h.db
        .select({
          kind: taskExecutionEffects.kind,
          state: taskExecutionEffects.state,
          operationGeneration: taskExecutionEffects.operationGeneration,
        })
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.taskId, started.id))
    )
      .filter((effect) => effect.kind === 'process')
      .sort((left, right) => left.operationGeneration - right.operationGeneration)
    expect(processGenerations).toEqual([
      { kind: 'process', state: 'succeeded', operationGeneration: 0 },
      { kind: 'process', state: 'succeeded', operationGeneration: 1 },
    ])
  }, 30_000)

  test('pre-materialized failure handoff wins over deferred repository preparation and preserves handed-off task identity', async () => {
    h = await buildHarness()
    const taskId = ulid()
    const sentinel = 'rfc294-pre-materialized-failure-sentinel'
    const materializedSpace: MaterializedSpace = {
      kind: 'single',
      spaceKind: 'remote',
      taskId,
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: sentinel,
      resolvedSources: [],
      repos: [],
      nodePaths: [],
      cleanup: {
        taskId,
        ownedRoot: null,
        worktrees: [],
        state: 'owned',
        report: null,
      },
    }

    const result = await startTask(
      {
        workflowId: h.workflowId,
        name: 'rfc294-materialized-handoff',
        inputs: {},
        repoUrl: 'https://example.invalid/must-not-be-resolved.git',
      },
      {
        db: h.db,
        appHome: h.appHome,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        materializedSpace,
        awaitScheduler: true,
      },
    )
    h.taskIds.add(result.id)

    expect(result.id).toBe(taskId)
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe(sentinel)
    expect(result.errorSummary).toContain(sentinel)
    expect(materializedSpace.cleanup.state).toBe('committed')
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(rows).toHaveLength(0)
    expect(rows.some((row) => row.nodeId === '__repo_prep__')).toBe(false)
    expect(isTaskActive(taskId)).toBe(false)
  }, 30_000)
})
