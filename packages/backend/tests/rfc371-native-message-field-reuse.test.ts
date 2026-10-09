// RFC-371: message-field reuse must preserve every original SQL scalar and fingerprint,
// including non-step parts, NULL models, late corruption and the original reader snapshot.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openOpencodeUsagePass,
  openHistoricalOpencodeUsagePass,
} from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import type { NativeUsagePassStep } from '../src/modules/runtime-management/application/ports/nativeUsagePass'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
type Reader =
  | ReturnType<typeof openOpencodeUsagePass>
  | ReturnType<typeof openHistoricalOpencodeUsagePass>
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

// The complete original projection is deliberately independent of the optimized reader.
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

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'aw-native-message-fields-')),
    path = join(folder, 'original.db'),
    db = new Database(path)
  cleanups.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => db.close(),
  )
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id);`)
  const session = (id: string, parent: string | null = null) =>
    db.query('INSERT INTO session VALUES (?,?,?)').run(id, parent, 1000)
  const message = (id: string, sessionId: string, value: unknown) =>
    db.query('INSERT INTO message VALUES (?,?,?)').run(id, sessionId, JSON.stringify(value))
  const part = (
    id: string,
    sessionId: string,
    messageId: string,
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
        text: 'original-body-never-enters-a-page',
      }),
    )
  session('root')
  let pass = 0
  const open = (
    kind: 'baseline' | 'final' | 'historical' = 'historical',
    rows = 200,
    bytes = 256 * 1024,
  ): Reader => {
    const identity = {
      passId: 'pass-' + ++pass,
      nativeSource: 'original-file',
      sourceGeneration: 'original-generation',
      rootSessionId: 'root',
    }
    const reader =
      kind === 'historical'
        ? openHistoricalOpencodeUsagePass(
            path,
            { ...identity, kind: 'historical-observed', referenceId: 'historical-root' },
            { pageRows: rows, pageBytes: bytes },
          )
        : openOpencodeUsagePass(
            path,
            {
              ...identity,
              phase: kind,
              invocationId: 'accepted',
              lineage: 'lineage',
              epoch: 'epoch',
            },
            { pageRows: rows, pageBytes: bytes },
          )
    cleanups.push(() => reader.close())
    return reader
  }
  return { db, path, session, message, part, open }
}
function originalOracle(db: Database) {
  const fingerprint = createHash('sha256'),
    root = db
      .query<
        { id: string; parent_id: string | null; time_created: number },
        [string]
      >('SELECT id,parent_id,time_created FROM session WHERE id=?')
      .get('root')!
  fingerprint.update(JSON.stringify(['root', root]))
  const pending = new Map<string, string | null>([['root', null]]),
    visited = new Set<string>()
  let sessions = 0n,
    parts = 0n,
    steps = 0n
  while (pending.size) {
    const id = [...pending.keys()].sort()[0]!,
      parent = pending.get(id)!
    pending.delete(id)
    visited.add(id)
    fingerprint.update(JSON.stringify(['session', { id, parentSessionId: parent }]))
    sessions++
    for (const row of db
      .query<RawPart, [string]>(originalFields + ' WHERE p.session_id=? ORDER BY p.id')
      .all(id)) {
      fingerprint.update(JSON.stringify(['part', row]))
      parts++
      if (row.kind === 'step-finish') steps++
    }
    for (const child of db
      .query<
        { id: string; parent_id: string | null },
        [string]
      >('SELECT id,parent_id FROM session WHERE parent_id=? ORDER BY id')
      .all(id)) {
      fingerprint.update(JSON.stringify(['child', child]))
      if (!visited.has(child.id)) pending.set(child.id, id)
    }
  }
  return {
    fingerprint: fingerprint.digest('hex'),
    counts: { sessions: String(sessions), parts: String(parts), steps: String(steps) },
  }
}
function consume(reader: Reader, initial = reader.initialCursor, maxBytes = 256 * 1024) {
  let cursor: string | null = initial,
    last: ReturnType<Reader['next']> | undefined
  const steps: NativeUsagePassStep[] = []
  while (cursor !== null) {
    const page: ReturnType<Reader['next']> = reader.next(cursor)
    expect(reader.next(cursor)).toEqual(page)
    expect(page.cursor).toBe(cursor)
    expect(JSON.stringify(page)).not.toContain('cache_message')
    expect(JSON.stringify(page)).not.toContain('original-body-never-enters-a-page')
    const payloadBytes =
      page.sessions.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) +
      page.steps.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
    expect(payloadBytes).toBeLessThanOrEqual(maxBytes)
    steps.push(...page.steps)
    reader.acknowledge(page.ordinal, page.payloadDigest)
    cursor = page.nextCursor
    last = page
  }
  return { steps, eof: last!.eof, issues: last!.issues }
}
const model = { role: 'assistant', providerID: 'original-provider', modelID: 'original-model' }

test('all original scalars and the whole descendant fingerprint survive repeated message reuse beyond 1200 parts', () => {
  const f = fixture(),
    bigInput = '9007199254740993000'
  f.db.transaction(() => {
    f.session('child', 'root')
    f.session('grandchild', 'child')
    f.message('shared', 'root', model)
    f.message('user', 'root', { ...model, role: 'user' })
    f.message('invalid', 'root', {
      role: 'assistant',
      providerID: 17,
      modelID: { id: 'not-a-string' },
    })
    f.message('child-model', 'child', model)
    f.message('grandchild-model', 'grandchild', model)
    for (let n = 0; n < 1201; n++)
      f.part('a-' + String(n).padStart(4, '0'), 'root', 'shared', 'text')
    for (let n = 0; n < 4; n++)
      f.part('b-' + n, 'root', 'shared', 'step-finish', n === 0 ? bigInput : 11)
    for (const [id, message] of [
      ['user-step', 'user'],
      ['invalid-step', 'invalid'],
      ['missing-step', 'absent'],
      ['wrong-session-step', 'child-model'],
    ])
      f.part(id!, 'root', message!)
    f.part('child-step', 'child', 'child-model')
    f.part('grandchild-step', 'grandchild', 'grandchild-model')
  })()
  const oracle = originalOracle(f.db)
  expect(oracle.counts).toEqual({ sessions: '3', parts: '1211', steps: '10' })
  for (const [rows, bytes] of [
    [1, 1024],
    [200, 1024],
    [1000, 256 * 1024],
  ]) {
    const actual = consume(f.open('historical', rows, bytes), undefined, bytes)
    expect(actual.eof).toEqual(oracle)
    expect(actual.steps).toHaveLength(10)
    expect(actual.steps.reduce((sum, step) => sum + BigInt(step.usage.input!), 0n)).toBe(
      BigInt(bigInput) + 99n,
    )
    expect(actual.steps.reduce((sum, step) => sum + BigInt(step.usage.output!), 0n)).toBe(50n)
    expect(actual.steps.reduce((sum, step) => sum + BigInt(step.usage.cacheRead!), 0n)).toBe(70n)
    expect(actual.steps.reduce((sum, step) => sum + BigInt(step.usage.cacheWrite!), 0n)).toBe(130n)
    for (const step of actual.steps) {
      expect(step.model).toEqual(
        ['user-step', 'invalid-step', 'missing-step', 'wrong-session-step'].includes(step.stepId)
          ? null
          : { provider: 'original-provider', id: 'original-model' },
      )
    }
    expect(actual.issues).toEqual(['native-model-unavailable'])
  }
}, 30000)

test('baseline and final reach every distinct cached message without a message population cap', () => {
  const f = fixture()
  f.db.transaction(() => {
    for (let n = 0; n < 1201; n++) {
      const id = String(n).padStart(4, '0')
      f.message('message-' + id, 'root', { ...model, modelID: 'model-' + id })
      f.part(id + '-a', 'root', 'message-' + id, 'text')
      f.part(id + '-b', 'root', 'message-' + id)
    }
  })()
  const oracle = originalOracle(f.db)
  for (const kind of ['baseline', 'final'] as const) {
    const actual = consume(f.open(kind))
    expect(actual.eof).toEqual(oracle)
    expect(actual.eof?.counts).toEqual({ sessions: '1', parts: '2402', steps: '1201' })
    expect(actual.steps.map((step) => step.model?.id)).toEqual(
      Array.from({ length: 1201 }, (_, n) => 'model-' + String(n).padStart(4, '0')),
    )
    expect(actual.issues).toEqual([])
  }
}, 30000)

test('cached model fields stay in the original snapshot and a new reader sees later writes', () => {
  const f = fixture()
  f.message('shared', 'root', model)
  f.part('a', 'root', 'shared')
  f.part('b', 'root', 'shared')
  const before = originalOracle(f.db),
    reader = f.open('historical', 2),
    first = reader.next(reader.initialCursor)
  expect(first.steps.map((step) => step.stepId)).toEqual(['a'])
  expect(() => reader.next(first.nextCursor!)).toThrow('awaits original owner ACK')
  f.db
    .query('UPDATE message SET data=? WHERE id=?')
    .run(JSON.stringify({ ...model, modelID: 'later-model' }), 'shared')
  f.part('c', 'root', 'shared')
  expect(reader.next(reader.initialCursor)).toEqual(first)
  reader.acknowledge(first.ordinal, first.payloadDigest)
  const rest = consume(reader, first.nextCursor!)
  expect(rest.eof).toEqual(before)
  expect(rest.steps.map((step) => [step.stepId, step.model?.id])).toEqual([['b', 'original-model']])
  expect(() => reader.next(first.cursor)).toThrow('snapshot closed')
  const after = consume(f.open('historical', 1))
  expect(after.eof).toEqual(originalOracle(f.db))
  expect(after.steps.map((step) => [step.stepId, step.model?.id])).toEqual([
    ['a', 'later-model'],
    ['b', 'later-model'],
    ['c', 'later-model'],
  ])
})

test('a cached missing model in one session cannot mask corrupt JSON in its original child session', () => {
  const f = fixture()
  f.session('child', 'root')
  f.message('shared', 'child', model)
  f.db.query('UPDATE message SET data=? WHERE id=?').run('{', 'shared')
  f.part('root-part', 'root', 'shared')
  f.part('child-part', 'child', 'shared')
  const reader = f.open('historical', 1)
  let cursor = reader.initialCursor,
    rootSeen = false,
    childSeen = false
  for (;;) {
    try {
      const page = reader.next(cursor)
      rootSeen ||= page.steps.some((step) => step.stepId === 'root-part' && step.model === null)
      childSeen ||= page.sessions.some((session) => session.id === 'child')
      expect(page.eof).toBeNull()
      reader.acknowledge(page.ordinal, page.payloadDigest)
      expect(page.nextCursor).not.toBeNull()
      cursor = page.nextCursor!
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('malformed JSON')
      break
    }
  }
  expect(rootSeen).toBe(true)
  expect(childSeen).toBe(true)
  expect(() => reader.next(cursor)).toThrow('snapshot closed')
})
