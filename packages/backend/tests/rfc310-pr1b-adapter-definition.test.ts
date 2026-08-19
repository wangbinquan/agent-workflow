// RFC-310 PR-1B T16 —— development adapter definition 合同测试。
//
// 锁四件事：①内容 codec strict + purpose/operations 对拍的每种违规（含
// writeback/collect 必须成对——「只有回写没有回收」不能发布为原渠道澄清可
// 用，design §3.3）；②scripts:author 字段门的正反向（adapter 必含
// executableRef ⇒ 无该权限的 create/revise/publish 一律 403）；③identity+
// immutable revisions 的 CRUD 与 publish 原子性（revision 递增、digest 冻结、
// 再 publish 不改旧行）；④owner+name 唯一 → typed 409。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  archiveDevelopmentAdapter,
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
  reviseDevelopmentAdapterDraft,
  type DevelopmentAdapterStore,
} from '../src/modules/integration/application/developmentAdapterCommands'
import {
  adapterContentDigest,
  developmentAdapterContentSchema,
  validateAdapterContract,
  type DevelopmentAdapterContent,
} from '../src/modules/integration/domain/developmentAdapterDefinition'
import { createSqliteDevelopmentAdapterStore } from '../src/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function content(overrides: Partial<DevelopmentAdapterContent> = {}): DevelopmentAdapterContent {
  return {
    schemaVersion: 1,
    purpose: 'requirement-source',
    operations: ['acquire'],
    contractVersion: 1,
    executableRef: 'programs/req-fetch.ts',
    parameterSchemaRef: null,
    connectionRef: null,
    secretProjection: ['REQ_SYS_TOKEN'],
    outputBudget: { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 },
    timeoutMs: 60_000,
    ...overrides,
  }
}

const AUTHOR = { userId: 'user-1', actorHasScriptsAuthor: true }
const NO_AUTHOR = { userId: 'user-1', actorHasScriptsAuthor: false }

/** 本仓 DomainError 家族把错误码放 `.code`，message 是散文——断言必须读 code
 *（docs/dev-gotchas.md：`not.toMatch(/code/)` 对 message 是空断言的镜像坑）。 */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message
  }
  throw new Error('expected the call to throw')
}

describe('rfc310 adapter content contract', () => {
  test('valid contents pass; strict schema rejects unknown keys', () => {
    expect(validateAdapterContract(content())).toEqual([])
    expect(
      validateAdapterContract(
        content({ operations: ['acquire', 'questions.writeback', 'answers.collect'] }),
      ),
    ).toEqual([])
    expect(
      validateAdapterContract(
        content({ purpose: 'pipeline-gate', operations: ['collect', 'trigger', 'rerun'] }),
      ),
    ).toEqual([])
    expect(
      validateAdapterContract(
        content({ purpose: 'pipeline-classifier', operations: ['classify'] }),
      ),
    ).toEqual([])
    expect(
      validateAdapterContract(
        content({
          purpose: 'approval-gateway',
          operations: ['submit', 'lookup-by-idempotency-key', 'observe'],
        }),
      ),
    ).toEqual([])
    expect(developmentAdapterContentSchema.safeParse({ ...content(), extra: 1 }).success).toBe(
      false,
    )
  })

  test.each([
    [
      'missing required acquire',
      content({ operations: ['questions.writeback', 'answers.collect'] }),
      'missing-required-operation',
    ],
    [
      'writeback without collect',
      content({ operations: ['acquire', 'questions.writeback'] }),
      'writeback-collect-must-pair',
    ],
    [
      'collect without writeback',
      content({ operations: ['acquire', 'answers.collect'] }),
      'writeback-collect-must-pair',
    ],
    [
      'pipeline op on requirement source',
      content({ operations: ['acquire', 'trigger'] }),
      'operation-outside-purpose',
    ],
    [
      'classifier with extra op',
      content({ purpose: 'pipeline-classifier', operations: ['classify', 'collect'] }),
      'operation-outside-purpose',
    ],
    [
      'gate missing collect',
      content({ purpose: 'pipeline-gate', operations: ['trigger'] }),
      'missing-required-operation',
    ],
    [
      'approval gateway missing idempotency lookup',
      content({ purpose: 'approval-gateway', operations: ['submit', 'observe'] }),
      'missing-required-operation',
    ],
    ['duplicate operation', content({ operations: ['acquire', 'acquire'] }), 'duplicate-operation'],
    ['duplicate secret key', content({ secretProjection: ['A', 'A'] }), 'duplicate-secret-key'],
  ])('violation: %s', (_label, bad, expectedCode) => {
    expect(validateAdapterContract(bad).map((v) => v.code as string)).toContain(expectedCode)
  })

  test('digest is canonical (key order independent) and content-sensitive', () => {
    const a = content()
    const digest = adapterContentDigest(a)
    expect(adapterContentDigest(JSON.parse(JSON.stringify(a)))).toBe(digest)
    expect(adapterContentDigest(content({ timeoutMs: 61_000 }))).not.toBe(digest)
  })
})

describe('rfc310 adapter store + commands', () => {
  let db: DbClient
  let store: DevelopmentAdapterStore

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    store = createSqliteDevelopmentAdapterStore(db)
  })

  test('create → revise → publish twice: revisions immutable, digest frozen, identity advances', () => {
    const row = createDevelopmentAdapter(store, AUTHOR, {
      name: 'req-sys',
      content: content(),
      now: 1000,
    })
    expect(row.publishedRevision).toBeNull()
    expect(row.visibility).toBe('private')

    const first = publishDevelopmentAdapter(store, AUTHOR, { id: row.id, now: 2000 })
    expect(first.revision).toBe(1)

    reviseDevelopmentAdapterDraft(store, AUTHOR, {
      id: row.id,
      content: content({ timeoutMs: 120_000 }),
      now: 3000,
    })
    const second = publishDevelopmentAdapter(store, AUTHOR, { id: row.id, now: 4000 })
    expect(second.revision).toBe(2)
    expect(second.contentDigest).not.toBe(first.contentDigest)

    const rev1 = store.getRevision(row.id, 1)
    expect(rev1?.contentDigest).toBe(first.contentDigest)
    expect(JSON.parse(rev1!.contentJson).timeoutMs).toBe(60_000)
    expect(store.getById(row.id)?.publishedRevision).toBe(2)
  })

  test('scripts:author gate: create/revise/publish all reject without the capability', () => {
    expect(
      codeOf(() =>
        createDevelopmentAdapter(store, NO_AUTHOR, { name: 'x', content: content(), now: 1 }),
      ),
    ).toBe('scripts-author-required')

    const row = createDevelopmentAdapter(store, AUTHOR, {
      name: 'x',
      content: content(),
      now: 1,
    })
    expect(
      codeOf(() =>
        reviseDevelopmentAdapterDraft(store, NO_AUTHOR, {
          id: row.id,
          content: content({ timeoutMs: 90_000 }),
          now: 2,
        }),
      ),
    ).toBe('scripts-author-required')
    expect(codeOf(() => publishDevelopmentAdapter(store, NO_AUTHOR, { id: row.id, now: 3 }))).toBe(
      'scripts-author-required',
    )
  })

  test('purpose is immutable across revisions; archive blocks further writes', () => {
    const row = createDevelopmentAdapter(store, AUTHOR, {
      name: 'gate',
      content: content({ purpose: 'pipeline-gate', operations: ['collect'] }),
      now: 1,
    })
    expect(
      codeOf(() =>
        reviseDevelopmentAdapterDraft(store, AUTHOR, {
          id: row.id,
          content: content(),
          now: 2,
        }),
      ),
    ).toBe('development-adapter-purpose-immutable')

    archiveDevelopmentAdapter(store, { id: row.id, now: 3 })
    expect(codeOf(() => publishDevelopmentAdapter(store, AUTHOR, { id: row.id, now: 4 }))).toBe(
      'development-adapter-not-found',
    )
  })

  test('owner+name collision is a typed 409', () => {
    createDevelopmentAdapter(store, AUTHOR, { name: 'dup', content: content(), now: 1 })
    expect(
      codeOf(() =>
        createDevelopmentAdapter(store, AUTHOR, { name: 'dup', content: content(), now: 2 }),
      ),
    ).toBe('development-adapter-name-taken')
  })

  test('invalid content is a typed validation error before any write', () => {
    expect(
      codeOf(() =>
        createDevelopmentAdapter(store, AUTHOR, {
          name: 'bad',
          content: content({ operations: ['acquire', 'questions.writeback'] }),
          now: 1,
        }),
      ),
    ).toBe('development-adapter-contract-violation')
    expect(store.getById('nonexistent')).toBeNull()
  })
})
