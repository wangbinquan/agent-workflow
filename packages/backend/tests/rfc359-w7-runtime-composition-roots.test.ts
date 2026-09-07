// RFC-359 W7 —— digital-employee / resource-catalog 维护面 / task-execution 动作执行器的 provider
// 组合根：**真的构造 + 真的驱动**（口径同本批另外三个文件）。
//
// 这一批比前三批更靠近生产装配链：数字员工模块的启动屏障、资源包 apply 日志的收敛扫描、
// 数字员工动作执行器的结果读取。共同点是它们都曾只有装配点那行字，工厂一次没跑过。

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, users, workflows } from '@/db/schema'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { composePostgresqlDigitalEmployee } from '@/modules/digital-employee/composition'
import { employeeTypePackageDescriptorSchema } from '@/modules/digital-employee/domain/model'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import {
  composePostgresqlResourcePackageApplyMaintenance,
  composeSqliteResourcePackageApplyMaintenance,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { composePostgresqlAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composePostgresqlScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { createSqliteTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

function asSqlite(db: ProviderNeutralDatabase): DbClient {
  return db as unknown as DbClient
}

function asPostgresql(db: ProviderNeutralDatabase): PostgresqlDatabaseClient {
  return db as unknown as PostgresqlDatabaseClient
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const descriptor = employeeTypePackageDescriptorSchema.parse(
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
)

/** 契约参与者的最小可执行实现：装配 / 启动屏障要它在，但本文件不跑任何反应轮次。 */
const executionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('rfc359 w7 composition test does not execute a reaction')
  },
  async validateExecutor({ contractRef }) {
    return {
      schemaVersion: 1,
      contractRef,
      status: 'valid',
      checks: [{ code: 'rfc359-w7-contract', ok: true, detail: 'composition test contract' }],
    }
  },
  async validateAgentCandidates() {
    return []
  },
  validateEnvelope() {
    throw new Error('rfc359 w7 composition test does not settle a reaction')
  },
}

async function seedActor(db: ProviderNeutralDatabase): Promise<Actor> {
  const id = `u_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'admin',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
  })
  return {
    user: { id, username: id, displayName: id, role: 'admin', status: 'active' },
    source: 'http',
    permissions: new Set(['resource-acl:private']),
  } as unknown as Actor
}

async function seedTerminalTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId.slice(-6).toLowerCase()}`,
    definition: JSON.stringify({ $schema_version: 2, nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/srv/repos/x',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: T0,
    finishedAt: T0 + 10,
  })
}

describeEachProvider('RFC-359 W7 —— digital-employee 组合根', (harness) => {
  test('数字员工模块：启动屏障就绪后类型包可见，输入上传清扫是真事务', async () => {
    const appHome = tmpRoot('aw-rfc359-w7-de-')
    const module = composePostgresqlDigitalEmployee({
      db: asPostgresql(harness.db),
      appHome,
      typePackages: [developmentEmployeeTypePackage],
      executionContracts,
    })
    await module.maintenance.ready()
    // ready() 把类型包注册进真库：查询面必须看得见它。
    expect((await module.queries.listTypes()).map((item) => item.typeRef.typeId)).toContain(
      descriptor.typeRef.typeId,
    )
    // 空库上的过期上传清扫是一次真删除扫描，回 0 而不是抛错。
    expect(await module.inputUploads.sweepExpired()).toBe(0)
    // 员工清单同样落真库：还没建任何员工时是空表。
    expect(await module.queries.listEmployees()).toEqual([])
    // 第二次 ready() 幂等（同一个类型包 digest 不漂移）。
    await module.maintenance.ready()
    expect((await module.queries.listTypes()).length).toBeGreaterThan(0)
  })
})

describeEachProvider('RFC-359 W7 —— 资源包 apply 维护面组合根', (harness) => {
  test('两个 provider 的 apply 收敛扫描：空日志上是零收据，活跃 apply 面各自可读', async () => {
    const appHome = tmpRoot('aw-rfc359-w7-pkg-')
    const pluginsDir = join(appHome, 'plugins')
    const active: string[] = []
    const sqlite = composeSqliteResourcePackageApplyMaintenance({
      db: asSqlite(harness.db),
      appHome,
      pluginsDir,
      activitySource: { activeApplyIds: () => active },
      now: () => T0,
    })
    const postgresql = composePostgresqlResourcePackageApplyMaintenance({
      db: asPostgresql(harness.db),
      appHome,
      pluginsDir,
      now: () => T0,
    })

    // 日志表是空的：两个装配面各跑一次真扫描，都收敛到零。
    expect(await sqlite.command.converge({ activeApplyIds: [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(await postgresql.command.converge({ activeApplyIds: [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })

    // 活跃 apply 面：SQLite 装配从调用方给的源读，PostgreSQL 装配自带进程内登记簿。
    expect(sqlite.activity.activeApplyIds()).toEqual([])
    active.push('apply-1')
    expect(sqlite.activity.activeApplyIds()).toEqual(['apply-1'])
    expect(postgresql.activity.activeApplyIds()).toEqual([])
    const lease = postgresql.activityTracker.enter('apply-2')
    expect(postgresql.activity.activeApplyIds()).toEqual(['apply-2'])
    lease.leave()
    expect(postgresql.activity.activeApplyIds()).toEqual([])
  })
})

describeEachProvider('RFC-359 W7 —— 数字员工动作执行器组合根', (harness) => {
  test('agent / script 两个执行器：缺 executionRef 是 not-found，终态任务读出 exited 快照', async () => {
    const actor = await seedActor(harness.db)
    const persistence = createSqliteTaskExecutionPersistence(asSqlite(harness.db))
    // 启动内核在本用例里永远不会被调用（只驱动读路径）；调用它是缺陷，所以直接抛。
    const launch = {
      launch: () => {
        throw new Error('rfc359 w7 read-path test must not launch a host task')
      },
    } as unknown as Parameters<typeof composePostgresqlAgentActionExecution>[0]['launch']
    const dependencies = {
      db: asPostgresql(harness.db),
      actor,
      resourceAuthorityFor: () => {
        throw new Error('rfc359 w7 read-path test must not resolve a launch authority')
      },
      launch,
      cancelTask: async () => undefined,
      readModels: {
        executionOutcome: persistence.reads.executionOutcome,
        statusProjection: persistence.reads.statusProjection,
      },
      agents: { get: async () => null },
    } as unknown as Parameters<typeof composePostgresqlAgentActionExecution>[0]

    const agentRunner = composePostgresqlAgentActionExecution(dependencies)
    const scriptRunner = composePostgresqlScriptActionExecution(dependencies)

    const missing = `t_${ulid()}`
    expect(await agentRunner.fetchOutcome(missing)).toEqual({
      kind: 'not-found',
      executionRef: missing,
    })
    expect(await scriptRunner.fetchOutcome(missing)).toEqual({
      kind: 'not-found',
      executionRef: missing,
    })
    expect(await agentRunner.cancel(missing)).toEqual({ settled: 'not-found' })

    // 终态任务：状态投影读出 done，结果读模型给出空产物而不是抛错。
    const taskId = `t_${ulid()}`
    await seedTerminalTask(harness.db, taskId)
    expect(await scriptRunner.fetchOutcome(taskId)).toMatchObject({
      kind: 'exited',
      executionRef: taskId,
      taskStatus: 'done',
    })
    expect(await agentRunner.cancel(taskId)).toEqual({ settled: 'already-terminal' })
  })
})
