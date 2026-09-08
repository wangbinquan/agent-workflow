// RFC-359 W21: reuse only immutable client query builders. Every observation
// still executes four real statements and remains visible to a late recorder.
// The original owner below is a frozen data/SQL oracle (70258c078f12ee35...),
// with its opaque input branch copied verbatim and no new branch semantics.
import { expect, spyOn, test } from 'bun:test'
import { and, count, eq, gte, inArray, isNull, or, type SQL } from 'drizzle-orm'
import type { OverviewTasks } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks, users, workflows } from '@/db/schema'
import { createTaskOverviewQuery } from '@/modules/task-execution/infrastructure/taskOverviewQuery'
import type { TaskOverviewQuery } from '@/modules/task-execution/public/queries'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement, StatementRecording } from './helpers/statementRecorder'

async function originalLoadOverview(
  db: ProviderNeutralDatabase,
  input: Parameters<TaskOverviewQuery['load']>[0],
): Promise<OverviewTasks> {
  const canReadAll = input.actor.permissions.has('tasks:read:all')
  if (!canReadAll && !input.actor.permissions.has('tasks:read:own')) {
    return { running: 0, awaiting: 0, done7d: 0, failed7d: 0 }
  }

  const collaboratorTaskIds = db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, input.actor.user.id))
  const visibility = canReadAll
    ? undefined
    : or(eq(tasks.ownerUserId, input.actor.user.id), inArray(tasks.id, collaboratorTaskIds))
  const countWhere = async (status: SQL<unknown>): Promise<number> => {
    const rows = await db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(visibility, isNull(tasks.parentTaskId), eq(tasks.catalogVisibility, 'public'), status),
      )
    return rows[0]?.value ?? 0
  }

  const [running, awaiting, done7d, failed7d] = await Promise.all([
    countWhere(eq(tasks.status, 'running')),
    countWhere(inArray(tasks.status, ['awaiting_review', 'awaiting_human'])),
    countWhere(and(eq(tasks.status, 'done'), gte(tasks.finishedAt, input.since))!),
    countWhere(and(eq(tasks.status, 'failed'), gte(tasks.finishedAt, input.since))!),
  ])
  return { running, awaiting, done7d, failed7d }
}

const since = 1_700_000_000_000
const primary = buildActor({
  user: {
    id: 'overview-a',
    username: 'overview-a',
    displayName: 'overview-a',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
// These are existing input shapes for the frozen oracle. The tests compare
// current statements/bindings/results, without assigning new input meanings.
const inputs: readonly Parameters<TaskOverviewQuery['load']>[0][] = [
  { actor: primary, since },
  { actor: { ...primary, permissions: new Set(['tasks:read:own']) }, since },
  {
    actor: {
      ...primary,
      user: { ...primary.user, id: 'overview-b' },
      permissions: new Set(['tasks:read:own']),
    },
    since,
  },
  { actor: { ...primary, permissions: new Set() }, since },
]

async function seed(harness: ProviderHarness) {
  for (const id of ['overview-a', 'overview-b']) {
    await harness.db.insert(users).values({
      id,
      username: id,
      displayName: id,
      role: 'admin',
      status: 'active',
      passwordHash: 'fixture',
      createdAt: since,
      updatedAt: since,
    })
  }
  await harness.db
    .insert(workflows)
    .values({ id: 'overview-wf', name: 'overview', definition: '{}' })
  const rows = [
    { id: 'a-running', status: 'running', ownerUserId: 'overview-a' },
    { id: 'b-running', status: 'running', ownerUserId: 'overview-b' },
    { id: 'a-awaiting', status: 'awaiting_review', ownerUserId: 'overview-a' },
    { id: 'b-awaiting', status: 'awaiting_human', ownerUserId: 'overview-b' },
    { id: 'a-done', status: 'done', ownerUserId: 'overview-a', finishedAt: since },
    { id: 'a-old-done', status: 'done', ownerUserId: 'overview-a', finishedAt: since - 1 },
    { id: 'b-done', status: 'done', ownerUserId: 'overview-b', finishedAt: since + 1 },
    { id: 'a-failed', status: 'failed', ownerUserId: 'overview-a', finishedAt: since },
    { id: 'b-old-failed', status: 'failed', ownerUserId: 'overview-b', finishedAt: since - 1 },
    { id: 'a-child', status: 'running', ownerUserId: 'overview-a', parentTaskId: 'a-running' },
    {
      id: 'a-internal',
      status: 'running',
      ownerUserId: 'overview-a',
      catalogVisibility: 'internal',
    },
  ] as const
  for (const row of rows) {
    await harness.db.insert(tasks).values({
      workflowId: 'overview-wf',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: '/fixture/repo',
      worktreePath: `/fixture/${row.id}`,
      name: row.id,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      startedAt: since,
      branchStartedAt: since,
      rootTaskId: row.id,
      catalogVisibility: 'public',
      ...row,
    })
  }
}

function statementContract(statements: readonly RecordedStatement[]) {
  // The four original reads are concurrent. Preserve every SQL byte, binding,
  // parameter count and row count; normalize only their completion order.
  return statements
    .map(({ sql, params, values, rows }) => ({ sql, params, values, rows }))
    .sort((left, right) => {
      const a = JSON.stringify(left)
      const b = JSON.stringify(right)
      return a < b ? -1 : a > b ? 1 : 0
    })
}

async function capture<T>(recording: StatementRecording, run: () => Promise<T>) {
  const start = recording.statements.length
  const value = await run()
  return { value, statements: recording.statements.slice(start) }
}

async function compare(
  db: ProviderNeutralDatabase,
  owner: TaskOverviewQuery,
  recording: StatementRecording,
  input: Parameters<TaskOverviewQuery['load']>[0],
) {
  const actual = await capture(recording, () => owner.load(input))
  const original = await capture(recording, () => originalLoadOverview(db, input))
  expect(actual.value).toEqual(original.value)
  expect(statementContract(actual.statements)).toEqual(statementContract(original.statements))
  return actual
}

describeEachProvider('RFC-359 W21 task overview query templates', (harness) => {
  test('a warmed owner retains all four real executions when recording starts later', async () => {
    await seed(harness)
    const owner = createTaskOverviewQuery(harness.db)
    const warmed = await owner.load(inputs[0]!)
    expect(warmed).toEqual({ running: 2, awaiting: 2, done7d: 2, failed7d: 1 })
    const recording = harness.recordStatements()
    try {
      const actual = await compare(harness.db, owner, recording, inputs[0]!)
      expect(actual.statements).toHaveLength(4)
      expect(actual.statements.every((row) => row.rows === 1)).toBe(true)
    } finally {
      recording.stop()
    }
  })

  test('one owner preserves old SQL and current bindings across input shapes and data updates', async () => {
    await seed(harness)
    const owner = createTaskOverviewQuery(harness.db)
    for (const input of inputs) await owner.load(input)
    const recording = harness.recordStatements()
    try {
      for (const input of inputs) await compare(harness.db, owner, recording, input)
      await harness.db
        .update(tasks)
        .set({ status: 'done', finishedAt: since + 2 })
        .where(eq(tasks.id, 'a-running'))
      await harness.db
        .update(tasks)
        .set({ status: 'failed', finishedAt: since + 3 })
        .where(eq(tasks.id, 'b-awaiting'))
      for (const input of inputs) {
        await compare(harness.db, owner, recording, input)
        await compare(harness.db, owner, recording, { ...input, since: since + 2 })
      }
      const current = await owner.load(inputs[0]!)
      expect(current).toEqual({ running: 1, awaiting: 1, done7d: 3, failed7d: 2 })
    } finally {
      recording.stop()
    }
  })

  test('two simultaneous loads bind distinct current windows through the same warmed owner', async () => {
    await seed(harness)
    const owner = createTaskOverviewQuery(harness.db)
    await owner.load(inputs[0]!)
    await owner.load(inputs[1]!)
    const recording = harness.recordStatements()
    try {
      for (const input of inputs.slice(0, 3)) {
        const pair = [input, { ...input, since: since + 1 }]
        const original = await capture(recording, () =>
          Promise.all(pair.map((item) => originalLoadOverview(harness.db, item))),
        )
        const actual = await capture(recording, () =>
          Promise.all(pair.map((item) => owner.load(item))),
        )
        expect(actual.value).toEqual(original.value)
        expect(actual.statements).toHaveLength(8)
        expect(statementContract(actual.statements)).toEqual(statementContract(original.statements))
      }
    } finally {
      recording.stop()
    }
  })

  test('transaction-bound warmed templates see current rows and preserve complete rollback', async () => {
    await seed(harness)
    const before = await harness.db.select().from(tasks).orderBy(tasks.id)
    const interruption = new Error('overview template rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        const owner = createTaskOverviewQuery(tx)
        await owner.load(inputs[0]!)
        await tx
          .update(tasks)
          .set({ status: 'done', finishedAt: since })
          .where(eq(tasks.id, 'a-running'))
        const recording = harness.recordStatements()
        try {
          for (const input of inputs.slice(0, 3)) await compare(tx, owner, recording, input)
          expect(await owner.load(inputs[0]!)).toEqual({
            running: 1,
            awaiting: 2,
            done7d: 3,
            failed7d: 1,
          })
        } finally {
          recording.stop()
        }
        throw interruption
      }),
    ).rejects.toBe(interruption)
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(before)
    expect(await createTaskOverviewQuery(harness.db).load(inputs[0]!)).toEqual({
      running: 2,
      awaiting: 2,
      done7d: 2,
      failed7d: 1,
    })
  })

  test('warmed templates reuse builders while all twelve real reads remain observable', async () => {
    await seed(harness)
    const owner = createTaskOverviewQuery(harness.db)
    await owner.load(inputs[0]!)
    await owner.load(inputs[1]!)
    const observations = [inputs[0]!, inputs[1]!, { ...inputs[2]!, since: since + 1 }]
    const original = await Promise.all(
      observations.map((input) => originalLoadOverview(harness.db, input)),
    )
    const recording = harness.recordStatements()
    const select = spyOn(harness.db, 'select')
    try {
      const current = await Promise.all(observations.map((input) => owner.load(input)))
      expect(current).toEqual(original)
      expect(recording.statements).toHaveLength(12)
      expect(recording.statements.every((row) => row.rows === 1)).toBe(true)
      expect(select).not.toHaveBeenCalled()
    } finally {
      select.mockRestore()
      recording.stop()
    }
  })
})
