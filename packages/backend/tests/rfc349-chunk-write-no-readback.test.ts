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
// 等价性由写路径自己保证：`persistLogicalTableChunk` 先 `verifyLogicalTableChunk`
// （Zod + 摘要），再把 canonical JSON 交给 `durableWriteOnce`；后者对已存在的文件逐字节
// 比对，不一致直接判 `logical-artifact-conflict`。所以交回内存里那一份与读回来完全一致。

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
})
