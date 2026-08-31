// RFC-349 — validated, bounded RPC between the request-serving daemon and the
// SQLite logical-source Worker. Only table identifiers and canonical logical
// rows cross the boundary; the Worker rebuilds and verifies the schema contract
// locally so callers cannot smuggle an alternate table/column projection.

import { z } from 'zod'
import { CanonicalLogicalRowSchema, CanonicalLogicalValueSchema } from './logicalDatabaseArtifact'

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
      rows: z.array(CanonicalLogicalRowSchema).max(10_000),
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
