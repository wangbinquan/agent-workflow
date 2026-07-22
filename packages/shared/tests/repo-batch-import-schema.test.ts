// RFC-033-T1: zod schema boundaries for the batch-import wire types.
//
// These lock in:
//   - StartBatchImportRequest enforces 1..100 URLs
//   - BatchImportRow shape covers all four status values
//   - RepoImportWsMessage discriminates on `type`
// Why: regression guard so any future tweak that loosens the URL cap or
// renames a status value blows up here instead of leaking into the wire.

import { describe, expect, test } from 'bun:test'
import {
  BATCH_IMPORT_MAX_URLS,
  BatchImportRowSchema,
  BatchImportSnapshotSchema,
  RetryBatchImportRowRequestSchema,
  StartBatchImportRequestSchema,
} from '../src/schemas/repoBatchImport'
import { RepoImportWsMessageSchema } from '../src/schemas/ws'

describe('StartBatchImportRequestSchema', () => {
  test('rejects empty urls array', () => {
    expect(() => StartBatchImportRequestSchema.parse({ urls: [] })).toThrow()
  })

  test('accepts exactly 100 urls', () => {
    const urls = Array.from({ length: BATCH_IMPORT_MAX_URLS }, (_, i) => `https://h/${i}`)
    expect(() => StartBatchImportRequestSchema.parse({ urls })).not.toThrow()
  })

  test('rejects 101 urls', () => {
    const urls = Array.from({ length: BATCH_IMPORT_MAX_URLS + 1 }, (_, i) => `https://h/${i}`)
    expect(() => StartBatchImportRequestSchema.parse({ urls })).toThrow()
  })

  test('rejects empty string entries', () => {
    expect(() => StartBatchImportRequestSchema.parse({ urls: [''] })).toThrow()
  })

  // RFC-204 impl-gate (Codex 2026-07-22, P0-4): batch-import was a hole in the
  // query-credential gate — a `?access_token=` URL would slug the token into
  // cached_repos.local_path (which is on the wire). The schema must reject it,
  // same as the launch gate (schemas/task.ts). Percent-encoded keys included.
  test('rejects a query-credential url (plain and percent-encoded)', () => {
    expect(() =>
      StartBatchImportRequestSchema.parse({ urls: ['https://h/r.git?access_token=SECRET'] }),
    ).toThrow()
    expect(() =>
      StartBatchImportRequestSchema.parse({ urls: ['https://h/r.git?access%5Ftoken=SECRET'] }),
    ).toThrow()
  })

  test('still accepts a userinfo-credential url (sealing covers it)', () => {
    expect(() =>
      StartBatchImportRequestSchema.parse({ urls: ['https://user:tok@h/r.git'] }),
    ).not.toThrow()
  })
})

describe('BatchImportRowSchema', () => {
  test('accepts every status enum value', () => {
    for (const status of ['queued', 'cloning', 'done', 'failed'] as const) {
      const row = {
        rowId: '01HXX',
        inputUrl: 'https://example.test/r.git',
        inputUrlRedacted: 'https://example.test/r.git',
        status,
        cold: null,
        fetchOk: null,
        cachedRepoId: null,
        errorCode: null,
        message: null,
        queuedAt: '2026-05-17T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      }
      expect(() => BatchImportRowSchema.parse(row)).not.toThrow()
    }
  })

  test('rejects unknown status', () => {
    const bad = {
      rowId: 'r',
      inputUrl: 'https://h/r',
      inputUrlRedacted: 'https://h/r',
      status: 'pending',
      cold: null,
      fetchOk: null,
      cachedRepoId: null,
      errorCode: null,
      message: null,
      queuedAt: '2026-05-17T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    }
    expect(() => BatchImportRowSchema.parse(bad)).toThrow()
  })
})

describe('BatchImportSnapshotSchema', () => {
  test('accepts a running batch with 1 queued row', () => {
    const snap = BatchImportSnapshotSchema.parse({
      batchId: '01HXX',
      state: 'running',
      createdAt: '2026-05-17T00:00:00.000Z',
      completedAt: null,
      rows: [
        {
          rowId: 'r1',
          inputUrl: 'https://h/a.git',
          inputUrlRedacted: 'https://h/a.git',
          status: 'queued',
          cold: null,
          fetchOk: null,
          cachedRepoId: null,
          errorCode: null,
          message: null,
          queuedAt: '2026-05-17T00:00:00.000Z',
          startedAt: null,
          finishedAt: null,
        },
      ],
    })
    expect(snap.rows).toHaveLength(1)
  })
})

describe('RepoImportWsMessageSchema', () => {
  test('discriminates row.update vs batch.completed', () => {
    const u = RepoImportWsMessageSchema.parse({
      type: 'row.update',
      row: {
        rowId: 'r1',
        inputUrl: 'https://h/a.git',
        inputUrlRedacted: 'https://h/a.git',
        status: 'done',
        cold: true,
        fetchOk: null,
        cachedRepoId: 'cr1',
        errorCode: null,
        message: 'cloned',
        queuedAt: '2026-05-17T00:00:00.000Z',
        startedAt: '2026-05-17T00:00:01.000Z',
        finishedAt: '2026-05-17T00:00:02.000Z',
      },
    })
    expect(u.type).toBe('row.update')

    const c = RepoImportWsMessageSchema.parse({
      type: 'batch.completed',
      batchId: '01HXX',
      completedAt: '2026-05-17T00:00:03.000Z',
    })
    expect(c.type).toBe('batch.completed')

    const e = RepoImportWsMessageSchema.parse({
      type: 'batch.error',
      batchId: '01HXX',
      errorCode: 'internal-error',
      message: 'boom',
    })
    expect(e.type).toBe('batch.error')
  })

  test('rejects unknown type', () => {
    expect(() =>
      RepoImportWsMessageSchema.parse({ type: 'row.removed', rowId: 'r1' } as unknown),
    ).toThrow()
  })
})

describe('RetryBatchImportRowRequestSchema', () => {
  test('accepts empty body', () => {
    expect(() => RetryBatchImportRowRequestSchema.parse({})).not.toThrow()
  })

  test('accepts url override', () => {
    const parsed = RetryBatchImportRowRequestSchema.parse({ url: 'https://h/x.git' })
    expect(parsed.url).toBe('https://h/x.git')
  })

  test('rejects empty url string', () => {
    expect(() => RetryBatchImportRowRequestSchema.parse({ url: '' })).toThrow()
  })

  // RFC-204 impl-gate (Codex 2026-07-22, P0-4): the retry override is a second
  // entry point that must enforce the same query-credential gate.
  test('rejects a query-credential url override', () => {
    expect(() =>
      RetryBatchImportRowRequestSchema.parse({ url: 'https://h/r.git?private_token=x' }),
    ).toThrow()
  })
})
