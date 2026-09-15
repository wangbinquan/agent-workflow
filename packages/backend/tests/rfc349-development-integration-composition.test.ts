import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composeDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import { createDevelopmentAdapterStore } from '@/modules/integration/infrastructure/developmentAdapterStore'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(values: readonly (readonly unknown[])[] = []): SqlRows {
  const objects = [] as Array<Record<string, unknown>> & { count?: number }
  objects.count = 0
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return values
    },
  })
}

function fixture() {
  const statements: string[] = []
  const contentJson = JSON.stringify({
    schemaVersion: 1,
    purpose: 'pipeline-gate',
    operations: ['collect'],
    contractVersion: 1,
    executableRef: 'fixture-pipeline',
    parameterSchemaRef: null,
    connectionRef: null,
    secretProjection: [],
    outputBudget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
    timeoutMs: 10_000,
  })
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    if (sql.includes('development_adapter_definition_revisions')) {
      return rows([[contentJson, 'digest-1']])
    }
    if (sql.includes('development_adapter_definitions')) {
      return rows([
        ['adapter-1', 'CI gate', '{}', 1, 'owner-1', 'public', 0, 100, 100, null, 'pipeline-gate'],
      ])
    }
    throw new Error(`unexpected PostgreSQL development adapter query: ${sql}`)
  }
  const connection: PostgresqlReservedConnection = { unsafe: execute, release() {} }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_development_composition_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), statements }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 Development and Integration provider composition', () => {
  test('PostgreSQL revision and connection catalogs execute through the async provider', async () => {
    const fake = fixture()
    // RFC-359 W4-D6：修订读面归中立 store（两个 provider 同一份），这里只验它在 PG 客户端上按 async provider 执行。
    const revisions = createDevelopmentAdapterStore(fake.db)
    await expect(revisions.getRevision('adapter-1', 1)).resolves.toEqual({
      contentJson: expect.any(String),
      contentDigest: 'digest-1',
    })

    const catalog = composeDevelopmentToolConnectionCatalog(fake.db)
    await expect(catalog.resolve({ id: 'adapter-1', revision: 1 })).resolves.toMatchObject({
      ref: { id: 'adapter-1', revision: 1 },
      purpose: 'pipeline-gate',
      available: true,
      visible: true,
      contentDigest: 'digest-1',
    })
    expect(fake.statements.every((statement) => statement.includes('agent_workflow'))).toBe(true)
  })

  // RFC-359 AC-1（plan §5fu）—— 这条判据**反过来了**，因为它要防的事已经发生完了。
  //
  // 原judgement 是「每个 PostgreSQL 装配都得指名自己的适配器，不许只是别名 SQLite 那份」——
  // 它假设本 context 里**存在** PG 专属装配，只是怕它偷懒转交。经过 §5ft（工具连接目录合一，
  // 那是这里唯一真的按 provider 分叉过的一处）与 §5fu（14 对纯装配别名退役），
  // 本 context 里**一个 provider 专属装配都不剩了**：三个 runner 各只有一份中立入口。
  //
  // 原样留着就成了空转（`files` 为空，循环一次都不进），所以改成断言那个**更强的终态**：
  // 这几个装配文件里**不得再出现任何 provider 命名的导出**。谁将来在这里新开一个
  // `composePostgresqlXxx`，这条当场红——防的还是同一件事（provider 分叉悄悄回潮），
  // 但防在更前面一步，而且不再依赖「清单里记得加上新文件」。
  test('integration 装配面已无 provider 专属入口——谁新开一个品牌装配，这条当场红', () => {
    const files = [
      'modules/integration/composition/pipelineEvidence.ts',
      'modules/integration/composition/requirementSource.ts',
      'modules/integration/composition/approvalGateway.ts',
      'modules/integration/composition/digitalEmployeeToolConnections.ts',
    ]
    const branded = files.flatMap((file) => {
      const source = readFileSync(resolve(import.meta.dir, '..', 'src', file), 'utf8')
      return [
        ...source.matchAll(
          /export\s+(?:function|const)\s+((?:compose|create)(?:Sqlite|Postgresql)[A-Za-z0-9_]*)/g,
        ),
      ].map((match) => `${file} :: ${match[1] ?? ''}`)
    })

    expect(
      branded,
      'integration 装配面又出现了 provider 命名的导出。先按 plan §5fq 的三条判据问自己：' +
        '这个差异源于引擎本身吗（独有原语 / 独有资源形态 / 驱动强加的线上差异）？' +
        '指不出来就别分叉——一份中立装配吃 `ProviderNeutralDatabase` 即可。',
    ).toEqual([])
  })
})
