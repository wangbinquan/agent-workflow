import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  tasks,
  workflows,
} from '@/db/schema'
import type {
  TaskDeletionContentEffects,
  TaskDeletionEffects,
} from '@/modules/task-execution/application/ports/taskDeletionContentEffects'
import type { TaskDeletionRepositoryParticipant } from '@/modules/source-control/public/participants'
import { selectedTaskDeletionEffects } from '@/modules/task-execution/composition/taskDeletionEffects'
import { createFileTaskDeletionContentEffects } from '@/modules/task-execution/infrastructure/local/fileTaskDeletionContentEffects'
import { createGitTaskDeletionRepositoryEffects } from '@/modules/source-control/composition'
import {
  cleanupDeletedTaskResources,
  parseDeleteCleanupPlan,
  recoverInterruptedTaskDeletes,
  type DeleteCleanupPlanV2,
} from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { deleteTask } from '@/services/taskDelete'
import { Paths } from '@/util/paths'
import { snapshotRefPrefix } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
type Operation = (name: string) => void | Promise<void>
class LogicalContent implements TaskDeletionContentEffects {
  #trace: string[]
  #operation: Operation
  constructor(trace: string[], operation: Operation = () => {}) {
    this.#trace = trace
    this.#operation = operation
    Object.freeze(this)
  }
  directories(taskId: string): readonly [string, string, string] {
    this.#trace.push('directories:' + taskId)
    return ['logical:runs/' + taskId, 'logical:logs/' + taskId, 'logical:scratch/' + taskId]
  }
  removeIfPresent(reference: string): void | Promise<void> {
    this.#trace.push('remove:' + reference)
    return this.#operation('remove:' + reference)
  }
}
class LogicalRepositories implements TaskDeletionRepositoryParticipant {
  #trace: string[]
  #operation: Operation
  constructor(trace: string[], operation: Operation = () => {}) {
    this.#trace = trace
    this.#operation = operation
    Object.freeze(this)
  }
  removeWorktree(input: {
    readonly repoPath: string
    readonly worktreePath: string
    readonly force: true
  }): void | Promise<void> {
    expect(input.force).toBe(true)
    const name = 'git:' + input.repoPath + ':' + input.worktreePath
    this.#trace.push(name)
    return this.#operation(name)
  }
  deleteSnapshotRefs(repoPath: string, taskId: string): void | Promise<void> {
    const name = 'refs:' + repoPath + ':' + taskId
    this.#trace.push(name)
    return this.#operation(name)
  }
}
function effects(
  trace: string[],
  content?: Operation,
  repositories?: Operation,
): TaskDeletionEffects {
  return Object.freeze({
    content: new LogicalContent(trace, content),
    repositories: new LogicalRepositories(trace, repositories),
  })
}
function member(taskId: string) {
  return {
    taskId,
    taskRevision: 1,
    ownerRevision: null,
    topologyRevision: 1,
    ledgerDigest: 'digest',
  }
}
function plan(taskId = 'task'): DeleteCleanupPlanV2 {
  return {
    v: 2,
    taskId,
    parentTaskId: null,
    worktrees: [
      { repoPath: 'repository:a', worktreePath: 'worktree:a' },
      { repoPath: 'repository:b', worktreePath: 'worktree:b' },
    ],
    directories: ['logical:one', 'logical:two'],
  }
}

test('complete frozen private receivers retain their identity; incomplete choices never fall back', () => {
  const trace: string[] = [],
    chosen = effects(trace)
  expect(selectedTaskDeletionEffects(chosen)).toBe(chosen)
  expect(selectedTaskDeletionEffects(chosen).content).toBe(chosen.content)
  expect(selectedTaskDeletionEffects(chosen).repositories).toBe(chosen.repositories)
  for (const value of [
    null,
    {},
    { content: chosen.content },
    { repositories: chosen.repositories },
    {
      content: {
        directories() {
          return []
        },
      },
      repositories: chosen.repositories,
    },
    { content: chosen.content, repositories: { removeWorktree() {} } },
  ]) {
    expect(() => selectedTaskDeletionEffects(value as unknown as TaskDeletionEffects)).toThrow(
      TypeError,
    )
  }
  expect(trace).toEqual([])
})

test('v1 derives from its durable members and v2 uses only frozen directories', () => {
  const trace: string[] = [],
    chosen = effects(trace)
  const v1 = parseDeleteCleanupPlan(
    JSON.stringify({ v: 1, taskId: 'root', worktrees: [], directories: 42 }),
    [member('root'), member('child')],
    chosen.content,
  )
  expect(v1?.directories).toEqual([
    'logical:runs/root',
    'logical:logs/root',
    'logical:scratch/root',
    'logical:runs/child',
    'logical:logs/child',
    'logical:scratch/child',
  ])
  expect(trace).toEqual(['directories:root', 'directories:child'])
  trace.length = 0
  const v2 = parseDeleteCleanupPlan(
    JSON.stringify({ ...plan(), parentTaskId: 42 }),
    [member('unrelated')],
    chosen.content,
  )
  expect(v2).toEqual({ ...plan(), parentTaskId: null })
  expect(trace).toEqual([])
  expect(
    parseDeleteCleanupPlan(JSON.stringify({ ...plan(), directories: [42] }), [], chosen.content),
  ).toBeNull()
  expect(parseDeleteCleanupPlan('invalid', [], chosen.content)).toBeNull()
  expect(() =>
    parseDeleteCleanupPlan(
      JSON.stringify(plan()),
      [],
      null as unknown as TaskDeletionContentEffects,
    ),
  ).toThrow(TypeError)
})

test('held repository acknowledgement prevents later refs and directory cleanup', async () => {
  const entered = gate(),
    release = gate(),
    trace: string[] = []
  const chosen = effects(trace, undefined, (name) => {
    if (name === 'git:repository:a:worktree:a') {
      entered.release()
      return release.promise
    }
  })
  let settled = false
  const pending = cleanupDeletedTaskResources(plan(), chosen).then((result) => {
    settled = true
    return result
  })
  await entered.promise
  expect(settled).toBe(false)
  expect(trace).toEqual(['git:repository:a:worktree:a'])
  release.release()
  expect(await pending).toBe('done')
  expect(trace).toEqual([
    'git:repository:a:worktree:a',
    'refs:repository:a:task',
    'git:repository:b:worktree:b',
    'refs:repository:b:task',
    'remove:logical:one',
    'remove:logical:two',
  ])
})

test('failed Git remains pending after a successful fallback; refs and later targets continue', async () => {
  const trace: string[] = [],
    failure = { message: 'selected failure' }
  const chosen = effects(
    trace,
    (name) => {
      if (name === 'remove:logical:one') return Promise.reject(undefined)
    },
    (name) => {
      if (name === 'git:repository:a:worktree:a' || name === 'refs:repository:a:task') throw failure
    },
  )
  expect(await cleanupDeletedTaskResources(plan(), chosen)).toBe('pending')
  expect(trace).toEqual([
    'git:repository:a:worktree:a',
    'remove:worktree:a',
    'refs:repository:a:task',
    'git:repository:b:worktree:b',
    'refs:repository:b:task',
    'remove:logical:one',
    'remove:logical:two',
  ])
})

test('native content adapter retains default directory operands and compound idempotent cleanup', () => {
  const native = createFileTaskDeletionContentEffects(),
    taskId = 'native-' + ulid()
  expect(Object.isFrozen(native)).toBe(true)
  expect(native.directories(taskId)).toEqual([
    join(Paths.runsDir, taskId),
    join(Paths.logsDir, taskId),
    join(Paths.root, 'scratch', taskId),
  ])
  const root = mkdtempSync(join(tmpdir(), 'aw-task-delete-content-'))
  try {
    const directory = join(root, 'nested')
    mkdirSync(directory)
    writeFileSync(join(directory, 'binary'), Buffer.from([0, 255, 0]))
    expect(native.removeIfPresent(directory)).toBeUndefined()
    expect(existsSync(directory)).toBe(false)
    expect(native.removeIfPresent(directory)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function seed(
  db: ProviderNeutralDatabase,
  taskId: string,
  parentTaskId?: string,
): Promise<void> {
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: 'wf_' + taskId,
    name: 'rfc370-task-delete',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'wf_' + taskId,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: 'repository:' + taskId,
    worktreePath: 'worktree:' + taskId,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    finishedAt: 2,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
  })
}
async function claimState(db: ProviderNeutralDatabase, claimId: string) {
  return (
    await db
      .select({ state: taskExecutionMaintenanceClaims.state })
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, claimId))
  )[0]?.state
}
async function exists(db: ProviderNeutralDatabase, taskId: string) {
  return (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length > 0
}
const activity = Object.freeze({ isActive: () => false, awaitReleasedSettled: async () => {} })

describeEachProvider('RFC-370 task deletion complete selected effects', (harness) => {
  test('online deletion retains DB-finalized claim until selected content ACK then releases members', async () => {
    const db = harness.db,
      taskId = 'delete_' + ulid(),
      entered = gate(),
      release = gate(),
      trace: string[] = []
    await seed(db, taskId)
    const chosen = effects(trace, (name) => {
      if (name === 'remove:logical:runs/' + taskId) {
        entered.release()
        return release.promise
      }
    })
    const pending = deleteTask(db, taskId, { activity, effects: chosen })
    await entered.promise
    const claims = await createTaskExecutionPersistence(db).terminalMaintenance.listRecoverable({
      operation: 'delete',
    })
    const item = claims.find((x) => x.rootTaskId === taskId)
    expect(item).toBeDefined()
    expect(item!.members).toHaveLength(1)
    expect(item?.state).toBe('db-finalized')
    expect(await exists(db, taskId)).toBe(false)
    expect(JSON.parse(item!.cleanupPlanJson).directories).toEqual([
      'logical:runs/' + taskId,
      'logical:logs/' + taskId,
      'logical:scratch/' + taskId,
    ])
    expect(
      (
        await db
          .select({ releasedAt: taskExecutionMaintenanceMembers.releasedAt })
          .from(taskExecutionMaintenanceMembers)
          .where(eq(taskExecutionMaintenanceMembers.claimId, item!.claim.claimId))
      ).every((x) => x.releasedAt === null),
    ).toBe(true)
    release.release()
    expect(await pending).toEqual({ taskId, cleanup: 'done' })
    expect(await claimState(db, item!.claim.claimId)).toBe('completed')
    expect(
      (
        await db
          .select({ releasedAt: taskExecutionMaintenanceMembers.releasedAt })
          .from(taskExecutionMaintenanceMembers)
          .where(eq(taskExecutionMaintenanceMembers.claimId, item!.claim.claimId))
      ).every((x) => x.releasedAt !== null),
    ).toBe(true)
    expect(trace.filter((x) => x.startsWith('directories:'))).toEqual(['directories:' + taskId])
  })

  test('v1 resumed deletion derives the exact durable tree and waits before completed settlement', async () => {
    const db = harness.db,
      taskId = 'resume_' + ulid(),
      childId = taskId + '_child',
      trace: string[] = [],
      entered = gate(),
      release = gate()
    await seed(db, taskId)
    await seed(db, childId, taskId)
    const persistence = createTaskExecutionPersistence(db),
      members = await persistence.terminalMaintenance.snapshotTree(taskId)
    const claim = await persistence.terminalMaintenance.claim({
      rootTaskId: taskId,
      operation: 'delete',
      members,
      cleanupPlanJson: JSON.stringify({ v: 1, taskId, worktrees: [], directories: 42 }),
    })
    await persistence.terminalMaintenance.transition({ claim, to: 'io-complete' })
    const chosen = effects(trace, (name) => {
      if (name === 'remove:logical:runs/' + taskId) {
        entered.release()
        return release.promise
      }
    })
    const pending = recoverInterruptedTaskDeletes(db, persistence.terminalMaintenance, chosen)
    await entered.promise
    expect(await exists(db, taskId)).toBe(false)
    expect(await exists(db, childId)).toBe(false)
    expect(await claimState(db, claim.claimId)).toBe('db-finalized')
    expect(trace.filter((x) => x.startsWith('directories:')).sort()).toEqual(
      ['directories:' + taskId, 'directories:' + childId].sort(),
    )
    release.release()
    expect(await pending).toEqual({ completed: [taskId], cleanupPending: [], recoveryRequired: [] })
    expect(await claimState(db, claim.claimId)).toBe('completed')
    expect(trace.filter((x) => x.startsWith('remove:')).sort()).toEqual(
      members
        .flatMap((x) => [
          'remove:logical:runs/' + x.taskId,
          'remove:logical:logs/' + x.taskId,
          'remove:logical:scratch/' + x.taskId,
        ])
        .sort(),
    )
  })

  test('online pending cleanup replays frozen v2 references without deriving new directories', async () => {
    const db = harness.db,
      taskId = 'retry_' + ulid(),
      firstTrace: string[] = []
    await seed(db, taskId)
    expect(
      await deleteTask(db, taskId, {
        activity,
        effects: effects(firstTrace, undefined, (name) => {
          if (name.startsWith('git:')) throw new Error('worktree unavailable')
        }),
      }),
    ).toEqual({ taskId, cleanup: 'pending' })
    const persistence = createTaskExecutionPersistence(db),
      item = (await persistence.terminalMaintenance.listRecoverable({ operation: 'delete' })).find(
        (x) => x.rootTaskId === taskId,
      )!
    expect(item.state).toBe('cleanup-pending')
    expect(await exists(db, taskId)).toBe(false)
    const retryTrace: string[] = [],
      retry = effects(retryTrace)
    expect(await recoverInterruptedTaskDeletes(db, persistence.terminalMaintenance, retry)).toEqual(
      { completed: [taskId], cleanupPending: [], recoveryRequired: [] },
    )
    expect(retryTrace.some((x) => x.startsWith('directories:'))).toBe(false)
    expect(retryTrace.filter((x) => x.startsWith('remove:'))).toEqual([
      'remove:logical:runs/' + taskId,
      'remove:logical:logs/' + taskId,
      'remove:logical:scratch/' + taskId,
    ])
    expect(await claimState(db, item.claim.claimId)).toBe('completed')
  })
})

test('SC native factory removes a real Git worktree and only the task snapshot refs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-task-delete-git-')),
    repo = join(root, 'repo'),
    worktree = join(root, 'worktree'),
    taskId = 'native_' + ulid()
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    mkdirSync(repo)
    git('init')
    git(
      '-c',
      'user.name=RFC370',
      '-c',
      'user.email=rfc370@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    )
    const head = git('rev-parse', 'HEAD'),
      ref = snapshotRefPrefix(taskId) + '/one',
      otherRef = snapshotRefPrefix(taskId + '_other') + '/one'
    git('update-ref', ref, head)
    git('update-ref', otherRef, head)
    git('worktree', 'add', '--detach', worktree, 'HEAD')
    const native = createGitTaskDeletionRepositoryEffects()
    expect(Object.isFrozen(native)).toBe(true)
    await native.removeWorktree({ repoPath: repo, worktreePath: worktree, force: true })
    expect(existsSync(worktree)).toBe(false)
    await native.deleteSnapshotRefs(repo, taskId)
    expect(git('for-each-ref', '--format=%(refname)', ref)).toBe('')
    expect(git('show-ref', '--verify', otherRef)).toContain(head)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
