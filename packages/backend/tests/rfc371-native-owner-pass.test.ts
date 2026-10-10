// RFC-371: page persistence must precede ACK, and every original row must survive beyond legacy caps.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ObservationNativePassPageSchema,
  ObservationNativePassAckSchema,
  type ObservationNativePassAck,
} from '@agent-workflow/shared'
import { openOpencodeUsagePass } from '@/modules/runtime-management/infrastructure/opencodeUsagePass'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import type {
  NativeUsagePassOwner,
  AsyncNativeUsagePassReader,
} from '@/modules/runtime-management/application/ports/nativeUsageOwner'
import type { NativeUsagePassPage } from '@/modules/runtime-management/application/ports/nativeUsagePass'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const identity = {
  rootSessionId: 'root',
  passId: 'pass',
  invocationId: 'invocation',
  nativeSource: 'native',
  sourceGeneration: 'generation',
  lineage: 'lineage',
  epoch: 'epoch',
  phase: 'final' as const,
}
function fixture(steps = 1, noise = 0, sessions = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'native-owner-pass-'))
  directories.push(dir)
  const path = join(dir, 'native.sqlite'),
    db = new Database(path)
  db.run(`CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT);
    CREATE INDEX session_parent ON session(parent_id,id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,id);`)
  db.transaction(() => {
    db.run('INSERT INTO session VALUES (?,?)', ['root', null])
    for (let i = 1; i < sessions; i++)
      db.run('INSERT INTO session VALUES (?,?)', [
        'child-' + String(i).padStart(6, '0'),
        i === 1 || i > 80 ? 'root' : 'child-' + String(i - 1).padStart(6, '0'),
      ])
    for (let i = 0; i < steps; i++) {
      const id = String(i).padStart(8, '0')
      db.run('INSERT INTO message VALUES (?,?,?)', [
        'm-' + id,
        'root',
        JSON.stringify({ role: 'assistant', providerID: 'provider', modelID: 'model' }),
      ])
      for (const [suffix, type] of [
        ['a', 'step-start'],
        ['b', 'step-finish'],
      ])
        db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
          id + suffix,
          'root',
          'm-' + id,
          1000,
          JSON.stringify({
            type,
            tokens: { input: 3, output: 5, reasoning: 2, cache: { read: 7, write: 11 } },
          }),
        ])
    }
    for (let i = 0; i < noise; i++)
      db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
        'z-' + String(i).padStart(8, '0'),
        'root',
        'other',
        1000,
        JSON.stringify({ type: 'text', text: 'body is not numeric evidence' }),
      ])
  })()
  db.close()
  return { dir, path }
}
function receipt(page: NativeUsagePassPage): ObservationNativePassAck {
  return {
    contract: 'native-usage-page-ack-v2',
    identity: page.identity,
    ownerReceiptId: 'original-owner',
    ordinal: page.ordinal,
    payloadDigest: page.payloadDigest,
    cumulativeDigest: page.cumulativeDigest,
    scanPositionAfter: page.scanPositionAfter,
    counts: page.counts,
    nextCursor: page.nextCursor,
    sourceWatermark: page.ordinal,
    eof: page.eof,
  }
}
function observedReader(path: string) {
  const reader = openOpencodeUsagePass(path, identity, { pageRows: 200 })
  let reads = 0,
    acks = 0,
    closed = false
  const port: AsyncNativeUsagePassReader = {
    identity: reader.identity,
    initialCursor: reader.initialCursor,
    rootCreatedAt: reader.rootCreatedAt,
    async next(cursor) {
      reads++
      return reader.next(cursor)
    },
    async acknowledge(ordinal, digest) {
      acks++
      reader.acknowledge(ordinal, digest)
    },
    async close() {
      closed = true
      reader.close()
    },
  }
  return { port, state: () => ({ reads, acks, closed }) }
}
function durableTestOwner(
  dir: string,
  change: (ack: ObservationNativePassAck) => ObservationNativePassAck = (ack) => ack,
) {
  const db = new Database(join(dir, 'pages.sqlite'))
  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA synchronous=FULL')
  db.run('CREATE TABLE pages(ordinal TEXT PRIMARY KEY,digest TEXT,payload TEXT)')
  const interruptions: string[] = []
  const port: NativeUsagePassOwner = {
    async admit(binding, initialCursor) {
      return {
        identity: binding,
        initialCursor,
        ownerReceiptId: 'original-owner',
        sourceWatermark: '0',
      }
    },
    async persist(page) {
      db.transaction(() =>
        db.run('INSERT INTO pages VALUES (?,?,?)', [
          page.ordinal,
          page.payloadDigest,
          JSON.stringify(page),
        ]),
      )()
      return change(receipt(page))
    },
    async interrupt(_binding, reason) {
      interruptions.push(reason)
    },
  }
  return { db, port, interruptions }
}

test('streams every original numeric and parent identity beyond all legacy totals through durable pages', async () => {
  const { dir, path } = fixture(12001, 40010, 1073),
    reader = observedReader(path),
    owner = durableTestOwner(dir)
  try {
    const done = await persistNativeUsagePass(reader.port, owner.port)
    expect(done.eof?.counts).toEqual({ sessions: '1073', parts: '64012', steps: '12001' })
    expect(reader.state()).toEqual({
      reads: Number(done.ordinal) + 1,
      acks: Number(done.ordinal) + 1,
      closed: true,
    })
    expect(owner.interruptions).toEqual([])
    const totals = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
    const steps = new Set<string>(),
      parents = new Map<string, string | null>()
    const pages = owner.db
      .query<{ payload: string }, []>('SELECT payload FROM pages ORDER BY length(ordinal),ordinal')
      .all()
    for (const { payload } of pages) {
      const page = ObservationNativePassPageSchema.parse(JSON.parse(payload))
      expect(page.sessions.length + page.steps.length).toBeLessThanOrEqual(200)
      for (const row of page.sessions) {
        expect(parents.has(row.id)).toBe(false)
        parents.set(row.id, row.parentSessionId)
      }
      for (const row of page.steps) {
        expect(steps.has(row.stepId)).toBe(false)
        steps.add(row.stepId)
        for (const bucket of Object.keys(totals) as (keyof typeof totals)[])
          totals[bucket] += BigInt(row.usage[bucket]!)
      }
    }
    expect(steps.size).toBe(12001)
    expect(parents.size).toBe(1073)
    for (let i = 0; i < 12001; i++) expect(steps.has(String(i).padStart(8, '0') + 'b')).toBe(true)
    for (let i = 1; i < 1073; i++)
      expect(parents.get('child-' + String(i).padStart(6, '0'))).toBe(
        i === 1 || i > 80 ? 'root' : 'child-' + String(i - 1).padStart(6, '0'),
      )
    expect(totals).toEqual({
      input: 36003n,
      cacheRead: 84007n,
      cacheWrite: 132011n,
      output: 84007n,
    })
  } finally {
    owner.db.close()
  }
}, 60000)

test('a failed or changed original-owner ACK never releases a page or reads its successor', async () => {
  const { dir, path } = fixture(200)
  for (const patch of [
    { ownerReceiptId: 'other' },
    { ordinal: '9' },
    { payloadDigest: 'f'.repeat(64) },
    { cumulativeDigest: 'f'.repeat(64) },
    { scanPositionAfter: '1' },
    { counts: { sessions: '10001', parts: '0', steps: '0' } },
    { nextCursor: 'changed' },
    { identity: { ...identity, passId: 'other' } },
    { sourceWatermark: '-1' },
  ]) {
    const reader = observedReader(path),
      owner = durableTestOwner(mkdtempSync(join(dir, 'ack-owner-')), (ack) => ({
        ...ack,
        ...patch,
      }))
    try {
      await expect(persistNativeUsagePass(reader.port, owner.port)).rejects.toThrow()
      expect(reader.state()).toEqual({ reads: 1, acks: 0, closed: true })
      expect(owner.db.query<{ n: number }, []>('SELECT count(*) n FROM pages').get()?.n).toBe(1)
      expect(owner.interruptions).toHaveLength(1)
    } finally {
      owner.db.close()
    }
  }
})

test('persistence rollback, interrupted admission and unavailable interruption remain failures and close the snapshot', async () => {
  for (const stage of ['admit', 'persist', 'interrupt']) {
    const { dir, path } = fixture(200),
      reader = observedReader(path),
      owner = durableTestOwner(dir)
    if (stage === 'admit')
      owner.port.admit = async () => {
        throw new Error('admission rejected')
      }
    else
      owner.port.persist = async () => {
        throw new Error('transaction rolled back')
      }
    if (stage === 'interrupt')
      owner.port.interrupt = async () => {
        throw new Error('disk unavailable')
      }
    try {
      await expect(persistNativeUsagePass(reader.port, owner.port)).rejects.toThrow(
        stage === 'interrupt'
          ? 'failure could not be recorded'
          : stage === 'admit'
            ? 'admission rejected'
            : 'transaction rolled back',
      )
      expect(reader.state()).toEqual({ reads: stage === 'admit' ? 0 : 1, acks: 0, closed: true })
      expect(owner.db.query<{ n: number }, []>('SELECT count(*) n FROM pages').get()?.n).toBe(0)
    } finally {
      owner.db.close()
    }
  }
})

test('total decimals exceed both legacy and safe-integer limits without relaxing packet or EOF consistency', () => {
  const { path } = fixture(),
    reader = openOpencodeUsagePass(path, identity)
  try {
    const page = reader.next(reader.initialCursor),
      huge = '1' + '0'.repeat(100)
    const counts = { sessions: huge, parts: huge, steps: huge }
    expect(
      ObservationNativePassPageSchema.safeParse({ ...page, counts, eof: { ...page.eof, counts } })
        .success,
    ).toBe(true)
    const ack = receipt(page)
    expect(
      ObservationNativePassAckSchema.safeParse({ ...ack, counts, eof: { ...page.eof, counts } })
        .success,
    ).toBe(true)
    for (const patch of [
      { scanPositionBefore: 'bad' },
      { scannedRawRows: 'bad' },
      { counts: { ...counts, steps: 'bad' } },
      { scanPositionAfter: '0' },
      { nextCursor: 'unexpected' },
      { eof: { ...page.eof, counts } },
      { sessions: [...page.sessions, ...page.sessions] },
      { steps: [...page.steps, ...page.steps] },
      { steps: [{ ...page.steps[0]!, parentSessionId: 'root' }] },
      { counts: { sessions: '0', parts: '0', steps: '0' } },
      { sessions: Array.from({ length: 1001 }, () => page.sessions[0]!) },
      { extra: true },
    ])
      expect(ObservationNativePassPageSchema.safeParse({ ...page, ...patch }).success).toBe(false)
    expect(
      ObservationNativePassAckSchema.safeParse({ ...ack, nextCursor: 'unexpected' }).success,
    ).toBe(false)
    expect(
      ObservationNativePassAckSchema.safeParse({ ...ack, eof: { ...page.eof, counts } }).success,
    ).toBe(false)
  } finally {
    reader.close()
  }
})

test('changed admission or later page progress cannot persist or release a different original snapshot', async () => {
  for (const patch of [
    { initialCursor: 'other' },
    { identity: { ...identity, sourceGeneration: 'other' } },
  ]) {
    const { dir, path } = fixture(200),
      reader = observedReader(path),
      owner = durableTestOwner(dir)
    const original = owner.port.admit
    owner.port.admit = async (binding, cursor, rootCreatedAt) => ({
      ...(await original(binding, cursor, rootCreatedAt)),
      ...patch,
    })
    try {
      await expect(persistNativeUsagePass(reader.port, owner.port)).rejects.toThrow(
        'admission changed',
      )
      expect(reader.state()).toEqual({ reads: 0, acks: 0, closed: true })
      expect(owner.interruptions).toHaveLength(1)
    } finally {
      owner.db.close()
    }
  }
  const changes: ((page: NativeUsagePassPage) => NativeUsagePassPage)[] = [
    (page) => ({ ...page, ordinal: '99' }),
    (page) => ({ ...page, previousDigest: 'f'.repeat(64) }),
    (page) => ({ ...page, cursor: 'other' }),
    (page) => ({ ...page, identity: { ...page.identity, sourceGeneration: 'other' } }),
    (page) => ({
      ...page,
      scanPositionBefore: (BigInt(page.scanPositionBefore) + 1n).toString(),
      scanPositionAfter: (BigInt(page.scanPositionAfter) + 1n).toString(),
    }),
    (page) => ({ ...page, counts: { ...page.counts, sessions: '0' } }),
  ]
  for (const change of changes) {
    const { dir, path } = fixture(400),
      reader = observedReader(path),
      owner = durableTestOwner(dir)
    const original = reader.port.next
    let pages = 0
    reader.port.next = async (cursor) => {
      const page = await original(cursor)
      return ++pages === 2 ? change(page) : page
    }
    try {
      await expect(persistNativeUsagePass(reader.port, owner.port)).rejects.toThrow(
        'snapshot or progress',
      )
      expect(reader.state()).toEqual({ reads: 2, acks: 1, closed: true })
      expect(owner.db.query<{ n: number }, []>('SELECT count(*) n FROM pages').get()?.n).toBe(1)
      expect(owner.interruptions).toHaveLength(1)
    } finally {
      owner.db.close()
    }
  }
})

test('actual reader ACK failure, decreasing source watermark and close failure all retain interruption', async () => {
  for (const stage of ['ack', 'watermark', 'close', 'read-and-close']) {
    const { dir, path } = fixture(stage === 'close' ? 1 : 400),
      reader = observedReader(path),
      owner = durableTestOwner(dir)
    const close = reader.port.close
    if (stage === 'ack')
      reader.port.acknowledge = async () => {
        throw new Error('reader ACK unavailable')
      }
    if (stage === 'watermark') {
      const persist = owner.port.persist
      owner.port.persist = async (page) => ({
        ...(await persist(page)),
        sourceWatermark: page.ordinal === '0' ? '10' : '1',
      })
    }
    if (stage.includes('close'))
      reader.port.close = async () => {
        await close()
        throw new Error('close unavailable')
      }
    if (stage === 'read-and-close')
      reader.port.next = async () => {
        throw new Error('snapshot lost')
      }
    try {
      await expect(persistNativeUsagePass(reader.port, owner.port)).rejects.toThrow(
        stage === 'read-and-close'
          ? 'reader close failed'
          : stage === 'watermark'
            ? 'ACK changed'
            : stage === 'ack'
              ? 'reader ACK unavailable'
              : 'close unavailable',
      )
      expect(reader.state().closed).toBe(true)
      expect(owner.interruptions).toHaveLength(1)
      const expected = stage === 'read-and-close' ? 0 : stage === 'watermark' ? 2 : 1
      expect(owner.db.query<{ n: number }, []>('SELECT count(*) n FROM pages').get()?.n).toBe(
        expected,
      )
    } finally {
      owner.db.close()
    }
  }
})
