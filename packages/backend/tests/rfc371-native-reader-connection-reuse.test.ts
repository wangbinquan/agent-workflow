// RFC-371: reuse physical readers without sharing a root's snapshot, TEMP state or ACK.
// native-traversal-state-reuse.md also locks complete queue order and empty schema reuse.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
  type ReadonlySqliteStatement,
} from '../src/platform/persistence/sqlite/readonlySqliteDatabase'
import { createHistoricalOpencodeUsagePassFactory } from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import { opencodeNativeStoreGeneration } from '../src/modules/runtime-management/infrastructure/opencodeNativeStoreGeneration'
import type {
  HistoricalNativePassIdentity,
  HistoricalNativePassReader,
} from '../src/modules/runtime-management/application/ports/historicalNativeUsage'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function store(path: string) {
  const db = new Database(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id);`)
  let closed = false
  const close = () => {
    if (!closed) {
      closed = true
      db.close()
    }
  }
  cleanups.push(close)
  const session = (id: string, parent: string | null = null) =>
    db.query('INSERT INTO session VALUES (?,?,?)').run(id, parent, 1000)
  const message = (id: string, owner: string, model = 'original-model') =>
    db
      .query('INSERT INTO message VALUES (?,?,?)')
      .run(
        id,
        owner,
        JSON.stringify({ role: 'assistant', providerID: 'original-provider', modelID: model }),
      )
  const part = (id: string, owner: string, messageId: string, input = '11') =>
    db.query('INSERT INTO part VALUES (?,?,?,?,?)').run(
      id,
      owner,
      messageId,
      1234,
      JSON.stringify({
        type: 'step-finish',
        tokens: { input, output: 3, reasoning: 2, cache: { read: 7, write: 13 } },
        text: 'original-body-not-transported',
      }),
    )
  return { db, close, session, message, part }
}
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'aw-native-connections-')),
    path = join(folder, 'original.db')
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
  return { folder, path, writer: store(path) }
}

// Count only real readonly handles. Optional failed DROP/DELETE models cleanup failure,
// while every successful source query still runs against the original SQLite/WAL file.
function originalConnections(failDrop = false, observe = false, failBegin = false) {
  const handles: ReadonlySqliteDatabase[] = []
  const statements: string[] = []
  const preparations: string[] = []
  const counts = { opens: 0, closes: 0 }
  const open = (path: string): ReadonlySqliteDatabase => {
    const db = openReadonlySqliteDatabase(path)
    counts.opens++
    let closed = false
    const handle: ReadonlySqliteDatabase = {
      query<Row, Parameters extends readonly unknown[]>(sql: string) {
        if (observe) preparations.push(sql)
        let statement: ReadonlySqliteStatement<Row, Parameters>
        if (failBegin && sql === 'BEGIN') {
          failBegin = false
          statement = {
            get() {
              throw new Error('original-test-BEGIN-not-started')
            },
            all() {
              throw new Error('original-test-BEGIN-not-started')
            },
          }
        } else if (
          failDrop &&
          (sql.startsWith('DROP TABLE') ||
            /^DELETE FROM temp.native_pass_(queue|open_steps|message_models)$/.test(sql))
        ) {
          failDrop = false
          statement = {
            get() {
              throw new Error('original-test-TEMP-cleanup-failed')
            },
            all() {
              throw new Error('original-test-TEMP-cleanup-failed')
            },
          }
        } else statement = db.query<Row, Parameters>(sql)
        if (!observe) return statement
        return {
          get(...parameters: Parameters) {
            statements.push(sql)
            return statement.get(...parameters)
          },
          all(...parameters: Parameters) {
            statements.push(sql)
            return statement.all(...parameters)
          },
        }
      },
      close() {
        if (!closed) {
          closed = true
          db.close()
          counts.closes++
        }
      },
    }
    handles.push(handle)
    return handle
  }
  cleanups.push(() => handles.forEach((handle) => handle.close()))
  return { counts, open, handles, statements, preparations }
}
function factory(path: string, connections = originalConnections(), pageRows = 2) {
  const reader = createHistoricalOpencodeUsagePassFactory(path, {
    openDatabase: connections.open,
    pageRows,
    pageBytes: 1024,
  })
  cleanups.push(() => reader.close())
  return { reader, connections }
}
function identity(rootSessionId: string, sourceGeneration: string, pass = rootSessionId) {
  return {
    kind: 'historical-observed',
    referenceId: 'reference-' + rootSessionId,
    passId: 'pass-' + pass,
    nativeSource: 'original-file',
    sourceGeneration,
    rootSessionId,
  } satisfies HistoricalNativePassIdentity
}

// Independent original scalar SQL; the optimized reader/pool is never used as its oracle.
const fields = `SELECT p.id,p.session_id,p.message_id,p.time_created,
  json_extract(p.data,'$.type') AS kind,
  CASE WHEN json_type(p.data,'$.tokens.input') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.input') END AS input,
  CASE WHEN json_type(p.data,'$.tokens.output') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.output') END AS output,
  CASE WHEN json_type(p.data,'$.tokens.reasoning') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.reasoning') END AS reasoning,
  CASE WHEN json_type(p.data,'$.tokens.cache.read') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.read') END AS cache_read,
  CASE WHEN json_type(p.data,'$.tokens.cache.write') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.write') END AS cache_write,
  CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.providerID') END AS provider,
  CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.modelID') END AS model
  FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id`
function oracle(db: Database, rootId: string) {
  const hash = createHash('sha256'),
    root = db.query('SELECT id,parent_id,time_created FROM session WHERE id=?').get(rootId)!
  hash.update(JSON.stringify(['root', root]))
  const pending = new Map<string, string | null>([[rootId, null]])
  let sessions = 0n,
    parts = 0n,
    steps = 0n
  // These fixtures use independent roots or one child chain, so the original
  // queue's ordered child-discovery and this separate full SQL walk agree.
  while (pending.size) {
    const id = [...pending.keys()].sort()[0]!,
      parent = pending.get(id)!
    pending.delete(id)
    hash.update(JSON.stringify(['session', { id, parentSessionId: parent }]))
    sessions++
    for (const row of db
      .query<Record<string, unknown>, [string]>(fields + ' WHERE p.session_id=? ORDER BY p.id')
      .all(id)) {
      hash.update(JSON.stringify(['part', row]))
      parts++
      if (row.kind === 'step-finish') steps++
    }
    for (const child of db
      .query<
        { id: string; parent_id: string | null },
        [string]
      >('SELECT id,parent_id FROM session WHERE parent_id=? ORDER BY id')
      .all(id)) {
      hash.update(JSON.stringify(['child', child]))
      pending.set(child.id, id)
    }
  }
  return {
    fingerprint: hash.digest('hex'),
    counts: { sessions: String(sessions), parts: String(parts), steps: String(steps) },
  }
}
function consume(reader: HistoricalNativePassReader, start = reader.initialCursor) {
  let cursor: string | null = start,
    last: ReturnType<HistoricalNativePassReader['next']> | undefined
  const steps: ReturnType<HistoricalNativePassReader['next']>['steps'][number][] = []
  while (cursor !== null) {
    const page: ReturnType<HistoricalNativePassReader['next']> = reader.next(cursor)
    expect(reader.next(cursor)).toEqual(page)
    expect(JSON.stringify(page)).not.toContain('original-body-not-transported')
    expect(JSON.stringify(page)).not.toContain('cache_message')
    steps.push(...page.steps)
    reader.acknowledge(page.ordinal, page.payloadDigest)
    cursor = page.nextCursor
    last = page
  }
  return { steps, eof: last!.eof, issues: last!.issues }
}

test('one idle handle does not limit 1201 original roots or lose any scalar/EOF', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path)
  f.writer.db.transaction(() => {
    for (let n = 0; n < 1201; n++) {
      const id = 'root-' + String(n).padStart(4, '0')
      f.writer.session(id)
      f.writer.message('message-' + id, id)
      f.writer.part('part-' + id, id, 'message-' + id, String(n + 1))
    }
  })()
  const generation = (await opencodeNativeStoreGeneration(f.path))!
  let input = 0n
  for (let n = 0; n < 1201; n++) {
    const id = 'root-' + String(n).padStart(4, '0'),
      actual = consume(reader.open(identity(id, generation)))
    expect(actual.eof).toEqual(oracle(f.writer.db, id))
    expect(actual.eof?.counts).toEqual({ sessions: '1', parts: '1', steps: '1' })
    expect(actual.steps[0]!.usage).toEqual({
      input: String(n + 1),
      output: '5',
      cacheRead: '7',
      cacheWrite: '13',
    })
    expect(actual.steps[0]!.model).toEqual({ provider: 'original-provider', id: 'original-model' })
    expect(actual.issues).toEqual([])
    input += BigInt(actual.steps[0]!.usage.input!)
  }
  expect(input).toBe((1201n * 1202n) / 2n)
  expect(connections.counts).toEqual({ opens: 1, closes: 0 })
  reader.close()
  reader.close()
  expect(connections.counts).toEqual({ opens: 1, closes: 1 })
}, 30000)

test('parallel pending ACKs stay independent and a reused connection sees later WAL writes', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path)
  for (const id of ['root', 'other']) {
    f.writer.session(id)
    f.writer.message('message-' + id, id)
    f.writer.part(id + '-a', id, 'message-' + id)
  }
  f.writer.part('root-b', 'root', 'message-root')
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    before = oracle(f.writer.db, 'root'),
    first = reader.open(identity('root', generation)),
    page = first.next(first.initialCursor),
    second = reader.open(identity('other', generation))
  expect(page.steps.map((step) => step.stepId)).toEqual(['root-a'])
  expect(() => first.next(page.nextCursor!)).toThrow('awaits original owner ACK')
  expect(() => first.acknowledge('999', page.payloadDigest)).toThrow('ACK changed')
  expect(consume(second).eof).toEqual(oracle(f.writer.db, 'other'))
  f.writer.db.query('UPDATE message SET data=? WHERE id=?').run(
    JSON.stringify({
      role: 'assistant',
      providerID: 'original-provider',
      modelID: 'later-model',
    }),
    'message-root',
  )
  f.writer.part('root-c', 'root', 'message-root', '99')
  expect(await opencodeNativeStoreGeneration(f.path)).toBe(generation)
  expect(first.next(first.initialCursor)).toEqual(page)
  first.acknowledge(page.ordinal, page.payloadDigest)
  const rest = consume(first, page.nextCursor!)
  expect(rest.eof).toEqual(before)
  expect(rest.steps.map((step) => [step.stepId, step.model?.id])).toEqual([
    ['root-b', 'original-model'],
  ])
  expect(() => first.next(page.cursor)).toThrow('snapshot closed')
  const later = consume(reader.open(identity('root', generation, 'later')))
  expect(later.eof).toEqual(oracle(f.writer.db, 'root'))
  expect(later.steps.map((step) => step.model?.id)).toEqual([
    'later-model',
    'later-model',
    'later-model',
  ])
  expect(connections.counts).toEqual({ opens: 2, closes: 1 })
  reader.close()
  expect(connections.counts).toEqual({ opens: 2, closes: 2 })
})

test('early close and failed original root initialization leave no TEMP or pending state', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path)
  f.writer.session('root')
  f.writer.message('message', 'root')
  f.writer.part('part', 'root', 'message')
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    early = reader.open(identity('root', generation)),
    page = early.next(early.initialCursor)
  early.close()
  expect(() => early.next(page.cursor)).toThrow('snapshot closed')
  expect(() => early.acknowledge(page.ordinal, page.payloadDigest)).toThrow('ACK changed')
  expect(() => reader.open(identity('absent', generation))).toThrow('Native root unavailable')
  expect(() => reader.open({ ...identity('root', generation), referenceId: '' })).toThrow(
    'owner identity unavailable',
  )
  const complete = consume(reader.open(identity('root', generation, 'after-failure')))
  expect(complete.eof).toEqual(oracle(f.writer.db, 'root'))
  expect(complete.steps).toHaveLength(1)
  expect(connections.counts).toEqual({ opens: 1, closes: 0 })
})

test('late child corruption remains the original failure even when TEMP cleanup fails', async () => {
  const f = fixture(),
    connections = originalConnections(true),
    { reader } = factory(f.path, connections, 1)
  f.writer.session('root')
  f.writer.session('child', 'root')
  f.writer.message('shared', 'child')
  f.writer.part('root-part', 'root', 'shared')
  f.writer.part('child-part', 'child', 'shared')
  f.writer.db.query('UPDATE message SET data=? WHERE id=?').run('{', 'shared')
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    bad = reader.open(identity('root', generation))
  let cursor = bad.initialCursor,
    rootSeen = false,
    childSeen = false
  for (;;) {
    try {
      const page: ReturnType<HistoricalNativePassReader['next']> = bad.next(cursor)
      rootSeen ||= page.steps.some((step) => step.stepId === 'root-part' && step.model === null)
      childSeen ||= page.sessions.some((session) => session.id === 'child')
      expect(page.eof).toBeNull()
      bad.acknowledge(page.ordinal, page.payloadDigest)
      cursor = page.nextCursor!
    } catch (error) {
      expect((error as Error).message).toContain('malformed JSON')
      break
    }
  }
  expect(rootSeen).toBe(true)
  expect(childSeen).toBe(true)
  expect(connections.counts).toEqual({ opens: 1, closes: 1 })
  f.writer.db.query('UPDATE message SET data=? WHERE id=?').run(
    JSON.stringify({
      role: 'assistant',
      providerID: 'original-provider',
      modelID: 'repaired-model',
    }),
    'shared',
  )
  const after = consume(reader.open(identity('root', generation, 'repaired')))
  expect(after.eof).toEqual(oracle(f.writer.db, 'root'))
  expect(after.steps.map((step) => step.model?.id ?? null)).toEqual([null, 'repaired-model'])
  expect(connections.counts).toEqual({ opens: 2, closes: 1 })
})

test('a changed real file generation cannot reuse the stale original handle', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path)
  f.writer.session('root')
  f.writer.message('message', 'root')
  f.writer.part('part', 'root', 'message')
  const before = (await opencodeNativeStoreGeneration(f.path))!
  expect(consume(reader.open(identity('root', before))).eof).toEqual(oracle(f.writer.db, 'root'))
  // Release the actual OS file locks through the readonly test seam so replacement
  // also works on Windows. The factory still holds its stale generation/idle entry.
  connections.handles[0]!.close()
  f.writer.close()
  for (const suffix of ['', '-wal', '-shm'])
    if (existsSync(f.path + suffix)) renameSync(f.path + suffix, f.path + suffix + '.before')
  const replacement = store(f.path)
  replacement.session('root')
  replacement.message('message', 'root', 'replacement-model')
  replacement.part('new-part', 'root', 'message', '99')
  const after = (await opencodeNativeStoreGeneration(f.path))!
  expect(after).not.toBe(before)
  const actual = consume(reader.open(identity('root', after, 'replacement')))
  expect(actual.eof).toEqual(oracle(replacement.db, 'root'))
  expect(actual.steps.map((step) => [step.stepId, step.usage.input, step.model?.id])).toEqual([
    ['new-part', '99', 'replacement-model'],
  ])
  expect(connections.counts).toEqual({ opens: 2, closes: 1 })
})

test('factory shutdown invalidates every active reader and closes all physical handles', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path)
  f.writer.session('root')
  f.writer.message('message', 'root')
  f.writer.part('part', 'root', 'message')
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    first = reader.open(identity('root', generation)),
    firstPage = first.next(first.initialCursor),
    second = reader.open(identity('root', generation, 'parallel')),
    secondPage = second.next(second.initialCursor)
  reader.close()
  reader.close()
  expect(() => first.next(firstPage.cursor)).toThrow('snapshot closed')
  expect(() => second.acknowledge(secondPage.ordinal, secondPage.payloadDigest)).toThrow(
    'ACK changed',
  )
  expect(() => reader.open(identity('root', generation))).toThrow('factory closed')
  expect(connections.counts).toEqual({ opens: 2, closes: 2 })
})

test('full repeated roots reuse empty TEMP schema without a queue SELECT per part', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path, originalConnections(false, true), 1000)
  f.writer.session('root')
  f.writer.message('message', 'root')
  f.writer.db.transaction(() => {
    for (let n = 0; n < 603; n++)
      f.writer.part('part-' + String(n).padStart(4, '0'), 'root', 'message', String(n + 1))
  })()
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    expected = oracle(f.writer.db, 'root'),
    first = consume(reader.open(identity('root', generation)))
  expect(first.eof).toEqual(expected)
  expect(first.eof?.counts).toEqual({ sessions: '1', parts: '603', steps: '603' })
  expect(first.steps.map((step) => step.usage)).toEqual(
    Array.from({ length: 603 }, (_, n) => ({
      input: String(n + 1),
      output: '5',
      cacheRead: '7',
      cacheWrite: '13',
    })),
  )
  expect(
    connections.statements.filter((sql) => sql.includes('WHERE done=0 ORDER BY id LIMIT 1')).length,
  ).toBeLessThan(603)
  const handle = connections.handles[0]!,
    schema = handle.query<{ schema_version: number }, []>('PRAGMA temp.schema_version').get()!
  for (const table of ['queue', 'open_steps', 'message_models'])
    expect(
      handle.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM temp.native_pass_${table}`).get()
        ?.n,
    ).toBe(0)
  const repeated = consume(reader.open(identity('root', generation, 'repeated')))
  expect(repeated.eof).toEqual(expected)
  expect(repeated.steps).toEqual(first.steps)
  expect(handle.query<{ schema_version: number }, []>('PRAGMA temp.schema_version').get()).toEqual(
    schema,
  )
  f.writer.db
    .query("UPDATE part SET data=json_set(data,'$.tokens.input','909') WHERE id=?")
    .run('part-0000')
  const updated = consume(reader.open(identity('root', generation, 'new-snapshot')))
  expect(updated.eof).toEqual(oracle(f.writer.db, 'root'))
  expect(updated.eof).not.toEqual(expected)
  expect(updated.steps[0]!.usage.input).toBe('909')
  expect(handle.query<{ schema_version: number }, []>('PRAGMA temp.schema_version').get()).toEqual(
    schema,
  )
  expect(connections.counts).toEqual({ opens: 1, closes: 0 })
})

test('a discovered earlier child immediately retains the original queue and fingerprint order', async () => {
  const f = fixture(),
    { reader } = factory(f.path)
  for (const [id, parent] of [
    ['root', null],
    ['a-child', 'root'],
    ['b-grandchild', 'a-child'],
    ['z-child', 'root'],
  ] as const) {
    f.writer.session(id, parent)
    f.writer.message('message-' + id, id)
    f.writer.part('part-' + id, id, 'message-' + id)
  }
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify([
      'root',
      f.writer.db.query('SELECT id,parent_id,time_created FROM session WHERE id=?').get('root'),
    ]),
  )
  // Independent explicit original discovery order; collecting all siblings at once
  // would wrongly fingerprint z-child before the earlier child's descendants.
  for (const [kind, id] of [
    ['session', 'root'],
    ['part', 'part-root'],
    ['child', 'a-child'],
    ['session', 'a-child'],
    ['part', 'part-a-child'],
    ['child', 'b-grandchild'],
    ['session', 'b-grandchild'],
    ['part', 'part-b-grandchild'],
    ['child', 'z-child'],
    ['session', 'z-child'],
    ['part', 'part-z-child'],
  ] as const) {
    if (kind === 'part') {
      hash.update(JSON.stringify([kind, f.writer.db.query(fields + ' WHERE p.id=?').get(id)]))
      continue
    }
    const row = f.writer.db
      .query<
        { id: string; parent_id: string | null },
        [string]
      >('SELECT id,parent_id FROM session WHERE id=?')
      .get(id)!
    hash.update(
      JSON.stringify([
        kind,
        kind === 'session' ? { id: row.id, parentSessionId: row.parent_id } : row,
      ]),
    )
  }
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    actual = consume(reader.open(identity('root', generation)))
  expect(actual.eof).toEqual({
    fingerprint: hash.digest('hex'),
    counts: { sessions: '4', parts: '4', steps: '4' },
  })
  expect(actual.steps.map((step) => step.stepId)).toEqual([
    'part-root',
    'part-a-child',
    'part-b-grandchild',
    'part-z-child',
  ])
  expect(actual.issues).toEqual([])
})

test('successful EOF with failed DELETE cleanup discards the handle before another root', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path, originalConnections(true, true))
  f.writer.session('root')
  f.writer.message('message', 'root')
  f.writer.part('part', 'root', 'message')
  const generation = (await opencodeNativeStoreGeneration(f.path))!
  expect(consume(reader.open(identity('root', generation))).eof).toEqual(
    oracle(f.writer.db, 'root'),
  )
  expect(connections.statements).toContain('DELETE FROM temp.native_pass_open_steps')
  expect(connections.counts).toEqual({ opens: 1, closes: 1 })
  expect(consume(reader.open(identity('root', generation, 'after-cleanup-failure'))).eof).toEqual(
    oracle(f.writer.db, 'root'),
  )
  expect(connections.counts).toEqual({ opens: 2, closes: 1 })
})

test('a BEGIN failure before TEMP initialization preserves the original reusable handle', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path, originalConnections(false, true, true))
  f.writer.session('root')
  f.writer.message('message', 'root')
  f.writer.part('part', 'root', 'message')
  const generation = (await opencodeNativeStoreGeneration(f.path))!
  expect(() => reader.open(identity('root', generation, 'failed-BEGIN'))).toThrow(
    'original-test-BEGIN-not-started',
  )
  expect(connections.counts).toEqual({ opens: 1, closes: 0 })
  expect(connections.statements).toContain('DROP TABLE IF EXISTS temp.native_pass_queue')
  expect(connections.statements).not.toContain('DELETE FROM temp.native_pass_queue')
  expect(consume(reader.open(identity('root', generation, 'after-failed-BEGIN'))).eof).toEqual(
    oracle(f.writer.db, 'root'),
  )
  expect(connections.counts).toEqual({ opens: 1, closes: 0 })
})

test('the same real connection reuses compiled SQL while every root binds and reads fresh data', async () => {
  const f = fixture(),
    { reader, connections } = factory(f.path, originalConnections(false, true))
  f.writer.session('root')
  f.writer.session('child', 'root')
  f.writer.session('other-root')
  for (const [id, input] of [
    ['root', '11'],
    ['child', '31'],
    ['other-root', '73'],
  ] as const) {
    f.writer.message('message-' + id, id)
    for (let n = 0; n < 5; n++) f.writer.part('part-' + id + '-' + n, id, 'message-' + id, input)
  }
  const generation = (await opencodeNativeStoreGeneration(f.path))!,
    expected = oracle(f.writer.db, 'root'),
    first = consume(reader.open(identity('root', generation))),
    preparedCount = connections.preparations.length,
    executedCount = connections.statements.length
  expect(first.eof).toEqual(expected)
  expect(new Set(connections.preparations).size).toBeGreaterThan(20)
  expect(consume(reader.open(identity('root', generation, 'repeated')))).toEqual(first)
  expect(connections.preparations.length).toBe(preparedCount)
  expect(connections.statements.length).toBeGreaterThan(executedCount)
  const other = consume(reader.open(identity('other-root', generation)))
  expect(other.eof).toEqual(oracle(f.writer.db, 'other-root'))
  expect(other.steps).toHaveLength(5)
  expect(other.steps.map((step) => step.usage)).toEqual(
    Array.from({ length: 5 }, () => ({
      input: '73',
      output: '5',
      cacheRead: '7',
      cacheWrite: '13',
    })),
  )
  expect(connections.preparations.length).toBe(preparedCount)
  expect(connections.counts).toEqual({ opens: 1, closes: 0 })
})
