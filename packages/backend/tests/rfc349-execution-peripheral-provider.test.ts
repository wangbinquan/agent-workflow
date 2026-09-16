// RFC-349 — execution-peripheral services consume closed provider operations;
// only infrastructure adapters may own database mechanics.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { buildActor } from '@/auth/actor'
import { workflows } from '@/db/schema'
import { composeAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { composeDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'

import { describeEachProvider } from './helpers/eachProvider'

describe('RFC-349 execution-peripheral provider boundary', () => {
  test('keeps database mechanisms out of peripheral orchestration services', () => {
    const services = [
      'agentLaunch.ts',
      'codeReviewAgentCaller.ts',
      'commitPushRunner.ts',
      'dynamicWorkflowRunner.ts',
    ]

    // RFC-353 T5：`fusion.ts` 已迁出 `services/`，成为
    // `modules/knowledge-evolution/application/fusionOrchestration.ts`。它不再是
    // 「外围编排服务」，但这条不变式（编排里不许有数据库机制）对它同样成立且更强
    // ——application 层本来就不该碰 DbClient / drizzle。所以**保留断言、只换落点**，
    // 而不是把它从清单里删掉：删掉等于在搬家的同时悄悄少了一条守卫。
    const modules = ['../src/modules/knowledge-evolution/application/fusionOrchestration.ts']

    for (const service of [...services.map((s) => `../src/services/${s}`), ...modules]) {
      const source = readFileSync(resolve(import.meta.dir, service), 'utf8')
      expect(source, service).not.toMatch(/from ['"](?:@\/db\/|drizzle-orm)/)
      expect(source, service).not.toMatch(/\b(?:DbClient|PostgresqlDatabaseClient)\b/)
      expect(source, service).not.toMatch(/\bdb\.(?:select|insert|update|delete|transaction)\b/)
    }

    // RFC-359 W4-D27：行映射器不再经策略束注入——判据搬到取用它们的那份中立适配器上，
    // 立场不变：读的是 `*Persistence` 的纯映射器，不是 `@/services/mcp` / `@/services/plugin` 门面。
    const snapshots = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/resource-catalog/infrastructure/aggregateAdapters/taskExecutionResourceSnapshots.ts',
      ),
      'utf8',
    )
    expect(snapshots).toContain('../mcpPersistence')
    expect(snapshots).toContain('../pluginPersistence')
    expect(snapshots).not.toMatch(/@\/services\/(?:mcp|plugin)['"]/)
    // 策略束里只剩 legacy 行为神谕（`legacyTaskExecutionInjectionResolver`）还要的三个行映射器；
    // 快照适配器与可见性判据都不再经这里注入。
    const dependencies = readFileSync(
      resolve(import.meta.dir, '../src/services/execution/taskExecutionResourceDependencies.ts'),
      'utf8',
    )
    expect(dependencies).not.toMatch(/rowTo(?:WorkflowDetail|Workgroup)\b/)
    expect(dependencies).not.toContain('canViewResourceInTx')
    expect(dependencies).toContain('infrastructure/mcpPersistence')
    expect(dependencies).toContain('infrastructure/pluginPersistence')
  })
})

// RFC-359 AC-6（plan §5gn）—— 这两格原来是**一真一假**：SQLite 那格用真库、读回行断言内容与幂等；
// PostgreSQL 那格用本地手搓的 `postgresqlFixture()`（记 SQL 文本、回罐头行的假池），
// 唯一的断言是「某条 SQL 里出现过 `"agent_workflow"."workflows"`」——它证明不了行真的写进去了、
// 更证明不了写两次是幂等的。这正是本 RFC 要根除的「一个好一个不好」。
//
// 两个 composer 的 `db` 形参本来就是 `ProviderNeutralDatabase`，所以合一**零生产改动**：
// 两个引擎各跑一遍同一组断言（真库、读回行、幂等、外部依赖注入）。
// 丢掉的只有那条 SQL 文本断言——净赚：真 PG 上跑通是对「投影带 schema 限定名」强得多的证明
// （写错当场报错，而假池照单全收）。同 §5gd 对 `rfc349-websocket-provider` 的处置。
describeEachProvider('RFC-349 execution-peripheral adapters（双引擎真库）', (harness) => {
  test('agent-launch 与 dynamic-workflow 适配器在真库上读写、且 ensureHostWorkflow 幂等', async () => {
    const db = harness.db
    const visibleRequests: Array<{ readonly actorId: string; readonly agentId: string }> = []
    const actor = buildActor({
      user: {
        id: 'owner-1',
        username: 'owner',
        displayName: 'Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const agentLaunch = composeAgentLaunchResourceOperations({
      db,
      agents: {
        async get(authority, agentId) {
          visibleRequests.push({ actorId: authority.user.id, agentId })
          return null
        },
      },
      workflowValidation: {
        async validate() {
          return { ok: true, issues: [] }
        },
      },
    })
    const dynamicWorkflow = composeDynamicWorkflowPersistence(db)

    // 调两次：第二次不得重复插入，也不得抛。
    await agentLaunch.ensureHostWorkflow()
    await agentLaunch.ensureHostWorkflow()

    const hosts = await db
      .select({ id: workflows.id, name: workflows.name, builtin: workflows.builtin })
      .from(workflows)
      .where(eq(workflows.id, '00000000000000AGENTHOST00'))
    expect(hosts).toEqual([
      { id: '00000000000000AGENTHOST00', name: '__agent_host__', builtin: true },
    ])

    await expect(agentLaunch.loadVisibleAgent(actor, 'agent-1')).resolves.toBeNull()
    expect(visibleRequests).toEqual([{ actorId: 'owner-1', agentId: 'agent-1' }])
    await expect(
      agentLaunch.validateHostWorkflow({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    ).resolves.toEqual({ ok: true, issues: [] })

    await expect(dynamicWorkflow.loadTask('missing-task')).resolves.toBeNull()
    expect(await dynamicWorkflow.countNodeRuns('missing-task', 'missing-node')).toBe(0)
  })
})
