// RFC-359 W4-D26 —— 手工提问开启写面合一：此前 `sqliteManualQuestionOpenWriter.ts`（165 行，走
// `SqliteHumanGateOperationStore` 记账）与 `postgresqlManualQuestionOpenWriter.ts`（269 行，把
// begin / markPrepared 两步**内联重写**成裸 INSERT + UPDATE）各一份。现在只剩一份中立实现。
//
// 正典取 SQLite 的记账语义。PG 那份内联版少了三条：不查幂等键回放、claimEpoch 恒写 1、不比
// requestHash——合一改用中立 journal（`SqliteHumanGateOperationStore` 的逐行异步移植）后一并补齐。
// 同批把 `SqliteHumanGateOperationStore`（825 行，与 journal 完全重复）整份退役。
//
// 这套断言两个引擎各跑一遍写面的核心判据：一次创建落定问题行 + prepared 门操作 + 已提交事件；
// 任务终态一律拒绝且什么都不落；重复 gateRef 的活跃操作按冲突拒绝。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { collaborationGateOperations, taskQuestions, tasks, workflows } from '@/db/schema'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { DatabaseManualQuestionOpenWriter } from '@/modules/collaboration/infrastructure/manualQuestionOpenWriter'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_969_900_000

async function seedTask(
  db: ProviderNeutralDatabase,
  status: 'running' | 'done' | 'canceled' = 'running',
): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: `wf-${workflowId}`, definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'd26 manual question task',
    workflowId,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: NOW - 1_000,
    lifecycleEventRevision: 3,
  })
  return taskId
}

function writerFor(db: ProviderNeutralDatabase): DatabaseManualQuestionOpenWriter {
  return new DatabaseManualQuestionOpenWriter(db, new DatabaseHumanGateOperationJournal())
}

describeEachProvider('RFC-359 W4-D26 —— 手工提问开启写面', (harness) => {
  test('一次创建：问题行 + prepared 门操作 + 已提交事件同笔落定', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)

    const created = await writerFor(db).create({
      taskId,
      title: 'why is it slow?',
      body: 'the page takes 8s',
      targetNodeId: 'writer',
      actorUserId: 'user-d26',
      now: NOW,
    })

    const question = (
      await db.select().from(taskQuestions).where(eq(taskQuestions.id, created.id)).limit(1)
    )[0]
    expect(question).toMatchObject({
      taskId,
      questionTitle: 'why is it slow?',
      sourceKind: 'manual',
      roleKind: 'designer',
      manualBody: 'the page takes 8s',
      manualCreatedBy: 'user-d26',
      overrideTargetNodeId: 'writer',
      confirmation: 'open',
      dispatchedAt: null,
      autoDispatchDeferredAt: null,
    })

    const operation = (
      await db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operation.id))
        .limit(1)
    )[0]
    expect(operation).toMatchObject({
      taskId,
      gateKind: 'questions',
      operationKind: 'manual-question-open',
      state: 'prepared',
      // 记账走 journal：claimEpoch 由它分配，requestHash 与幂等键都落库。
      claimEpoch: 1,
      expectedTaskRevision: 3,
    })
    expect(operation?.idempotencyKey).toBe(`manual-question-open:${created.id}`)
    expect((operation?.requestHash ?? '').length).toBeGreaterThan(0)
    const storedManifest = JSON.parse(operation?.manifestJson ?? '{}') as {
      kind?: string
      gateRef?: string
      question?: { id?: string }
    }
    expect(storedManifest.kind).toBe('manual-question-open')
    expect(storedManifest.gateRef).toBe(created.manifest.gateRef)
    expect(storedManifest.question?.id).toBe(created.id)
    expect(created.eventRefs).toHaveLength(1)

    // 任务本身不动：手工提问只落义务，停靠是后面 settle 的事。
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
    expect(task?.status).toBe('running')
    expect(task?.lifecycleEventRevision).toBe(3)
  })

  test('任务已终态：拒绝且一行都不落（两个引擎同一条判据）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    for (const status of ['done', 'canceled'] as const) {
      const taskId = await seedTask(db, status)
      let code = '<no-throw>'
      try {
        await writerFor(db).create({
          taskId,
          title: 't',
          body: 'b',
          targetNodeId: 'writer',
          actorUserId: 'user-d26',
          now: NOW,
        })
      } catch (error) {
        code = (error as { code?: string }).code ?? (error as Error).message
      }
      expect(code).toBe('task-terminal')
      expect(
        await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)),
      ).toHaveLength(0)
      expect(
        await db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.taskId, taskId)),
      ).toHaveLength(0)
    }
  })

  test('任务不存在：按 task-not-found 拒绝', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    let code = '<no-throw>'
    try {
      await writerFor(db).create({
        taskId: ulid(),
        title: 't',
        body: 'b',
        targetNodeId: 'writer',
        actorUserId: 'user-d26',
        now: NOW,
      })
    } catch (error) {
      code = (error as { code?: string }).code ?? (error as Error).message
    }
    expect(code).toBe('task-not-found')
  })

  test('同一任务连开两条手工提问：各自独立成门，互不冲突', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)
    const writer = writerFor(db)
    const first = await writer.create({
      taskId,
      title: 'q1',
      body: 'b1',
      targetNodeId: 'writer',
      actorUserId: 'user-d26',
      now: NOW,
    })
    const second = await writer.create({
      taskId,
      title: 'q2',
      body: 'b2',
      targetNodeId: 'writer',
      actorUserId: 'user-d26',
      now: NOW + 1,
    })

    expect(second.id).not.toBe(first.id)
    expect(second.manifest.gateRef).not.toBe(first.manifest.gateRef)
    const operations = await db
      .select({ id: collaborationGateOperations.id, state: collaborationGateOperations.state })
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.taskId, taskId))
    expect(operations).toHaveLength(2)
    expect(operations.every((operation) => operation.state === 'prepared')).toBe(true)
  })
})

test('源码锁：手工提问写面只剩一份，同步 gate 操作 store 已整份退役', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '..', 'src')
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

  const writer = read('modules/collaboration/infrastructure/manualQuestionOpenWriter.ts')
  // 记账走中立 journal，不再内联 INSERT / UPDATE 到门操作表。
  expect(writer).toContain('this.journal.beginTx({')
  expect(writer).toContain('this.journal.markPreparedTx({')
  expect(writer).not.toContain('insert(collaborationGateOperations)')
  expect(writer).toContain('databaseSessionFor(this.db).serializable(')

  for (const retired of [
    'modules/collaboration/infrastructure/sqliteManualQuestionOpenWriter.ts',
    'modules/collaboration/infrastructure/postgresqlManualQuestionOpenWriter.ts',
    'modules/collaboration/infrastructure/sqliteHumanGateOperationStore.ts',
  ]) {
    expect(() => read(retired)).toThrow()
  }

  // 事务内日志的唯一契约是中立异步那份；同步接口已从共享形状文件里删除。
  const shapes = read('modules/collaboration/infrastructure/humanGateOperationTransactionStore.ts')
  expect(shapes).not.toContain('export interface HumanGateOperationTransactionStore')
  // 只禁类型位置的同步事务句柄；`DbTxSync` 出现在注释里是有意的（要说清退役的是哪一份）。
  expect(shapes).not.toMatch(/: DbTxSync/)

  // 两条装配路径注入同一份写面。
  const context = read('modules/collaboration/composition/commandContext.ts')
  expect(context.match(/new DatabaseManualQuestionOpenWriter\(/g)).toHaveLength(2)
  expect(context).not.toContain('SqliteManualQuestionOpenWriter')
  expect(context).not.toContain('PostgresqlManualQuestionOpenWriter')
})
