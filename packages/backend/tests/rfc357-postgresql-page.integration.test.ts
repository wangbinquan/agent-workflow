// RFC-357 —— 共享场景在**真 PostgreSQL** 上的那一遍。
//
// 为什么这条测试存在：本 RFC 让两个 provider 共用**同一份** SQL。可移植性的前提清单由
// `rfc357-provider-portability.test.ts` 在普通跑批里钉住，但那一层只看源码形状——
// `docs/dev-gotchas.md` 记得很清楚：「SQL 长得一样」证明不了「两个 provider 行为一样」，
// RFC-349 正是靠假 pool 过了全部门禁、接上真库才暴出六个只在 PostgreSQL 上成立的缺陷。
// 这个文件是那道执行级证据：真建 schema、真插行、真跑页查询，断言**返回的值**——
// 而且断言函数与 SQLite 那一遍是同一个（`expectRfc357PageScenario`）。
//
// 普通 backend 跑批跳过本文件（无 `RFC357_DATABASE_URL` 即 skip）；CI 的
// `test-backend-postgresql` lane 起一台 postgres 服务容器后跑它。

import { describe, test } from 'bun:test'

import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { createDatabaseTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlTestDatabase } from './helpers/testDatabase'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'

import { expectRfc357PageScenario } from './helpers/rfc357PageScenario'
import { seedRfc357Page } from './helpers/rfc357PageSeed'

const URL_ENV = 'RFC357_DATABASE_URL'
const realTest = process.env[URL_ENV] === undefined ? test.skip : test
const GENERATION_ID = 'dbg_rfc357_page_01'

describe('RFC-357 shared page scenario — real PostgreSQL', () => {
  realTest(
    'the whole scenario holds, byte for byte the same expectations as SQLite',
    async () => {
      const runtime = createPostgresqlDatabaseRuntime({
        config: {
          provider: 'postgresql',
          urlEnv: URL_ENV,
          poolMax: 4,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
        generationId: GENERATION_ID,
      })
      try {
        const pool = runtime.providerPool()
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        await createPostgresqlTestDatabase(runtime)

        // 进程级 provider 选择必须还原：一个 bun 进程会跑多个测试文件，
        // 留着 postgresql 投影会渗进后面的文件（跨文件污染在本仓有前科）。
        const db = createPostgresqlDatabaseClient(runtime)
        await seedRfc357Page(db)
        await expectRfc357PageScenario(
          createDatabaseTaskListPage(db, composeOwnerIdentityQueries(db)),
        )
      } finally {
        await runtime.close?.()
      }
    },
    600_000,
  )
})
