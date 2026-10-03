// Real original SQLite, beyond every v1 population bound. This is the v2 reader foundation;
// owner persistence, emission allocation and production switching are separate required gates.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openOpencodeUsagePass } from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import { readOpencodeUsageSnapshot } from '../src/modules/runtime-management/infrastructure/opencodeUsageSnapshot'
import { openNativeUsagePassWorker } from '../src/platform/background/nativeUsagePassWorkerHost'
import type {
  NativeUsagePassIdentity,
  NativeUsagePassPage,
  NativeUsagePassReader,
} from '../src/modules/runtime-management/application/ports/nativeUsagePass'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const identity: NativeUsagePassIdentity = {
  passId: 'owner-pass',
  invocationId: 'accepted-call',
  nativeSource: 'actual-native-store',
  sourceGeneration: 'owner-generation',
  rootSessionId: 'root',
  lineage: 'original-lineage',
  epoch: 'owner-epoch',
  phase: 'baseline',
}
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'aw-native-pass-')),
    path = join(folder, 'native.db')
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const db = new Database(path)
  cleanup.push(() => db.close())
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY,parent_id TEXT); CREATE INDEX session_parent ON session(parent_id,id);
    CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,id);`)
  const session = (id: string, parent: string | null = null) =>
    db.query('INSERT INTO session VALUES (?,?)').run(id, parent)
  const part = (id: string, sessionId: string, kind: string, input: unknown = 11) => {
    const messageId = 'message-' + id
    db.query('INSERT INTO message VALUES (?,?,?)').run(
      messageId,
      sessionId,
      JSON.stringify({ role: 'assistant', providerID: 'provider', modelID: 'model' }),
    )
    db.query('INSERT INTO part VALUES (?,?,?,?,?)').run(
      id,
      sessionId,
      messageId,
      1234,
      JSON.stringify({
        type: kind,
        tokens: { input, output: 3, reasoning: 2, cache: { read: 7, write: 13 } },
        text: 'body-does-not-leave-native-db',
      }),
    )
  }
  session('root')
  let pass = 0
  const open = (pageRows = 200, pageBytes = 256 * 1024) => {
    const reader = openOpencodeUsagePass(
      path,
      { ...identity, passId: identity.passId + String(++pass) },
      { pageRows, pageBytes },
    )
    cleanup.push(() => reader.close())
    return reader
  }
  return { path, db, session, part, open }
}
function consume(reader: NativeUsagePassReader, visit: (page: NativeUsagePassPage) => void) {
  let cursor: string | null = reader.initialCursor,
    last: NativeUsagePassPage | undefined
  while (cursor !== null) {
    const page = reader.next(cursor)
    visit(page)
    expect(page.cursor).toBe(cursor)
    if (page.nextCursor !== null) {
      expect(page.scanPositionAfter).not.toBe(page.scanPositionBefore)
      expect(BigInt(page.scannedRawRows)).toBeGreaterThan(0n)
      expect(page.eof).toBeNull()
    }
    reader.acknowledge(page.ordinal, page.payloadDigest)
    cursor = page.nextCursor
    last = page
  }
  return last!
}

test('native pass reaches every original part, 10001 steps, 1025 sessions and depth 80 without a subtotal', () => {
  const f = fixture()
  f.db.transaction(() => {
    for (let n = 0; n < 50001; n++) f.part('a-' + String(n).padStart(6, '0'), 'root', 'text')
    for (let n = 0; n < 10001; n++)
      f.part('z-' + String(n).padStart(6, '0'), 'root', 'step-finish', String(n + 1))
    for (let n = 1; n <= 1024; n++)
      f.session(
        'child-' + String(n).padStart(4, '0'),
        n <= 80 ? (n === 1 ? 'root' : 'child-' + String(n - 1).padStart(4, '0')) : 'root',
      )
    f.session('unrelated')
    f.part('outside', 'unrelated', 'step-finish', 999999)
  })()
  let seen = 0n,
    sum = 0n,
    nonNumericContinuations = 0,
    lastOrdinal = -1n
  const ids = new Set<string>(),
    sessions = new Map<string, string | null>()
  const last = consume(f.open(), (page) => {
    expect(BigInt(page.ordinal)).toBe(lastOrdinal + 1n)
    lastOrdinal = BigInt(page.ordinal)
    if (!page.steps.length && page.nextCursor !== null) nonNumericContinuations++
    for (const session of page.sessions) {
      expect(sessions.has(session.id)).toBe(false)
      sessions.set(session.id, session.parentSessionId)
    }
    for (const step of page.steps) {
      expect(ids.has(step.stepId)).toBe(false)
      ids.add(step.stepId)
      seen++
      sum += BigInt(step.usage.input!)
      expect(step.usage).toEqual({
        input: step.usage.input,
        output: '5',
        cacheRead: '7',
        cacheWrite: '13',
      })
      expect(step.model).toEqual({ provider: 'provider', id: 'model' })
      expect(step.occurredAt).toBe(1234)
      expect(JSON.stringify(step)).not.toContain('body-does-not-leave-native-db')
    }
  })
  expect(seen).toBe(10001n)
  expect(sum).toBe((10001n * 10002n) / 2n)
  expect(sessions.size).toBe(1025)
  expect(sessions.get('child-0080')).toBe('child-0079')
  expect(sessions.has('unrelated')).toBe(false)
  expect(nonNumericContinuations).toBeGreaterThan(100)
  expect(last.eof?.counts).toEqual({ sessions: '1025', parts: '60002', steps: '10001' })
  expect(last.issues).toEqual([])
  expect(last.eof?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
}, 60000)

test('one frozen page requires owner ACK, retries exact bytes, and keeps the original native snapshot', () => {
  const f = fixture()
  f.part('before', 'root', 'step-finish')
  const reader = f.open(1),
    first = reader.next(reader.initialCursor)
  expect(first.nextCursor).not.toBeNull()
  expect(first.eof).toBeNull()
  expect(reader.next(reader.initialCursor)).toEqual(first)
  expect(() => reader.next(first.nextCursor!)).toThrow('awaits original owner ACK')
  expect(() => reader.acknowledge(first.ordinal, 'wrong')).toThrow('changed frozen page')
  const changed = structuredClone(first) as unknown as { sessions: Array<{ id: string }> }
  changed.sessions[0]!.id = 'changed'
  expect(reader.next(reader.initialCursor)).toEqual(first)
  f.part('later', 'root', 'step-finish', 9000)
  reader.acknowledge(first.ordinal, first.payloadDigest)
  const rest: string[] = []
  const final = consume(
    {
      identity: reader.identity,
      initialCursor: first.nextCursor!,
      next: reader.next,
      acknowledge: reader.acknowledge,
      close: reader.close,
    },
    (page) => {
      rest.push(...page.steps.map((s) => s.stepId))
    },
  )
  expect(rest).toEqual(['before'])
  expect(final.eof?.counts.parts).toBe('1')
  expect(() => reader.next(first.cursor)).toThrow('snapshot closed')
  const newer: string[] = []
  consume(f.open(), (page) => newer.push(...page.steps.map((s) => s.stepId)))
  expect(newer).toEqual(['before', 'later'])
})

test('packet byte bounds and scan page size preserve the same EOF fingerprint and exact four buckets', () => {
  const f = fixture()
  for (let n = 0; n < 101; n++)
    f.part(String(n).padStart(4, '0'), 'root', 'step-finish', String(n + 1))
  const run = (rows: number, bytes: number) => {
    let sum = 0n,
      steps = 0
    const final = consume(f.open(rows, bytes), (page) => {
      const payload = page.sessions
        .map((s) => JSON.stringify(s))
        .concat(page.steps.map((s) => JSON.stringify(s)))
      expect(payload.reduce((n, s) => n + Buffer.byteLength(s), 0)).toBeLessThanOrEqual(bytes)
      for (const step of page.steps) {
        sum += BigInt(step.usage.input!)
        steps++
      }
    })
    return { sum, steps, eof: final.eof }
  }
  expect(run(2, 1024)).toEqual(run(1000, 1024))
})

test('unavailable roots, interrupted passes, malformed originals and tree cycles cannot claim ready', () => {
  const f = fixture()
  expect(() => openOpencodeUsagePass(f.path, { ...identity, rootSessionId: 'missing' })).toThrow(
    'root unavailable',
  )
  f.session('child', 'root')
  f.db.query('UPDATE session SET parent_id=? WHERE id=?').run('child', 'root')
  const cycle = consume(f.open(1), () => {})
  expect(cycle.issues).toContain('native-tree-conflict')
  const reader = f.open(1),
    page = reader.next(reader.initialCursor)
  reader.close()
  expect(page.eof).toBeNull()
  expect(() => reader.acknowledge(page.ordinal, page.payloadDigest)).toThrow()
  expect(() => reader.next(page.cursor)).toThrow('snapshot closed')
  f.db
    .query('INSERT INTO part VALUES (?,?,?,?,?)')
    .run('broken', 'root', 'broken', 1234, 'not-json')
  const broken = f.open()
  expect(() => consume(broken, () => {})).toThrow()
})

test('unknown numeric metadata stays explicit at EOF and an open step retains its issue across packet boundaries', () => {
  const f = fixture()
  f.part('a', 'root', 'step-start')
  f.part('b', 'root', 'step-finish', 'unknown')
  const steps: NativeUsagePassPage['steps'][number][] = []
  const final = consume(f.open(1), (page) => steps.push(...page.steps))
  expect(final.eof?.counts.steps).toBe('1')
  expect(steps[0]?.usage.input).toBeNull()
  expect(final.issues).toContain('native-token-bucket-unknown')
  expect(final.issues).toContain('native-step-unfinished')
})

test('JSON booleans, nulls and composite buckets preserve the original unknown semantics instead of becoming zero or one', () => {
  const f = fixture()
  for (const [n, input] of [
    false,
    true,
    null,
    [],
    {},
    0.5,
    -1,
    'unknown',
    0,
    '0',
    '9007199254740993',
  ].entries())
    f.part(String(n).padStart(2, '0'), 'root', 'step-finish', input)
  f.part('all-booleans', 'root', 'step-finish')
  f.db.query('UPDATE part SET data=? WHERE id=?').run(
    JSON.stringify({
      type: 'step-finish',
      tokens: {
        input: false,
        output: true,
        reasoning: false,
        cache: { read: true, write: false },
      },
    }),
    'all-booleans',
  )
  const original = readOpencodeUsageSnapshot(f.path, 'root')
  expect(original.fingerprint).not.toBeNull()
  const values = new Map<string, NativeUsagePassPage['steps'][number]>()
  const final = consume(f.open(1), (page) => {
    for (const step of page.steps) values.set(step.stepId, step)
  })
  for (const step of original.steps) expect(values.get(step.id)?.usage).toEqual(step.usage)
  for (const n of ['00', '01', '02', '03', '04', '05', '06', '07'])
    expect(values.get(n)?.usage.input).toBeNull()
  expect(values.get('08')?.usage.input).toBe('0')
  expect(values.get('09')?.usage.input).toBe('0')
  expect(values.get('10')?.usage.input).toBe('9007199254740993')
  expect(values.get('all-booleans')?.usage).toEqual({
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
  })
  expect(final.issues).toContain('native-token-bucket-unknown')
})

test('a real native Worker keeps EOF behind the original owner ACK and closes after cancellation', async () => {
  const f = fixture()
  f.part('first', 'root', 'step-finish', '9007199254740993')
  const abort = new AbortController()
  const reader = await openNativeUsagePassWorker(
    { path: f.path, identity: { ...identity, passId: 'worker-pass' }, pageRows: 1 },
    abort.signal,
  )
  try {
    const first = await reader.next(reader.initialCursor)
    expect(first.eof).toBeNull()
    expect(await reader.next(first.cursor)).toEqual(first)
    await reader.acknowledge(first.ordinal, first.payloadDigest)
    let cursor: string | null = first.nextCursor,
      seen = 0,
      last: NativeUsagePassPage | undefined
    while (cursor !== null) {
      const page = await reader.next(cursor)
      for (const step of page.steps) {
        seen++
        expect(step.usage.input).toBe('9007199254740993')
      }
      await reader.acknowledge(page.ordinal, page.payloadDigest)
      last = page
      cursor = page.nextCursor
    }
    expect(seen).toBe(1)
    expect(last?.eof?.counts).toEqual({ sessions: '1', parts: '1', steps: '1' })
  } finally {
    await reader.close()
  }
  const interrupted = await openNativeUsagePassWorker(
    { path: f.path, identity: { ...identity, passId: 'interrupted-worker' }, pageRows: 1 },
    abort.signal,
  )
  const page = await interrupted.next(interrupted.initialCursor)
  expect(page.eof).toBeNull()
  abort.abort(new Error('original owner cancelled'))
  await expect(interrupted.acknowledge(page.ordinal, page.payloadDigest)).rejects.toThrow()
  await interrupted.close()
  const unavailable = new AbortController()
  await expect(
    openNativeUsagePassWorker(
      {
        path: f.path,
        identity: { ...identity, rootSessionId: 'missing', passId: 'missing-worker' },
      },
      unavailable.signal,
    ),
  ).rejects.toThrow('root unavailable')
}, 30000)
