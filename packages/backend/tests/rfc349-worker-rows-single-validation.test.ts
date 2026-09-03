// RFC-349 回归防护 —— 逻辑行只在**一处**做逐值校验，但那一处必须还在。
//
// 为什么这条测试存在（2026-09-03）：SQLite 逻辑源跑在独立 Worker 里，行经 `postMessage`
// 回到主线程。协议此前在**信封解析**时就对 `rows` 跑一遍 `CanonicalLogicalRowSchema`，
// 而这些行的唯一消费者 `createLogicalTableChunk` 紧接着又对整个 payload 跑
// `LogicalTableChunkPayloadSchema`——**用的正是同一份行 schema**。于是每一块的每一个值都被
// Zod 判别联合验两遍。实测（250 行一块）：
//
//   node_runs（59 列 = 14,750 个值）  信封 6.0ms  →  去掉后 0.3ms
//   tasks（70 列 = 17,500 个值）       信封 5.8ms  →  去掉后 0.0ms
//
// 更要紧的不是这 6ms，而是 Zod 会**整份复制**出一个新对象图（约 1.5 万个对象/块 × 5.28 万块
// ≈ 7.9 亿个对象）。修掉两处「每块重复工作」之后，迁移期间剩下的事件循环停顿签名就是 GC
// 尖峰（堆在 70–200MiB 之间摆动、停顿时堆增量为正），这份分配是其中最大的一笔。
//
// 判据：①信封照旧严格（version / requestId / type 任一坏掉当场判失败）；②行的形状坏了
// **仍然会被拒**——只是从传输层挪到了 `createLogicalTableChunk`，对调用方来说失败面不变；
// ③那唯一一处校验还在（payload schema 仍然引用逐值的行 schema）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createLogicalTableChunk,
  type CanonicalLogicalRow,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { SqliteLogicalSourceWorkerEventSchema } from '@/platform/persistence/sqliteLogicalSourceProtocol'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'

const contract = buildLogicalSchemaContract()
const table = contract.tables.find((candidate) => candidate.sourceTable === 'node_run_events')!

function rowsEvent(rows: readonly unknown[]): unknown {
  return { version: 1, requestId: 'sls_7', type: 'rows', rows }
}

const wellFormedRow: CanonicalLogicalRow = {
  key: [{ type: 'integer', value: '1' }],
  values: [
    { type: 'integer', value: '1' },
    { type: 'text', value: 'nr_01ABCDEFGHJKMNPQRSTVWXYZ' },
    { type: 'integer', value: '1788400000000' },
    { type: 'text', value: 'text' },
    { type: 'text', value: 'payload' },
    { type: 'null' },
    { type: 'null' },
  ],
}

describe('RFC-349 logical rows are value-validated exactly once', () => {
  test('the transport envelope is still strict', () => {
    expect(SqliteLogicalSourceWorkerEventSchema.safeParse(rowsEvent([wellFormedRow])).success).toBe(
      true,
    )
    for (const [label, event] of [
      ['wrong protocol version', { version: 2, requestId: 'sls_7', type: 'rows', rows: [] }],
      ['unknown event type', { version: 1, requestId: 'sls_7', type: 'chunks', rows: [] }],
      ['malformed request id', { version: 1, requestId: 'nope', type: 'rows', rows: [] }],
      ['extra key', { version: 1, requestId: 'sls_7', type: 'rows', rows: [], extra: 1 }],
    ] as const) {
      expect(
        SqliteLogicalSourceWorkerEventSchema.safeParse(event).success,
        `${label} 被放行了 ⇒ 协议漂移不再当场判失败`,
      ).toBe(false)
    }
  })

  test('a malformed row rides the transport but is rejected where chunks are built', () => {
    const malformed = { key: [{ type: 'integer', value: 'not-an-integer' }], values: [] }

    // 传输层不再逐值校验，所以它过得去——这正是省下来的那一遍。
    expect(SqliteLogicalSourceWorkerEventSchema.safeParse(rowsEvent([malformed])).success).toBe(
      true,
    )

    // 但唯一的消费者仍然拒绝它：对调用方来说失败面没有变。
    expect(() =>
      createLogicalTableChunk({
        operationId: 'dbm_01TESTSINGLEVALIDATION00',
        contract,
        table,
        chunkIndex: 0,
        rows: [malformed as unknown as CanonicalLogicalRow],
      }),
    ).toThrow()
  })

  test('the one remaining value-level validation is still wired into the chunk payload', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src/platform/persistence/logicalDatabaseArtifact.ts'),
      'utf8',
    )
    const payload = source.slice(
      source.indexOf('const LogicalTableChunkPayloadSchema'),
      source.indexOf('export type LogicalTableChunkPayload'),
    )
    expect(
      payload,
      'chunk payload 不再逐值校验行 ⇒ 现在**没有任何地方**验了，坏行会一路写进产物',
    ).toContain('rows: z.array(CanonicalLogicalRowSchema)')
  })
})
