// RFC-371 native-part-key-prefetch.md: complete ID reads must match the original
// scalar range SQL, including physical-order JSON failures and ACKed prefixes.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHistoricalOpencodeUsagePassFactory,
  openOpencodeUsagePass,
} from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '../src/platform/persistence/sqlite/readonlySqliteDatabase'
import type { HistoricalNativePassReader } from '../src/modules/runtime-management/application/ports/historicalNativeUsage'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
type RawPart = {
  id: string
  session_id: string
  message_id: string
  time_created: number
  kind: string | null
  input: unknown
  output: unknown
  reasoning: unknown
  cache_read: unknown
  cache_write: unknown
  provider: unknown
  model: unknown
}
// Independent pre-prefetch range projection. No optimized key query is used here.
const originalFields = `SELECT p.id,p.session_id,p.message_id,p.time_created,
  json_extract(p.data,'$.type') AS kind,
  CASE WHEN json_type(p.data,'$.tokens.input') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.input') END AS input,
  CASE WHEN json_type(p.data,'$.tokens.output') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.output') END AS output,
  CASE WHEN json_type(p.data,'$.tokens.reasoning') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.reasoning') END AS reasoning,
  CASE WHEN json_type(p.data,'$.tokens.cache.read') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.read') END AS cache_read,
  CASE WHEN json_type(p.data,'$.tokens.cache.write') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.write') END AS cache_write,
  CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.providerID') END AS provider,
  CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.modelID') END AS model
  FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id`

function fixture(collation: 'BINARY' | 'NOCASE' = 'BINARY', composite = false) {
  const folder = mkdtempSync(join(tmpdir(), 'aw-native-part-keys-')),
    path = join(folder, 'original.db'),
    db = new Database(path)
  cleanups.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => db.close(),
  )
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT COLLATE ${collation} PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id);
    CREATE TABLE message(id TEXT COLLATE ${collation} PRIMARY KEY,session_id TEXT COLLATE ${collation},data TEXT);
    CREATE TABLE part(id TEXT COLLATE ${collation} PRIMARY KEY,session_id TEXT COLLATE ${collation},message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id${composite ? ',id' : ''});`)
  const session = (id: string, parent: string | null = null) =>
    db.query('INSERT INTO session VALUES (?,?,?)').run(id, parent, 1000)
  const message = (id: string, sessionId: string, model = 'model') =>
    db
      .query('INSERT INTO message VALUES (?,?,?)')
      .run(
        id,
        sessionId,
        JSON.stringify({ role: 'assistant', providerID: 'provider', modelID: model }),
      )
  const part = (
    id: string | null,
    sessionId: string,
    messageId: string | null,
    kind = 'step-finish',
    input: string | number = 11,
  ) =>
    db.query('INSERT INTO part VALUES (?,?,?,?,?)').run(
      id,
      sessionId,
      messageId,
      1234,
      JSON.stringify({
        type: kind,
        tokens: { input, output: 3, reasoning: 2, cache: { read: 7, write: 13 } },
        text: 'raw-body-must-not-enter-transport',
      }),
    )
  session('root')
  let next = 0,
    opens = 0
  const calls: Array<{
    sql: string
    method: 'get' | 'all'
    args: readonly unknown[]
    rows?: number
  }> = []
  const open = (
    root = 'root',
    rows = 200,
    bytes = 256 * 1024,
    uncertainQualification = false,
  ): HistoricalNativePassReader => {
    const factory = createHistoricalOpencodeUsagePassFactory(path, {
      pageRows: rows,
      pageBytes: bytes,
      openDatabase(path): ReadonlySqliteDatabase {
        opens++
        const original = openReadonlySqliteDatabase(path)
        return {
          query<Row, Parameters extends readonly unknown[]>(sql: string) {
            if (uncertainQualification && sql.includes('json_valid(p.data)'))
              throw new Error('Qualification unavailable')
            const statement = original.query<Row, Parameters>(sql)
            return {
              get(...args: Parameters) {
                calls.push({ sql, method: 'get', args })
                return statement.get(...args)
              },
              all(...args: Parameters) {
                const result = statement.all(...args)
                calls.push({ sql, method: 'all', args, rows: result.length })
                return result
              },
            }
          },
          close: () => original.close(),
        }
      },
    })
    cleanups.push(() => factory.close())
    const reader = factory.open({
      kind: 'historical-observed',
      passId: 'pass-' + ++next,
      referenceId: 'reference-' + next,
      nativeSource: 'original-file',
      sourceGeneration: 'original-generation',
      rootSessionId: root,
    })
    return reader
  }
  return { path, db, session, message, part, open, calls, opens: () => opens }
}
function originalRange(db: Database, session: string, after: string | null) {
  return after === null
    ? db
        .query<RawPart, [string]>(originalFields + ' WHERE p.session_id=?1 ORDER BY p.id LIMIT 1')
        .get(session)
    : db
        .query<
          RawPart,
          [string, string]
        >(originalFields + ' WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT 1')
        .get(session, after)
}
function oracle(db: Database, rootId = 'root') {
  const fingerprint = createHash('sha256'),
    root = db.query('SELECT id,parent_id,time_created FROM session WHERE id=?').get(rootId),
    pending = new Map<string, string | null>([[rootId, null]]),
    rows: RawPart[] = []
  let sessions = 0n,
    parts = 0n,
    steps = 0n
  fingerprint.update(JSON.stringify(['root', root]))
  while (pending.size) {
    const id = [...pending.keys()].sort()[0]!,
      parent = pending.get(id)!
    pending.delete(id)
    fingerprint.update(JSON.stringify(['session', { id, parentSessionId: parent }]))
    sessions++
    let after: string | null = null
    for (;;) {
      const row = originalRange(db, id, after)
      if (!row) break
      rows.push(row)
      fingerprint.update(JSON.stringify(['part', row]))
      parts++
      if (row.kind === 'step-finish') steps++
      after = row.id
    }
    for (const child of db
      .query<
        { id: string; parent_id: string },
        [string]
      >('SELECT id,parent_id FROM session WHERE parent_id=? ORDER BY id')
      .all(id)) {
      fingerprint.update(JSON.stringify(['child', child]))
      pending.set(child.id, id)
    }
  }
  return {
    rows,
    eof: {
      fingerprint: fingerprint.digest('hex'),
      counts: { sessions: String(sessions), parts: String(parts), steps: String(steps) },
    },
  }
}
function consume(
  reader: HistoricalNativePassReader | ReturnType<typeof openOpencodeUsagePass>,
  initial = reader.initialCursor,
  maxBytes = 256 * 1024,
) {
  let cursor: string | null = initial,
    last: ReturnType<typeof reader.next> | undefined
  const steps: ReturnType<typeof reader.next>['steps'][number][] = []
  while (cursor !== null) {
    const page: ReturnType<typeof reader.next> = reader.next(cursor)
    expect(reader.next(cursor)).toEqual(page)
    expect(JSON.stringify(page)).not.toContain('raw-body-must-not-enter-transport')
    expect(JSON.stringify(page)).not.toContain('cache_message')
    expect(
      page.sessions.reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0) +
        page.steps.reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0),
    ).toBeLessThanOrEqual(maxBytes)
    steps.push(...page.steps)
    reader.acknowledge(page.ordinal, page.payloadDigest)
    cursor = page.nextCursor
    last = page
  }
  return { steps, eof: last!.eof, issues: last!.issues }
}
function ackRoot(reader: HistoricalNativePassReader) {
  const page = reader.next(reader.initialCursor)
  expect(page.sessions).toEqual([{ id: 'root', parentSessionId: null }])
  expect(page.counts).toEqual({ sessions: '1', parts: '0', steps: '0' })
  expect(page.steps).toEqual([])
  expect(page.eof).toBeNull()
  reader.acknowledge(page.ordinal, page.payloadDigest)
  return page.nextCursor!
}
function failure(action: () => unknown) {
  try {
    action()
  } catch (error) {
    return error as Error
  }
  throw new Error('Original range SQL should have failed')
}

for (const collation of ['BINARY', 'NOCASE'] as const) {
  test(`${collation} original order, descendant fields and fingerprint survive more than one key block`, () => {
    const f = fixture(collation),
      big = '9007199254740993000'
    f.db.transaction(() => {
      f.session('child', 'root')
      f.session('grandchild', 'child')
      f.message('shared', 'root')
      f.message('child-message', 'child', 'child-model')
      f.message('grand-message', 'grandchild', 'grand-model')
      // Physical order differs from both BINARY and NOCASE ID order.
      for (let n = 402; n >= 0; n--)
        f.part('p-' + String(n).padStart(4, '0'), 'root', 'shared', 'text')
      f.part('a', 'root', 'shared', 'step-finish', big)
      f.part('B', 'root', 'shared')
      f.part('child-finish', 'child', 'child-message')
      f.part('grand-finish', 'grandchild', 'grand-message')
    })()
    const expected = oracle(f.db)
    expect(expected.eof.counts).toEqual({ sessions: '3', parts: '407', steps: '4' })
    for (const rows of [1, 200, 1000]) {
      const actual = consume(f.open('root', rows))
      expect(actual.eof).toEqual(expected.eof)
      expect(actual.steps.map((v) => v.stepId)).toEqual(
        expected.rows.filter((v) => v.kind === 'step-finish').map((v) => v.id),
      )
      expect(actual.steps.reduce((n, v) => n + BigInt(v.usage.input!), 0n)).toBe(BigInt(big) + 33n)
      expect(actual.steps.reduce((n, v) => n + BigInt(v.usage.cacheRead!), 0n)).toBe(28n)
      expect(actual.steps.reduce((n, v) => n + BigInt(v.usage.cacheWrite!), 0n)).toBe(52n)
      expect(actual.steps.reduce((n, v) => n + BigInt(v.usage.output!), 0n)).toBe(20n)
      expect(actual.issues).toEqual([])
    }
    const keys = f.calls.filter(
      (v) => v.method === 'all' && v.sql.startsWith('SELECT p.id FROM part'),
    )
    expect(keys.some((v) => v.rows === 200)).toBe(true)
    expect(keys.every((v) => v.rows! <= 200 && Number(v.args.at(-1)) <= 200)).toBe(true)
  }, 30000)
}

test('pageBytes break retains the pending ID and baseline/final preserve the same original EOF', () => {
  const f = fixture()
  f.message('shared', 'root', 'm'.repeat(400))
  for (let n = 0; n < 9; n++) f.part(String(n), 'root', 'shared')
  const expected = oracle(f.db)
  expect(consume(f.open('root', 200, 1024), undefined, 1024).eof).toEqual(expected.eof)
  for (const phase of ['baseline', 'final'] as const) {
    const reader = openOpencodeUsagePass(
      f.path,
      {
        phase,
        passId: phase,
        invocationId: 'call',
        lineage: 'lineage',
        epoch: 'epoch',
        nativeSource: 'original-file',
        sourceGeneration: 'generation',
        rootSessionId: 'root',
      },
      { pageRows: 200, pageBytes: 1024 },
    )
    cleanups.push(() => reader.close())
    const actual = consume(reader, undefined, 1024)
    expect(actual.eof).toEqual(expected.eof)
    expect(actual.steps.map((v) => v.stepId)).toEqual(expected.rows.map((v) => v.id))
  }
})

for (const kind of ['part', 'message'] as const) {
  test(`physical b-before-a bad ${kind} retains the original range failure before any part ACK`, () => {
    const f = fixture()
    f.message('bad', 'root')
    f.message('good', 'root')
    f.part('b', 'root', 'bad')
    f.part('a', 'root', 'good')
    f.db.query(`UPDATE ${kind} SET data=? WHERE id=?`).run('{', kind === 'part' ? 'b' : 'bad')
    const expected = failure(() => originalRange(f.db, 'root', null)),
      reader = f.open('root', 1),
      cursor = ackRoot(reader)
    expect(expected.message).toContain('malformed JSON')
    expect(failure(() => reader.next(cursor)).message).toBe(expected.message)
    expect(
      f.calls.some((v) => v.method === 'all' && v.sql.startsWith('SELECT p.id FROM part')),
    ).toBe(false)
    expect(() => reader.next(cursor)).toThrow('snapshot closed')
  })
}

test('already ACKed valid prefix survives a later bad row under the original composite range plan', () => {
  const f = fixture('BINARY', true)
  f.message('shared', 'root')
  f.part('a', 'root', 'shared')
  f.part('b', 'root', 'shared')
  f.db.query('UPDATE part SET data=? WHERE id=?').run('{', 'b')
  const first = originalRange(f.db, 'root', null)!,
    expected = failure(() => originalRange(f.db, 'root', first.id)),
    reader = f.open('root', 1),
    cursor = ackRoot(reader),
    page = reader.next(cursor)
  expect(first.id).toBe('a')
  expect(page.counts).toEqual({ sessions: '1', parts: '1', steps: '1' })
  expect(page.steps.map((v) => ({ id: v.stepId, usage: v.usage }))).toEqual([
    { id: 'a', usage: { input: '11', cacheRead: '7', cacheWrite: '13', output: '5' } },
  ])
  expect(reader.next(cursor)).toEqual(page)
  reader.acknowledge(page.ordinal, page.payloadDigest)
  expect(failure(() => reader.next(page.nextCursor!)).message).toBe(expected.message)
  expect(() => reader.next(cursor)).toThrow('snapshot closed')
})

for (const key of ['', null]) {
  test(`original ${key === null ? 'NULL' : 'empty'} part ID rejects instead of silently completing`, () => {
    const f = fixture()
    f.message('shared', 'root')
    f.part(key, 'root', 'shared')
    const reader = f.open('root', 1),
      cursor = ackRoot(reader)
    expect(originalRange(f.db, 'root', null)?.id).toBe(key)
    expect(() => reader.next(cursor)).toThrow('Native part cursor unavailable')
    expect(() => reader.next(cursor)).toThrow('snapshot closed')
  })
}

test('missing messages and SQL NULL data keep every original row; unrelated bad sessions do not change this root', () => {
  const f = fixture()
  f.session('other')
  f.message('other-message', 'other')
  f.db.query('UPDATE message SET data=? WHERE id=?').run('{', 'other-message')
  f.part('a', 'root', 'other-message')
  f.part('b', 'root', 'absent')
  f.part('c', 'root', 'absent', 'text')
  f.db.query('UPDATE part SET data=NULL WHERE id=?').run('c')
  const expected = oracle(f.db),
    actual = consume(f.open())
  expect(actual.eof).toEqual(expected.eof)
  expect(actual.eof?.counts).toEqual({ sessions: '1', parts: '3', steps: '2' })
  expect(actual.steps.map((v) => [v.stepId, v.model, v.usage])).toEqual(
    ['a', 'b'].map((id) => [
      id,
      null,
      { input: '11', cacheRead: '7', cacheWrite: '13', output: '5' },
    ]),
  )
  expect(actual.issues).toEqual(['native-model-unavailable'])
})

test('prefetched IDs stay in their original WAL snapshot and never leak into a later reader', () => {
  const f = fixture()
  f.message('shared', 'root')
  for (let n = 0; n < 405; n++) f.part('p-' + String(n).padStart(4, '0'), 'root', 'shared')
  const before = oracle(f.db),
    reader = f.open('root', 200, 1024),
    first = reader.next(reader.initialCursor)
  expect(first.steps.length).toBeGreaterThan(0)
  expect(() => reader.next(first.nextCursor!)).toThrow('awaits original owner ACK')
  f.part('new-between-pages', 'root', 'shared')
  f.db
    .query('UPDATE message SET data=? WHERE id=?')
    .run(JSON.stringify({ role: 'assistant', providerID: 'provider', modelID: 'later' }), 'shared')
  expect(reader.next(first.cursor)).toEqual(first)
  reader.acknowledge(first.ordinal, first.payloadDigest)
  const rest = consume(reader, first.nextCursor!, 1024)
  expect(rest.eof).toEqual(before.eof)
  expect([...first.steps, ...rest.steps].map((v) => v.stepId)).toEqual(before.rows.map((v) => v.id))
  expect([...first.steps, ...rest.steps].every((v) => v.model?.id === 'model')).toBe(true)
  const later = consume(f.open())
  expect(later.eof).toEqual(oracle(f.db).eof)
  expect(later.steps).toHaveLength(406)
  expect(later.steps.every((v) => v.model?.id === 'later')).toBe(true)
})

test('uncertain qualification falls back to complete original SQL instead of failing or skipping rows', () => {
  const f = fixture()
  f.message('shared', 'root')
  for (const id of ['b', 'a', 'c']) f.part(id, 'root', 'shared')
  const expected = oracle(f.db),
    actual = consume(f.open('root', 200, 256 * 1024, true))
  expect(actual.eof).toEqual(expected.eof)
  expect(actual.steps.map((v) => v.stepId)).toEqual(['a', 'b', 'c'])
  expect(f.calls.some((v) => v.method === 'all' && v.sql.startsWith('SELECT p.id FROM part'))).toBe(
    false,
  )
})

test('bad unrelated messages do not block eligible missing-message parts in this root', () => {
  const f = fixture()
  f.session('other')
  f.message('wrong-session', 'other')
  f.db.query('UPDATE message SET data=? WHERE id=?').run('{', 'wrong-session')
  f.part('a', 'root', 'wrong-session')
  f.part('b', 'root', 'absent')
  const actual = consume(f.open())
  expect(actual.eof).toEqual(oracle(f.db).eof)
  expect(actual.steps.map((v) => v.model)).toEqual([null, null])
  expect(actual.issues).toEqual(['native-model-unavailable'])
  expect(f.calls.some((v) => v.method === 'all' && v.sql.startsWith('SELECT p.id FROM part'))).toBe(
    true,
  )
})

test('one physical report connection cannot carry a previous root key buffer or model', () => {
  const f = fixture()
  f.session('other')
  for (const root of ['root', 'other']) {
    f.message('message-' + root, root, 'model-' + root)
    for (let n = 0; n < 205; n++)
      f.part(root + '-' + String(n).padStart(4, '0'), root, 'message-' + root)
  }
  let opens = 0
  const factory = createHistoricalOpencodeUsagePassFactory(f.path, {
    pageRows: 200,
    pageBytes: 1024,
    openDatabase(path) {
      opens++
      return openReadonlySqliteDatabase(path)
    },
  })
  cleanups.push(() => factory.close())
  for (const root of ['root', 'other', 'root']) {
    const actual = consume(
      factory.open({
        kind: 'historical-observed',
        passId: 'pass-' + root,
        referenceId: 'reference-' + root,
        nativeSource: 'original',
        sourceGeneration: 'generation',
        rootSessionId: root,
      }),
      undefined,
      1024,
    )
    expect(actual.eof).toEqual(oracle(f.db, root).eof)
    expect(actual.steps).toHaveLength(205)
    expect(actual.steps.every((v) => v.id === root && v.model?.id === 'model-' + root)).toBe(true)
  }
  expect(opens).toBe(1)
})
