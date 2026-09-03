// RFC-349 回归防护 —— 拷贝循环写完一块之后**不再把它读回来**。
//
// 为什么这条测试存在（2026-09-03）：迁移的拷贝循环此前是 `write` 之后再
// `readLogicalTableChunk(path)`，于是同一块要多做一遍 `JSON.parse` + Zod 校验 + 摘要。
// 实测（250 行一块）：
//
//   普通块（node_run_events，0.2–0.4MB）   write 4.1ms   readback 3.0ms
//   宽表块（tasks，70 列，4.0MB）          write 32.3ms  readback 23.3ms
//
// 一次全量迁移是 5 万多块，读回这一步既是**四成**的同步耗时，也是同等比例的临时字符串
// 垃圾——而它证明不了什么：文件刚 fsync 完，读回来命中的是页缓存。托管取证唯一未过的门
// 正是迁移期间的事件循环停顿，主线程上每一块少做一遍解析与校验是直接的减法。
//
// 等价性由写路径自己保证：`persistLogicalTableChunk` 先校验（Zod + 摘要），再把 canonical
// JSON 交给 `durableWriteOnce`；后者对已存在的文件逐字节比对，不一致直接判
// `logical-artifact-conflict`。所以交回内存里那一份与读回来完全一致。
//
// 第二步同源优化：`createLogicalTableChunk` 刚构造出来的块，payload 刚过 Zod、digest 刚按
// 同一份 canonical JSON 算过，写路径**再验一遍是纯重复**。实测那一遍占整个写入的 65%–73%
// （tasks 2.03MB：verify 18.5ms / serialize 9.2ms）。同一进程里的 A/B（旧路径 = 完整校验 +
// 写 + 读回；新路径 = 构造即已校验 + 写）：
//
//   tasks（2.03MB）           55.2ms → 12.5ms   −77%
//   node_runs（1.75MB）       40.1ms →  9.7ms   −76%
//   node_run_events（0.24MB）  7.4ms →  2.2ms   −71%
//
// 「构造即已校验」这个标记住在模块私有的 WeakSet 里，只有构造函数往里加：从磁盘、网络或
// 任何调用方手里拿到的对象都进不来，照旧走完整校验——下面的用例逐条钉住这一点。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createFileDatabaseMigrationArtifactStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore'
import {
  createLogicalTableChunk,
  persistLogicalTableChunk,
  readLogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'

const contract = buildLogicalSchemaContract()
const table = contract.tables.find((candidate) => candidate.sourceTable === 'node_run_events')!
const OPERATION_ID = 'dbm_01TESTREADBACK0000000000'

function chunkOf(rowCount: number, chunkIndex = 0) {
  return createLogicalTableChunk({
    operationId: OPERATION_ID,
    contract,
    table,
    chunkIndex,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      key: [{ type: 'integer' as const, value: String(index + 1) }],
      values: [
        { type: 'integer' as const, value: String(index + 1) },
        { type: 'text' as const, value: 'nr_01ABCDEFGHJKMNPQRSTVWXYZ' },
        { type: 'integer' as const, value: '1788400000000' },
        { type: 'text' as const, value: 'text' },
        { type: 'text' as const, value: `payload ${index}` },
        { type: 'null' as const },
        { type: 'null' as const },
      ],
    })),
  })
}

describe('RFC-349 a copied chunk is not read back off disk', () => {
  test('what the store hands back equals what a read-back would have produced', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-readback-'))
    try {
      const store = createFileDatabaseMigrationArtifactStore({ operationsRoot: root })
      const chunk = chunkOf(64)
      const persisted = store.writeTableChunk(OPERATION_ID, chunk)
      const path = join(
        store.operationRoot(OPERATION_ID),
        'chunks',
        table.id,
        'chunk-00000000.json',
      )

      expect(persisted.chunk, '交回的那一份与读回来不一致 ⇒ 省掉读回就不是等价改写了').toEqual(
        readLogicalTableChunk(path),
      )
      expect(persisted.bytes, 'bytes 必须仍是磁盘上那个文件的字节数').toBe(statSync(path).size)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a resumed write of the identical chunk still returns the persisted form', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-readback-resume-'))
    try {
      const store = createFileDatabaseMigrationArtifactStore({ operationsRoot: root })
      const chunk = chunkOf(8, 3)
      const first = store.writeTableChunk(OPERATION_ID, chunk)
      // 崩溃恢复会重放同一块：`durableWriteOnce` 走「已存在且逐字节相同」这条路。
      const second = store.writeTableChunk(OPERATION_ID, chunk)

      expect(second.chunk).toEqual(first.chunk)
      expect(second.bytes).toBe(first.bytes)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('persistLogicalTableChunk reports the byte length of the body it wrote', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-persist-'))
    try {
      const persisted = persistLogicalTableChunk(root, chunkOf(16, 2))
      expect(persisted.bytes).toBe(Buffer.byteLength(readFileSync(persisted.path, 'utf8'), 'utf8'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the migration store no longer reads a chunk back', () => {
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src/modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore.ts',
      ),
      'utf8',
    )
    expect(
      source,
      '读回又回来了 ⇒ 每一块都要多做一遍 JSON.parse + Zod + 摘要，主线程白扛四成',
    ).not.toContain('readLogicalTableChunk')
  })

  test('a chunk that did not come from the constructor is still fully verified', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-verify-'))
    try {
      const chunk = chunkOf(8, 5)
      // 结构完全相同，但不是构造函数产出的那个对象 —— 必须仍然走完整校验，
      // 且写出来的字节与构造函数那条路径逐字相同。
      const plain = JSON.parse(JSON.stringify(chunk)) as typeof chunk
      const fromPlain = persistLogicalTableChunk(join(root, 'plain'), plain)
      const fromConstructor = persistLogicalTableChunk(join(root, 'constructed'), chunk)

      expect(readFileSync(fromPlain.path, 'utf8')).toBe(readFileSync(fromConstructor.path, 'utf8'))
      expect(fromPlain.bytes).toBe(fromConstructor.bytes)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a tampered chunk cannot slip past the skip', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-tamper-'))
    try {
      const chunk = chunkOf(4, 6)
      const tampered = JSON.parse(JSON.stringify(chunk)) as {
        digest: string
        payload: { rows: { values: { type: string; value?: string }[] }[] }
      }
      tampered.payload.rows[0]!.values[4] = { type: 'text', value: 'tampered' }

      expect(
        () => persistLogicalTableChunk(join(root, 'tampered'), tampered as never),
        '摘要对不上的块被写了出去 ⇒ 「构造即已校验」的跳过被人绕开了',
      ).toThrow('logical database chunk failed validation or digest verification')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a constructed chunk is frozen so its digest cannot be swapped after the fact', () => {
    const chunk = chunkOf(2, 7) as { digest: string }
    expect(() => {
      chunk.digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    }, '构造出来的块可以被改写 ⇒ 跳过校验就成了一条真的腐化路径').toThrow()
  })
})
