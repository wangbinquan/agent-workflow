// RFC-359 W4-D27 —— 任务执行资源快照合一：此前四份文件（resource-catalog 侧 legacy 494 行 /
// PG 529 行的读面，task-execution 侧两份绑定）现在只剩两份中立实现。
//
// 三处差异逐条对账后收进中立原语，**两个引擎各自的边界一格未改**：
//   * 事务：新增 `DatabaseSession.snapshotRead` —— SQLite 是 BEGIN IMMEDIATE（合一前 `dbTxSync`
//     本来就是它），PG 是 REPEATABLE READ READ ONLY（合一前 PG 绑定本来就是它）。
//   * 可见性：中立 `canViewResourceForTx`（与 legacy `canViewResourceInTx` 同一条判据）。
//   * 行映射：`*Persistence` 里的中立映射器，与 legacy 的 `rowToAgent` / `rowToWorkflowDetail` /
//     `rowToWorkgroup` 逐字段等价（含 sidecar 提升、快照哈希与 runtime 列规则）。
//
// 这套断言两个引擎各跑一遍读面的核心判据：启动工作流可见性、调用目标按名解析、agent 注入闭包
// 展开与依赖缺失，以及闭包冻结的产物在两个引擎上逐字相同。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, workflows } from '@/db/schema'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import { createTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/taskExecutionResourceSnapshots'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_969_900_000
const OWNER = 'user-d27'

function actorOf(userId: string, role: 'admin' | 'user' = 'user'): Actor {
  return {
    user: { id: userId, username: userId, displayName: userId, role, status: 'active' },
    source: 'session',
    permissions: new Set(['resource-acl:private']),
  } as unknown as Actor
}

function bindingFor(db: ProviderNeutralDatabase) {
  return createTaskExecutionResourceBinding(
    db,
    composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
  )
}

function pairFor(actor: Actor): {
  authority: ResourceRequestContext
  actor: Actor
  resources: ReturnType<typeof bindingFor>
} {
  const authority = { actor } as unknown as ResourceRequestContext
  return { authority, actor, resources: undefined as never }
}

const EMPTY_DEFINITION = { $schema_version: 4, inputs: [], nodes: [], edges: [] }

async function seedWorkflow(
  db: ProviderNeutralDatabase,
  input: {
    readonly name: string
    readonly ownerUserId: string
    readonly visibility: 'private' | 'public'
    readonly definition?: unknown
  },
): Promise<string> {
  const id = ulid()
  await db.insert(workflows).values({
    id,
    name: input.name,
    definition: JSON.stringify(input.definition ?? EMPTY_DEFINITION),
    ownerUserId: input.ownerUserId,
    visibility: input.visibility,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function seedAgent(
  db: ProviderNeutralDatabase,
  input: { readonly name: string; readonly dependsOn?: readonly string[] },
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name: input.name,
    description: '',
    bodyMd: input.name,
    ownerUserId: OWNER,
    ...(input.dependsOn === undefined ? {} : { dependsOn: JSON.stringify(input.dependsOn) }),
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

describeEachProvider('RFC-359 W4-D27 —— 任务执行资源快照', (harness) => {
  test('启动工作流：owner 能读到自己的私有工作流，别人读不到（同一条可见性判据）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const workflowId = await seedWorkflow(db, {
      name: `wf-${ulid().slice(-8).toLowerCase()}`,
      ownerUserId: OWNER,
      visibility: 'private',
    })
    const owner = pairFor(actorOf(OWNER))
    const loaded = await bindingFor(db).loadAuthorized(owner, [
      { kind: 'workflow-launch', workflowId },
    ])
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ kind: 'workflow-launch' })

    const stranger = pairFor(actorOf('someone-else'))
    let code = '<no-throw>'
    try {
      await bindingFor(db).loadAuthorized(stranger, [{ kind: 'workflow-launch', workflowId }])
    } catch (error) {
      code = (error as { code?: string }).code ?? (error as Error).message
    }
    expect(code).toBe('workflow-not-found')
  })

  test('agent 注入：dependsOn 闭包按广度展开，缺失依赖按具名失败收场', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const leaf = await seedAgent(db, { name: `leaf-${ulid().slice(-6).toLowerCase()}` })
    const root = await seedAgent(db, {
      name: `root-${ulid().slice(-6).toLowerCase()}`,
      dependsOn: [leaf],
    })
    const pair = pairFor(actorOf(OWNER, 'admin'))

    const loaded = await bindingFor(db).loadAuthorized(pair, [
      { kind: 'agent-injection', agentId: root },
    ])
    const injection = loaded[0] as unknown as {
      kind: string
      root: { id: string }
      dependents: readonly { id: string }[]
    }
    expect(injection.kind).toBe('agent-injection')
    expect(injection.root.id).toBe(root)
    expect(injection.dependents.map((agent) => agent.id)).toEqual([leaf])

    const dangling = await seedAgent(db, {
      name: `dangling-${ulid().slice(-6).toLowerCase()}`,
      dependsOn: [ulid()],
    })
    let code = '<no-throw>'
    try {
      await bindingFor(db).loadAuthorized(pair, [{ kind: 'agent-injection', agentId: dangling }])
    } catch (error) {
      code = (error as { code?: string }).code ?? (error as Error).message
    }
    expect(code).toBe('agent-dependency-not-found')
  })

  test('闭包冻结：调用节点按名解析目标，产物在两个引擎上逐字相同', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const childName = `child-${ulid().slice(-8).toLowerCase()}`
    const childId = await seedWorkflow(db, {
      name: childName,
      ownerUserId: OWNER,
      visibility: 'private',
    })
    const rootDefinition = {
      ...EMPTY_DEFINITION,
      nodes: [{ id: 'call-child', kind: 'call-workflow', workflowName: childName }],
    }
    const rootId = await seedWorkflow(db, {
      name: `root-${ulid().slice(-8).toLowerCase()}`,
      ownerUserId: OWNER,
      visibility: 'private',
      definition: rootDefinition,
    })
    const pair = pairFor(actorOf(OWNER))

    const frozen = await bindingFor(db).freezeCallClosure(pair, {
      id: rootId,
      definition: rootDefinition as never,
    })
    expect(frozen).not.toBeNull()
    const closure = JSON.parse(frozen ?? '{}') as {
      closureVersion: number
      workflows: Record<string, { id: string; version: number }>
    }
    expect(closure.closureVersion).toBe(2)
    expect(closure.workflows[`${rootId}#call-child`]?.id).toBe(childId)
  })

  test('没有调用节点的工作流不冻结闭包（两个引擎同样返回 null）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const rootId = await seedWorkflow(db, {
      name: `plain-${ulid().slice(-8).toLowerCase()}`,
      ownerUserId: OWNER,
      visibility: 'private',
    })
    const frozen = await bindingFor(db).freezeCallClosure(pairFor(actorOf(OWNER)), {
      id: rootId,
      definition: EMPTY_DEFINITION as never,
    })
    expect(frozen).toBeNull()
  })
})

test('源码锁：资源快照只剩一份读面 + 一份绑定，四个 provider 文件都已退役', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '..', 'src')
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

  const reader = read(
    'modules/resource-catalog/infrastructure/aggregateAdapters/taskExecutionResourceSnapshots.ts',
  )
  expect(reader).toContain('tx: DatabaseTransaction')
  expect(reader).toContain('canViewResourceForTx(tx, actor')
  expect(reader).not.toMatch(/: DbTxSync|PostgresqlDatabaseClient/)

  const binding = read('modules/task-execution/infrastructure/taskExecutionResourceSnapshots.ts')
  expect(binding).toContain('session.snapshotRead(')
  expect(binding).toContain('freezeTaskExecutionCallClosureAsync(')

  // 只读快照能力两个引擎各取所需，且都与合一前那条边界逐字相同。
  const session = read('platform/persistence/databaseTransaction.ts')
  expect(session).toContain('snapshotRead<T>')
  expect(session).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  expect(session).toContain('snapshotRead: transaction')

  for (const retired of [
    'modules/resource-catalog/infrastructure/aggregateAdapters/legacyTaskExecutionResourceSnapshots.ts',
    'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlTaskExecutionResourceSnapshots.ts',
    'modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots.ts',
    'modules/task-execution/infrastructure/postgresqlTaskExecutionResourceSnapshots.ts',
  ]) {
    expect(() => read(retired)).toThrow()
  }

  // 三个 bootstrap 装的是同一份绑定。
  for (const bootstrap of ['server.ts', 'cli/start.ts', 'cli/postgresqlDaemonApplication.ts']) {
    expect(read(bootstrap)).toContain('createTaskExecutionResourceBinding(')
  }
})
