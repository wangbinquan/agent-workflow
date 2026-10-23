// RFC-395 II-a A7：原人工门 CAS、输出更新和 directive 操作继续参加调用方事务。
import { beforeEach, expect, test } from 'bun:test'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createTaskClarifyDirectivePersistence,
  createHumanGatePersistenceParticipantInTx,
} from '@/modules/task-execution/public/participants'
import { listNodeEventContents } from '@/modules/task-execution/public/queries'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  workflowFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  readTaskFixtures,
  readNodeRunFixtures,
  readNodeRunOutputFixtures,
} from './helpers/model'

// 断言从 A1 独立 fixture projection 读回，而非使用被测 query 作为写入 oracle。
describeEachProvider('RFC-395 II-a A7 caller transaction participants', (harness) => {
  beforeEach(async () => {
    const { users } = tablesOf(harness.db)
    await harness.db.insert(users).values(
      ['old', 'new'].map((id) => ({
        id,
        username: id,
        displayName: id,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    await workflowFixture(harness.db, { id: 'workflow', name: 'Workflow', definition: '{}' })
    await taskFixture(harness.db, {
      id: 'task',
      workflowId: 'workflow',
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/work',
      baseBranch: 'main',
      branch: 'task',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      ownerUserId: 'old',
    })
    await nodeRunFixture(harness.db, [
      { id: 'human', taskId: 'task', nodeId: 'human', status: 'awaiting_human' },
      { id: 'review', taskId: 'task', nodeId: 'review', status: 'awaiting_review' },
      { id: 'running', taskId: 'task', nodeId: 'running', status: 'running' },
      {
        id: 'canceled',
        taskId: 'task',
        nodeId: 'canceled',
        status: 'canceled',
        finishedAt: 1,
        errorMessage: 'old',
      },
    ])
  })
  test('clarify completion only changes awaiting_human and preserves a CAS miss', async () => {
    const before = (await readNodeRunFixtures(harness.db, { id: 'running' }))[0]!
    await harness.session.transaction(async (tx) => {
      const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
      await taskHumanGate.lockTask('task')
      await taskHumanGate.completeClarifyRun('human', 10)
      await taskHumanGate.completeClarifyRun('running', 10)
      await taskHumanGate.completeClarifyRun('missing', 10)
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'human' }))[0]).toMatchObject({
      status: 'done',
      finishedAt: 10,
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'running' }))[0]).toEqual(before)
  })
  test('cancel preserves already-canceled finish time while refreshing its error, and skips other states', async () => {
    await harness.session.transaction(async (tx) => {
      const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
      expect(
        await taskHumanGate.cancelClarifyRun({ runId: 'human', now: 10, cause: 'closed' }),
      ).toBe(true)
      expect(
        await taskHumanGate.cancelClarifyRun({ runId: 'canceled', now: 10, cause: 'closed' }),
      ).toBe(false)
      expect(
        await taskHumanGate.cancelClarifyRun({ runId: 'running', now: 10, cause: 'closed' }),
      ).toBe(false)
      expect(
        await taskHumanGate.cancelClarifyRun({ runId: 'missing', now: 10, cause: 'closed' }),
      ).toBe(false)
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'human' }))[0]).toMatchObject({
      status: 'canceled',
      finishedAt: 10,
      errorMessage: 'closed',
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'canceled' }))[0]).toMatchObject({
      status: 'canceled',
      finishedAt: 1,
      errorMessage: 'closed',
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'running' }))[0]).toMatchObject({
      status: 'running',
      errorMessage: null,
    })
  })
  test('task sweep returns human gates before review gates, is idempotent, and leaves running nodes intact', async () => {
    await harness.session.transaction(async (tx) => {
      const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
      expect(
        await taskHumanGate.cancelTaskGateRuns({ taskId: 'task', now: 11, cause: 'terminal' }),
      ).toEqual([
        { nodeRunId: 'human', nodeId: 'human' },
        { nodeRunId: 'review', nodeId: 'review' },
      ])
      expect(
        await taskHumanGate.cancelTaskGateRuns({ taskId: 'task', now: 12, cause: 'terminal' }),
      ).toEqual([])
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'review' }))[0]).toMatchObject({
      status: 'canceled',
      finishedAt: 11,
      errorMessage: 'terminal',
    })
    expect((await readNodeRunFixtures(harness.db, { id: 'running' }))[0]?.status).toBe('running')
  })
  test('output upsert retains inactive flags and omitted archive/kind, while explicit null clears them', async () => {
    await nodeRunOutputFixture(harness.db, {
      nodeRunId: 'review',
      portName: 'out',
      content: 'old',
      active: false,
      kind: 'file',
      archiveJson: ' { "x": 1 } ',
    })
    await harness.session.transaction(async (tx) => {
      const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
      await taskHumanGate.writeReviewOutput({
        nodeRunId: 'review',
        portName: 'out',
        content: 'new',
      })
      expect(
        (await readNodeRunOutputFixtures(tx, { nodeRunId: 'review', portName: 'out' }))[0],
      ).toMatchObject({ content: 'new', active: false, kind: 'file', archiveJson: ' { "x": 1 } ' })
      await taskHumanGate.writeReviewOutput({
        nodeRunId: 'review',
        portName: 'out',
        content: 'clear',
        kind: null,
        archiveJson: null,
      })
      await taskHumanGate.writeReviewOutput({
        nodeRunId: 'review',
        portName: 'inserted',
        content: 'inserted',
      })
    })
    expect(
      (await readNodeRunOutputFixtures(harness.db, { nodeRunId: 'review', portName: 'out' }))[0],
    ).toMatchObject({ content: 'clear', active: false, kind: null, archiveJson: null })
    expect(
      (
        await readNodeRunOutputFixtures(harness.db, { nodeRunId: 'review', portName: 'inserted' })
      )[0],
    ).toMatchObject({ content: 'inserted', active: true, kind: null, archiveJson: null })
  })
  test('owner, event, gate and output writes roll back together after a downstream failure', async () => {
    const before = (await readNodeRunFixtures(harness.db, { id: 'human' }))[0]!
    const rollback = new Error('caller-failed')
    await expect(
      harness.session.transaction(async (tx) => {
        const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
        await taskHumanGate.lockTask('task')
        await taskHumanGate.transferTaskOwner('task', 'new')
        await taskHumanGate.completeClarifyRun('human', 10)
        await taskHumanGate.writeReviewOutput({
          nodeRunId: 'human',
          portName: 'answer',
          content: 'answer',
        })
        await taskHumanGate.appendTextEvent({ nodeRunId: 'human', ts: 10, payload: 'opened' })
        expect((await readTaskFixtures(tx, { id: 'task' }))[0]?.ownerUserId).toBe('new')
        expect(await listNodeEventContents(tx, ['human'])).toMatchObject([
          { payload: 'opened', kind: 'text', ts: 10 },
        ])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect((await readTaskFixtures(harness.db, { id: 'task' }))[0]?.ownerUserId).toBe('old')
    expect((await readNodeRunFixtures(harness.db, { id: 'human' }))[0]).toEqual(before)
    expect(await readNodeRunOutputFixtures(harness.db, { nodeRunId: 'human' })).toEqual([])
    expect(await listNodeEventContents(harness.db, ['human'])).toEqual([])
    await harness.session.transaction(async (tx) => {
      const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
      await taskHumanGate.transferTaskOwner('task', 'new')
      await taskHumanGate.appendTextEvent({ nodeRunId: 'human', ts: 11, payload: 'committed' })
    })
    expect((await readTaskFixtures(harness.db, { id: 'task' }))[0]?.ownerUserId).toBe('new')
    expect(await listNodeEventContents(harness.db, ['human'])).toMatchObject([
      { payload: 'committed' },
    ])
  })
  test('directive shard precedence, node continue cleanup and rollback keep their original semantics', async () => {
    const db = harness.db
    const directives = createTaskClarifyDirectivePersistence(db)
    expect(await directives.get('task', 'ask')).toBeUndefined()
    expect(await directives.getRow('missing', 'ask')).toBeUndefined()
    await directives.set('task', 'ask', 'stop', 'old', null, 1)
    await harness.session.transaction(async (tx) => {
      const transactionDirectives = createTaskClarifyDirectivePersistence(tx)
      await transactionDirectives.setInTx('task', 'ask', 'continue', 'old', 'member-a', 2)
      await transactionDirectives.setInTx('task', 'ask', 'stop', 'old', 'member-b', 3)
    })
    expect(await directives.get('task', 'ask', 'missing')).toBe('stop')
    expect(await directives.getRow('task', 'ask', 'member-a')).toEqual({
      directive: 'continue',
      updatedAt: 2,
    })
    expect(await directives.list('task')).toEqual({ ask: 'stop' })
    expect(await directives.listWorkgroupStops('task')).toEqual([
      { nodeId: 'ask', shardKey: 'member-b', directive: 'stop' },
    ])
    const rollback = new Error('directive-rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        const transactionDirectives = createTaskClarifyDirectivePersistence(tx)
        await transactionDirectives.setInTx('task', 'ask', 'continue', 'new', null, 4)
        expect(await transactionDirectives.listWorkgroupStops('task')).toEqual([])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(await directives.listWorkgroupStops('task')).toHaveLength(1)
    await directives.set('task', 'ask', 'continue', 'new', null, 5)
    expect(await directives.list('task')).toEqual({ ask: 'continue' })
    expect(await directives.getRow('task', 'ask', 'member-b')).toEqual({
      directive: 'continue',
      updatedAt: 5,
    })
    expect(await directives.listWorkgroupStops('task')).toEqual([])
  })
})
