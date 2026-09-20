import { createExecutionContractProgramFixtureAdapter } from '@/modules/task-execution/composition/executionContractFixture'
// RFC-359 AC-1 —— 执行合同资源读取**只有一份实现**，两个引擎跑同一组判据。
//
// 为什么这个文件存在（plan §5fp）：这里原来是一对孪生适配器——中立那份走
// `getAgentById` / `getWorkflow`（整行 select + 整行解码），PostgreSQL 那份自己窄投影
// 4 / 3 列再就地 `JSON.parse`。同一行数据经两条路得到**两种结果**，在一个真 PostgreSQL
// 库上实测出两处：
//
//   A. sidecar 泄漏：交给 `implicitAgentDeclarations` 的 `frontmatterExtra`，
//      中立那份是 `["digitalEmployeeTemplate"]`、PostgreSQL 那份是
//      `["digitalEmployeeTemplate","role"]`。
//   B. 坏 definition 的错误型别：中立那份抛
//      `ValidationError('workflow-definition-corrupt')`，PostgreSQL 那份抛裸 `SyntaxError`
//      ——**用户看到的错误码取决于你用哪种数据库**。
//
// 下面 A / B 两条用例就是当时的红，现在两个引擎上都必须是同一个答案。合一后只剩
// `createExecutionContractResourceAdapter(db: ProviderNeutralDatabase)` 一个入口，
// 旧的 `createPostgresqlExecutionContractResourceAdapter` 已删除。

import { describe, expect, test } from 'bun:test'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb } from '@/db/client'
import { agents, workflows } from '@/db/schema'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { createExecutionContractResourceAdapter } from '@/modules/resource-catalog/composition/executionContractResource'
import { composeSqliteAppDeps, createApp } from '@/server'
import { resolve } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

const CONTRACT_WORKFLOW_DEFINITION = {
  $schema_version: 2,
  inputs: [{ key: 'prompt', label: 'Prompt', kind: 'text', required: true }],
  // RFC-354 (schema v6): an output port is an inbound edge, so the result
  // port has to be wired from a producer.
  nodes: [
    { id: 'impl', kind: 'agent-single', agentId: 'agent-1', agentName: 'Implementer' },
    { id: 'result', kind: 'output' },
  ],
  edges: [
    {
      id: 'e_result',
      source: { nodeId: 'impl', portName: 'result' },
      target: { nodeId: 'result', portName: 'contract-result' },
    },
  ],
}

describeEachProvider('RFC-359 执行合同资源读取（双引擎，单一实现）', (h) => {
  async function seedAgent(frontmatterExtra: Record<string, unknown>): Promise<{
    readonly id: string
    readonly revision: number
  }> {
    const id = ulid()
    await h.db.insert(agents).values({
      id,
      name: 'Implementer',
      description: 'seeded by rfc359-execution-contract-resource-adapter',
      outputs: JSON.stringify(['contract-result']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: JSON.stringify(frontmatterExtra),
      bodyMd: '',
    })
    const rows = await h.db
      .select({ updatedAt: agents.updatedAt })
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)
    return { id, revision: rows[0]!.updatedAt }
  }

  async function seedWorkflow(definition: string, version = 4): Promise<string> {
    const id = ulid()
    await h.db
      .insert(workflows)
      .values({ id, name: 'Contract workflow', description: 'w', definition, version })
    return id
  }

  test('按精确 revision 投影 agent，并交出它声明的合同引用', async () => {
    const { id, revision } = await seedAgent({
      executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
    })

    await expect(
      createExecutionContractResourceAdapter(h.db).inspect({
        implementation: { kind: 'agent', agentRef: { id, revision } },
        expectedOutputPort: 'contract-result',
      }),
    ).resolves.toMatchObject({
      kind: 'agent',
      name: 'Implementer',
      available: true,
      declaredContractRefs: [{ contractId: 'development.analyze-implement', version: 1 }],
    })
  })

  test('revision 过期一律拒掉，不放宽它的声明', async () => {
    const { id, revision } = await seedAgent({ executionContracts: [] })

    await expect(
      createExecutionContractResourceAdapter(h.db).inspect({
        implementation: { kind: 'agent', agentRef: { id, revision: revision - 1 } },
        expectedOutputPort: 'contract-result',
      }),
    ).resolves.toBeNull()
  })

  test('工作流闭合判据作用在存库的 definition 上', async () => {
    const id = await seedWorkflow(JSON.stringify(CONTRACT_WORKFLOW_DEFINITION))

    await expect(
      createExecutionContractResourceAdapter(h.db).inspect({
        implementation: { kind: 'workflow', workflowRef: { id, revision: 4 } },
        expectedOutputPort: 'contract-result',
      }),
    ).resolves.toMatchObject({
      kind: 'workflow',
      name: 'Contract workflow',
      available: true,
      detail: 'Contract workflow; closed contract workflow; 2 node(s)',
    })
  })

  // ── 合一前的两处真红（plan §5fp）───────────────────────────────────────────
  test('A：sidecar 键不得随 frontmatterExtra 漏给隐式声明（合一前 PostgreSQL 那份会漏 role）', async () => {
    const { id, revision } = await seedAgent({ role: 'aggregator', digitalEmployeeTemplate: 'x' })
    const seen: string[][] = []

    await createExecutionContractResourceAdapter(h.db, (input) => {
      seen.push(Object.keys(input.frontmatterExtra).sort())
      return []
    }).inspect({
      implementation: { kind: 'agent', agentRef: { id, revision } },
      expectedOutputPort: 'contract-result',
    })

    // `role` 已被本层提升成 `Agent` 的一等字段，不再算 extra；
    // `digitalEmployeeTemplate` 不是 sidecar，照常留下（它正是隐式声明读的那个键）。
    expect(seen).toEqual([['digitalEmployeeTemplate']])
  })

  test('B：坏掉的 definition 抛结构化的 workflow-definition-corrupt（合一前 PostgreSQL 那份抛裸 SyntaxError）', async () => {
    const id = await seedWorkflow('{not json at all')

    const error = await createExecutionContractResourceAdapter(h.db)
      .inspect({
        implementation: { kind: 'workflow', workflowRef: { id, revision: 4 } },
        expectedOutputPort: 'contract-result',
      })
      .then(
        () => null,
        (thrown: unknown) => thrown as { name?: string; code?: string },
      )

    expect(error?.name).toBe('ValidationError')
    expect(error?.code).toBe('workflow-definition-corrupt')
  })

  test('两次读都是窄投影：只取端口要的那几列，不整行搬回来', async () => {
    const { id, revision } = await seedAgent({ executionContracts: [] })
    const workflowId = await seedWorkflow(JSON.stringify(CONTRACT_WORKFLOW_DEFINITION))
    const adapter = createExecutionContractResourceAdapter(h.db)

    const recording = h.recordStatements()
    try {
      await adapter.inspect({
        implementation: { kind: 'agent', agentRef: { id, revision } },
        expectedOutputPort: 'contract-result',
      })
      await adapter.inspect({
        implementation: { kind: 'workflow', workflowRef: { id: workflowId, revision: 4 } },
        expectedOutputPort: 'contract-result',
      })
    } finally {
      recording.stop()
    }

    const selects = recording.selects()
    expect(selects).toHaveLength(2)
    // 窄投影的可断言面：整行 select 会把这些列一起搬回来，窄投影不会。
    // （这条替代了合一前那组「发出的 SQL 含 `"agent_workflow"."agents"`」字符串断言——
    //  跑在真库上本来就证明了 schema 限定名对，写错当场报错。）
    for (const forbidden of ['body_md', 'permission', 'depends_on', 'schema_version']) {
      expect(selects.map((statement) => statement.sql).join('\n')).not.toContain(forbidden)
    }
    expect(selects[0]?.rows).toBe(1)
    expect(selects[1]?.rows).toBe(1)
  })
})

// RFC-359 AC-6：本块被测的就是 **SQLite 那个组合根**（`AppDeps` 收 `DbClient`，
// `createApp` 的单参重载内部正是 `composeSqliteAppDeps`），PostgreSQL 侧的同一件事由
// `rfc359-w7-*-composition-roots` 各自那批覆盖。下面把那一步**显式写出来**而不是靠重载隐含，
// 这样「被测物是某一侧的装配面」在源码上说得出口，也才落得进 `provider-composition-root`
// 那一类机械理由（见 `rfc359-w5-t19f-test-engine-hardcoding`）。
describe('RFC-359 执行合同装配（SQLite 组合根）', () => {
  test('HTTP bootstrap 保留注入进来的 provider-中立组合根', async () => {
    const executionContracts = composeExecutionContract({
      registrations: [],
      resources: {
        async inspect() {
          return null
        },
      },
      programFixtures: createExecutionContractProgramFixtureAdapter({
        appHome: '/not-used-by-this-query',
      }),
    })
    const app = createApp(
      composeSqliteAppDeps({
        secretBox: createSecretBoxFromKey(Buffer.alloc(32, 7)),
        token: DAEMON_TOKEN,
        configPath: '',
        opencodeVersion: null,
        dbVersion: 1,
        db: createInMemoryDb(MIGRATIONS),
        executionContracts,
      }),
    )

    const response = await app.request('/api/execution-contracts', {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
  })

  test('装配接受 provider-中立的资源端口，不需要 SQLite 客户端', () => {
    const module = composeExecutionContract({
      registrations: [],
      resources: {
        async inspect() {
          return null
        },
      },
      programFixtures: createExecutionContractProgramFixtureAdapter({
        appHome: '/not-used-by-this-query',
      }),
    })

    expect(module.list()).toEqual([])
  })
})
