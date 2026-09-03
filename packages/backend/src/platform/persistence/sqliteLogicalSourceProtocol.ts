// RFC-349 — validated, bounded RPC between the request-serving daemon and the
// SQLite logical-source Worker. Only table identifiers and canonical logical
// rows cross the boundary; the Worker rebuilds and verifies the schema contract
// locally so callers cannot smuggle an alternate table/column projection.

import { z } from 'zod'
import { CanonicalLogicalValueSchema, type CanonicalLogicalRow } from './logicalDatabaseArtifact'

export const SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION = 1 as const

const RequestIdSchema = z.string().regex(/^sls_[0-9]{1,12}$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const SqliteLogicalSourceSnapshotSchema = z
  .object({
    databaseFingerprint: z.string().regex(/^sqlite:[a-f0-9]{24}$/),
    dataVersion: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    fileBytes: z.number().int().nonnegative(),
    totalRows: z.number().int().nonnegative(),
    tableRows: z.record(
      z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
      z.number().int().nonnegative(),
    ),
  })
  .strict()

const BaseRequest = {
  version: z.literal(SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION),
  requestId: RequestIdSchema,
}

export const SqliteLogicalSourceWorkerRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...BaseRequest,
      type: z.literal('init'),
      path: z.string().min(1),
      expectedSchemaDigest: DigestSchema,
    })
    .strict(),
  z.object({ ...BaseRequest, type: z.literal('preflight') }).strict(),
  z
    .object({
      ...BaseRequest,
      type: z.literal('assert-unchanged'),
      snapshot: SqliteLogicalSourceSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ...BaseRequest,
      type: z.literal('read-chunk'),
      tableId: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
      afterKey: z.array(CanonicalLogicalValueSchema).nullable(),
      limit: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z.object({ ...BaseRequest, type: z.literal('close') }).strict(),
])

export type SqliteLogicalSourceWorkerRequest = z.infer<
  typeof SqliteLogicalSourceWorkerRequestSchema
>

const EventBase = {
  version: z.literal(SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION),
  requestId: RequestIdSchema,
}

export const SqliteLogicalSourceWorkerEventSchema = z.discriminatedUnion('type', [
  z.object({ ...EventBase, type: z.literal('ready') }).strict(),
  z
    .object({
      ...EventBase,
      type: z.literal('snapshot'),
      snapshot: SqliteLogicalSourceSnapshotSchema,
    })
    .strict(),
  z.object({ ...EventBase, type: z.literal('unchanged') }).strict(),
  z
    .object({
      ...EventBase,
      type: z.literal('rows'),
      // 行**不在这里逐值校验**（只保留条数上限）：唯一的消费者是
      // `createLogicalTableChunk`，它对整个 payload 跑 `LogicalTableChunkPayloadSchema`
      // ——用的正是同一份 `CanonicalLogicalRowSchema`。在这里再验一遍是纯重复，而代价按
      // 值计：`node_runs` 一块是 250 行 × 59 列 = 14,750 个判别联合，实测 **6.0ms/块**，
      // 并且 Zod 会**整份复制**出一个新对象图（约 1.5 万个对象/块 × 5.28 万块）。迁移期间
      // 的事件循环停顿在修掉两处每块重复工作之后只剩下 GC 尖峰，这份分配正是最大的一笔。
      //
      // 信封本身照旧严格：version / requestId / type 都验，协议漂移仍然当场判失败。行的
      // 形状坏了会在 `createLogicalTableChunk` 以同样的 Zod 错误暴露——对调用方来说失败
      // 面没有变，只是往后挪了一步（守卫见 rfc349-worker-rows-single-validation.test.ts）。
      rows: z.array(z.custom<CanonicalLogicalRow>()).max(10_000),
    })
    .strict(),
  z.object({ ...EventBase, type: z.literal('closed') }).strict(),
  z
    .object({
      ...EventBase,
      type: z.literal('failure'),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
])

export type SqliteLogicalSourceWorkerEvent = z.infer<typeof SqliteLogicalSourceWorkerEventSchema>
