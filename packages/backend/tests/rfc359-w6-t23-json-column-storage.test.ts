// RFC-359 W6-T23 —— 为什么 `json-text` 列在 PostgreSQL 上**不能**渲染成 JSONB。
//
// # 结论先写：T23 原方案（JSON 列投影成 JSONB + 热查询列建 GIN）在本仓不成立
//
// 计划里 T23 写的是「DDL 投影：JSON 列在 PG 上渲染为 JSONB；热查询列建 GIN」。
// 性能上它确实最优——同一段取值，真库实测（PostgreSQL 17.11，5 万行）：
//
//   plpgsql shim 296.6ms  →  text 列上的原生 `->>` 91.3ms（3.2×）  →  真 jsonb 列 14.6ms（20×）
//
// **但 20× 那一档买不起**：`jsonb` 不是一种「存同样的字节、只是查得快」的类型，它是一种
// **规范化存储**——存进去的字节和读出来的字节不再相同（键重排、空白规整、数字重写）：
//
//   '{"b":1,"a":2, "n":1.0,"e":1e3}'  ──jsonb──▶  '{"a": 2, "b": 1, "e": 1000, "n": 1.0}'
//
// 而本仓有三类**活着的**判据建立在「写进去什么、读出来就是什么」上，这个文件逐条把它们
// 变成可执行的证据：
//
//   ① **逻辑复制的块摘要**：SQLite→PostgreSQL 迁移写完一块之后会**从 PG 回读**、重新
//      `encodeLogicalRow` 并比对 digest（`postgresqlLogicalTarget.ts` 的 `assertTargetChunk`）。
//      存储层一旦规范化，回读的字节就与源不同，digest 当场不匹配 ⇒ 整条迁移在
//      `postgresql-target-chunk-mismatch` 上停住。下面第②条用真实的块摘要函数演示这一点。
//   ② **`json-text` 列里合法地存着不是 JSON 的东西**：`webhook_deliveries.body_json` 存的是
//      **原始 HTTP 请求体**，且被 `truncateDeliveryBody` 按 256 KiB **裸截断**——截断后的
//      JSON 当然不合法。jsonb 列根本存不下这种行（不是慢，是插不进去）。
//   ③ **应用层对 JSON 列原文做 hash / 相等比较**：全仓 21 处（`slot_path_digest` 直接对
//      `intent.slot_path_json` 原文取 sha256、`committed_events` 的 payload digest 回读重算、
//      `plugins`/`custom_event_source_definitions` 的整行乐观并发把 JSON 列放进 `eq(...)`、
//      skill 的 `frontmatterExtra` 决定磁盘上 SKILL.md 的字节进而决定 contentVersion……）。
//
// # 那 GIN 呢
//
// GIN 只服务 `@>` / `?` 这类**包含**算子，而包含算子需要 jsonb 列。列不能是 jsonb ⇒ GIN 无从建起。
// 顺带把「有没有人要用包含」也查清楚了：全仓确有 14 处包含形状的过滤（`agents.mcp` /
// `agents.plugins` / `agents.depends_on` 的 `LIKE '%"<id>"%'` 预过滤 + JS 复核，
// `scheduled_tasks.launch_payload` / `workflows.definition` 的「全表捞回来再在 JS 里按字段过滤」），
// **但它们全部打在资源目录这类小表上**（agents / plugins / workflows / scheduled_tasks 都是
// 几十到几百行的量级），O(n) 的 JS 过滤在那个规模上量不出代价。所以本刀**没有**给矩阵加
// `jsonContains`：矩阵是 exact 闭集，加一条没有可测收益、也没有索引可用的算子，只是给
// 每个引擎各多一份要维护的方言。这条判断连同上面的普查一起留档，等存储契约真的松动时再取用。
//
// # 这个文件锁什么
//
//  ①【契约】每个 `json-text` 列在 PostgreSQL 上的物理类型必须是**保字节**的（今天是 `text`）。
//  ②【摘要】JSON 文本一旦被规范化，逻辑复制的块摘要就变——用真的 `createLogicalTableChunk` 演示。
//  ③【存得下】`json-text` 列今天合法地存着非法 JSON，两个引擎都逐字节存取。
//  ④【真库】PostgreSQL 上 jsonb 往返确实不保字节（执行一次，不靠记忆）。

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { tasks, webhookDeliveries, webhookEndpoints, workflows } from '@/db/schema'
import { truncateDeliveryBody } from '@/modules/integration/domain/webhookDelivery'
import {
  createLogicalTableChunk,
  encodeLogicalRow,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  buildLogicalSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import { describeEachProvider } from './helpers/eachProvider'

/**
 * 保字节的 PostgreSQL 物理类型。`text` 是今天唯一的答案；`varchar` 之类将来若出现也保字节。
 * **`jsonb` / `json` 都不在这里**：前者规范化存储，后者虽然保原文但同样拒绝非法 JSON（③）。
 */
const BYTE_PRESERVING_POSTGRESQL_TYPES = new Set(['text'])

/** 非规范形态的 JSON 文本：键逆序 + 冒号后有空格 + `1.0` + `1e3`。jsonb 会把这四样全改掉。 */
const NON_CANONICAL_JSON = '{"b":1,"a":2, "n":1.0,"e":1e3}'

describe('RFC-359 W6-T23 —— json-text 列必须保字节', () => {
  const contract = buildLogicalSchemaContract()

  test('① 每个 json-text 列在 PostgreSQL 上都投影成保字节类型（不是 jsonb）', () => {
    const offenders: string[] = []
    let jsonColumns = 0
    for (const table of contract.tables) {
      if (table.disposition === 'ARCHIVE_THEN_OMIT') continue
      for (const column of table.columns) {
        if (column.logicalCodec !== 'json-text') continue
        jsonColumns += 1
        if (!BYTE_PRESERVING_POSTGRESQL_TYPES.has(column.providerType.postgresql)) {
          offenders.push(`${table.id}.${column.name} → ${column.providerType.postgresql}`)
        }
      }
    }
    // 失败关闭：扫描面本身要有下界，否则「没找到违例」与「没扫到列」同形。
    expect(jsonColumns, 'json-text 列一个都没扫到 —— 判据在放空枪').toBeGreaterThan(150)
    expect(
      offenders,
      '这些 json-text 列被投影成了非保字节的 PostgreSQL 类型。\n' +
        'jsonb 会重排键、规整空白、重写数字，于是：\n' +
        '  · SQLite→PostgreSQL 逻辑复制回读时块摘要对不上（postgresql-target-chunk-mismatch）；\n' +
        '  · 存不下今天合法存在的非法 JSON（webhook_deliveries.body_json 是被裸截断的原始请求体）；\n' +
        '  · 全仓 21 处对 JSON 列原文做 hash / 相等比较的判据一起失真。\n' +
        '要走这条路，先把上面三条各自的替代契约立起来（那是另一个 RFC 的量级）。\n' +
        '同文件里有可执行的证据，别只看这段话。',
    ).toEqual([])
  })

  test('② JSON 文本一旦被规范化，逻辑复制的块摘要就变（迁移会在这里停住）', () => {
    const table = contract.tables.find(
      (candidate): candidate is LogicalTableContract => candidate.id === 'tasks',
    )
    expect(table, '契约里没有 tasks 表').toBeDefined()
    const jsonColumn = table!.columns.find((column) => column.name === 'workgroup_config_json')
    expect(jsonColumn?.logicalCodec, 'workgroup_config_json 不再是 json-text 列').toBe('json-text')

    const rowWith = (document: string): Record<string, unknown> =>
      Object.fromEntries(
        table!.columns.map((column) => {
          if (column.name === 'workgroup_config_json') return [column.name, document]
          if (column.primary) return [column.name, 'w6t23']
          if (!column.nullable) {
            return [
              column.name,
              column.logicalCodec === 'boolean'
                ? false
                : column.logicalCodec === 'real' ||
                    column.logicalCodec === 'integer' ||
                    column.logicalCodec === 'epoch-milliseconds'
                  ? 0
                  : column.logicalCodec === 'json-text'
                    ? '{}'
                    : 'x',
            ]
          }
          return [column.name, null]
        }),
      )

    const chunkOf = (document: string): string =>
      createLogicalTableChunk({
        operationId: 'dbm_rfc359_w6_t23',
        contract,
        table: table!,
        chunkIndex: 0,
        rows: [encodeLogicalRow(table!, rowWith(document))],
      }).digest

    // 同一个 JSON **值**、两种字节形态 —— 源那一份与 jsonb 回读的那一份。
    const source = chunkOf(NON_CANONICAL_JSON)
    const afterJsonbRoundTrip = chunkOf('{"a": 2, "b": 1, "e": 1000, "n": 1.0}')
    expect(source).not.toBe(afterJsonbRoundTrip)
    // 同一份字节当然要同一个 digest（否则上一条断言什么都没证明）。
    expect(chunkOf(NON_CANONICAL_JSON)).toBe(source)
  })
})

describeEachProvider('RFC-359 W6-T23 —— json-text 列在真库上的存取', (harness) => {
  test('③ json-text 列合法地存着**非法** JSON，并且逐字节存取（jsonb 列根本存不下这行）', async () => {
    // 生产形状：webhook 投递把原始请求体按 256 KiB 裸截断后落进 body_json。
    const body = `{"object_kind":"push","commits":[${'{"id":"deadbeef"},'.repeat(20000)}`
    const stored = truncateDeliveryBody(body)
    expect(stored.length).toBeLessThan(body.length)
    expect(() => JSON.parse(stored), '截断后的请求体居然还是合法 JSON —— 语料要加长').toThrow()

    await harness.db.insert(webhookEndpoints).values({
      id: 'wep-w6t23',
      name: 'w6t23',
      provider: 'gitlab',
      urlToken: 'w6t23-token',
      secretEnc: 'x',
      createdAt: 1,
      updatedAt: 1,
    })
    await harness.db.insert(webhookDeliveries).values({
      id: 'wd-w6t23',
      endpointId: 'wep-w6t23',
      status: 'received',
      bodyJson: stored,
      receivedAt: 1,
    })
    const [row] = await harness.db
      .select({ bodyJson: webhookDeliveries.bodyJson })
      .from(webhookDeliveries)
    expect(row?.bodyJson, '非法 JSON 没能逐字节存取').toBe(stored)
  })

  test('③b 非规范形态的 JSON 也逐字节存取（这正是 jsonb 会破坏的性质）', async () => {
    await harness.db.insert(workflows).values({ id: 'wf-w6t23', name: 'w6t23', definition: '{}' })
    await harness.db.insert(tasks).values({
      id: 'w6t23-task',
      name: 'w6t23',
      workflowId: 'wf-w6t23',
      workflowSnapshot: '{}',
      repoPath: '/repo',
      repoUrl: 'git@example.com:acme/r.git',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/w6t23',
      status: 'done',
      inputs: '{}',
      startedAt: 1,
      runningMs: 0,
      ownerUserId: null,
      invocationDepth: 0,
      launchOrigin: 'manual',
      branchStartedAt: 1,
      rootTaskId: 'w6t23-task',
      workgroupConfigJson: NON_CANONICAL_JSON,
    })
    const [row] = await harness.db
      .select({ config: tasks.workgroupConfigJson })
      .from(tasks)
      .where(sql`${tasks.id} = ${'w6t23-task'}`)
    expect(row?.config).toBe(NON_CANONICAL_JSON)
  })

  test('④ PostgreSQL 上 jsonb 往返确实不保字节（执行一次，不靠记忆）', async () => {
    if (harness.capabilities.provider !== 'postgresql') {
      // SQLite 没有 jsonb 存储类型，这一格只在 PostgreSQL 上有意义；两个引擎共用同一个
      // 判据文件，所以这里显式说明而不是把用例整体隐藏掉。
      expect(harness.capabilities.provider).toBe('sqlite')
      return
    }
    const [row] = await harness.db.all<{ via: string }>(
      // `::text::jsonb`：少了中间那步，驱动会把 JS 字符串当成一个 jsonb **字符串标量**送过去。
      sql`select ((${NON_CANONICAL_JSON})::text::jsonb)::text as via`,
    )
    expect(row?.via).not.toBe(NON_CANONICAL_JSON)
    // 具体变成什么也钉住：键重排、冒号后加空格、`1e3` 重写成 `1000`。
    expect(row?.via).toBe('{"a": 2, "b": 1, "e": 1000, "n": 1.0}')
  })
})
