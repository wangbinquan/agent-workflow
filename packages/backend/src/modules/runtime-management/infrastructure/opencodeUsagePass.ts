import { createHash } from 'node:crypto'
import { ObservationTokenUsageSchema } from '@agent-workflow/shared'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import { sha256Hex } from '@/util/hash'
import { createOpencodeReportConnections } from './opencodeReportConnections'
import { createOpencodePartProjection, type OpencodePartRow } from './opencodePartProjection'
import type {
  NativeUsagePassCounts,
  NativeUsagePassIdentity,
  NativeUsagePassPage,
  NativeUsagePassReader,
  NativeUsagePassSession,
  NativeUsagePassStep,
} from '../application/ports/nativeUsagePass'
import type {
  HistoricalNativePassIdentity,
  HistoricalNativePassReader,
} from '../application/ports/historicalNativeUsage'

interface SessionRow {
  id: string
  parent_id: string | null
}
interface QueueRow {
  id: string
  parent: string | null
  entered: number
  parts_done: number
  part_after: string | null
  child_after: string | null
}
type OriginalNativePassIdentity = NativeUsagePassIdentity | HistoricalNativePassIdentity
type OriginalNativePassPage<I extends OriginalNativePassIdentity> = Omit<
  NativeUsagePassPage,
  'identity'
> & { readonly identity: I }
type OriginalNativePassReader<I extends OriginalNativePassIdentity> = Omit<
  NativeUsagePassReader,
  'identity' | 'next'
> & {
  readonly identity: I
  next(cursor: string): OriginalNativePassPage<I>
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
function counter(value: unknown): string | null {
  const parsed = ObservationTokenUsageSchema.shape.input.safeParse(
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : null
      : value,
  )
  return parsed.success ? parsed.data : null
}
function measurement(
  row: OpencodePartRow,
  parent: string | null,
  issues: Set<string>,
): NativeUsagePassStep {
  const output = counter(row.output),
    reasoning = counter(row.reasoning)
  const usage = {
    input: counter(row.input),
    output:
      output === null || reasoning === null
        ? null
        : counter((BigInt(output) + BigInt(reasoning)).toString()),
    cacheRead: counter(row.cache_read),
    cacheWrite: counter(row.cache_write),
  }
  if (Object.values(usage).some((value) => value === null))
    issues.add('native-token-bucket-unknown')
  const model =
    identifier(row.provider) && identifier(row.model)
      ? { provider: row.provider, id: row.model }
      : null
  if (model === null) issues.add('native-model-unavailable')
  const occurredAt =
    Number.isSafeInteger(row.time_created) && row.time_created >= 0 ? row.time_created : null
  if (occurredAt === null) issues.add('native-time-unavailable')
  return { id: row.session_id, parentSessionId: parent, stepId: row.id, occurredAt, usage, model }
}

/**
 * A single original read-only SQLite snapshot, with disk-backed TEMP traversal state.
 * Page bounds control work/IPC only; neither depth nor the original population is capped.
 * The accepted owner must persist each page before calling acknowledge.
 */
function openOriginalOpencodeUsagePass<I extends OriginalNativePassIdentity>(
  path: string,
  originalIdentity: I,
  options: { readonly pageRows?: number; readonly pageBytes?: number } = {},
  openDatabase: (path: string) => ReadonlySqliteDatabase = openReadonlySqliteDatabase,
): OriginalNativePassReader<I> {
  const identity: I = { ...originalIdentity }
  Object.freeze(identity)
  if (Object.values(identity).some((value) => !identifier(value)))
    throw new RangeError('Native pass owner identity unavailable')
  const pageRows = options.pageRows ?? 200,
    pageBytes = options.pageBytes ?? 256 * 1024
  if (
    !Number.isSafeInteger(pageRows) ||
    pageRows < 1 ||
    pageRows > 1000 ||
    !Number.isSafeInteger(pageBytes) ||
    pageBytes < 1024 ||
    pageBytes > 1024 * 1024
  )
    throw new RangeError('Invalid native pass packet size')
  const db = openDatabase(path),
    partProjection = createOpencodePartProjection(db),
    issues = new Set<string>(),
    fingerprint = createHash('sha256')
  let closed = false,
    rootCreatedAt: number | null = null,
    ordinal = 0n,
    sessionsRead = 0n,
    partsRead = 0n,
    stepsRead = 0n,
    position = 0n,
    previousDigest = sha256Hex(JSON.stringify(identity)),
    pending: OriginalNativePassPage<I> | undefined
  const cursor = () => JSON.stringify([identity.passId, ordinal.toString(), previousDigest])
  const initialCursor = cursor()
  const counts = (): NativeUsagePassCounts => ({
    sessions: sessionsRead.toString(),
    parts: partsRead.toString(),
    steps: stepsRead.toString(),
  })
  const close = () => {
    if (!closed) {
      closed = true
      partProjection.reset()
      db.close()
    }
  }
  try {
    db.query<unknown, []>('PRAGMA busy_timeout=0').get()
    db.query<unknown, []>('PRAGMA temp_store=FILE').get()
    db.query<unknown, []>('PRAGMA temp.cache_size=-8192').get()
    db.query<unknown, []>('BEGIN').get()
    const hasRootTime = db
      .query<{ name: string }, []>('PRAGMA table_info(session)')
      .all()
      .some((column) => column.name === 'time_created')
    const root = db
      .query<
        SessionRow & { time_created: unknown },
        [string]
      >(`SELECT id,parent_id,${hasRootTime ? 'time_created' : 'NULL'} AS time_created FROM session WHERE id=?`)
      .get(identity.rootSessionId)
    if (!root || !identifier(root.id)) throw new Error('Native root unavailable')
    rootCreatedAt =
      typeof root.time_created === 'number' &&
      Number.isSafeInteger(root.time_created) &&
      root.time_created >= 0
        ? root.time_created
        : null
    db.query<unknown, []>(
      `CREATE TEMP TABLE native_pass_queue (
      id TEXT PRIMARY KEY,parent TEXT,entered INTEGER NOT NULL DEFAULT 0,parts_done INTEGER NOT NULL DEFAULT 0,
      part_after TEXT,child_after TEXT,done INTEGER NOT NULL DEFAULT 0)`,
    ).get()
    db.query<unknown, []>(
      `CREATE INDEX temp.native_pass_queue_pending ON native_pass_queue(done,id)`,
    ).get()
    db.query<unknown, []>(
      `CREATE TEMP TABLE native_pass_open_steps (
      session TEXT NOT NULL,message TEXT NOT NULL,delta INTEGER NOT NULL,PRIMARY KEY(session,message))`,
    ).get()
    db.query<unknown, []>(
      `CREATE TEMP TABLE native_pass_message_models (
      message TEXT NOT NULL,session TEXT NOT NULL,provider,model,PRIMARY KEY(message,session))`,
    ).get()
    db.query<unknown, [string, string | null]>(
      'INSERT INTO temp.native_pass_queue(id,parent) VALUES (?,?)',
    ).get(root.id, null)
    fingerprint.update(JSON.stringify(['root', root]))
  } catch (error) {
    close()
    throw error
  }
  return {
    identity,
    initialCursor,
    rootCreatedAt,
    next(after) {
      if (closed) throw new Error('Native snapshot closed; start a new owner pass')
      if (pending) {
        if (after !== pending.cursor) throw new Error('Native page awaits original owner ACK')
        return structuredClone(pending)
      }
      if (after !== cursor())
        throw new RangeError('Native pass cursor changed snapshot or position')
      const before = position.toString(),
        nodes: NativeUsagePassSession[] = [],
        steps: NativeUsagePassStep[] = []
      let scanned = 0,
        payloadBytes = 0,
        eof = false
      try {
        while (scanned < pageRows && payloadBytes < pageBytes) {
          const current = db
            .query<QueueRow, []>(
              `SELECT id,parent,entered,parts_done,part_after,child_after
            FROM temp.native_pass_queue WHERE done=0 ORDER BY id LIMIT 1`,
            )
            .get()
          if (!current) {
            eof = true
            break
          }
          if (!current.entered) {
            const node = { id: current.id, parentSessionId: current.parent }
            const bytes = Buffer.byteLength(JSON.stringify(node))
            if (bytes > pageBytes) throw new Error('Native session exceeds packet capacity')
            if (payloadBytes + bytes > pageBytes) break
            nodes.push(node)
            payloadBytes += bytes
            sessionsRead++
            position++
            scanned++
            fingerprint.update(JSON.stringify(['session', node]))
            db.query<unknown, [string]>(
              'UPDATE temp.native_pass_queue SET entered=1 WHERE id=?',
            ).get(current.id)
            continue
          }
          if (!current.parts_done) {
            const row = partProjection.read(current.id, current.part_after, pageRows - scanned)
            const messageCached = row?.cache_message != null
            // This transport-internal flag must never enter the original PartRow fingerprint.
            if (row) delete row.cache_message
            if (!row) {
              if (
                db
                  .query<{ message: string }, [string]>(
                    `SELECT message FROM temp.native_pass_open_steps
                WHERE session=? AND delta>0 LIMIT 1`,
                  )
                  .get(current.id)
              )
                issues.add('native-step-unfinished')
              db.query<unknown, [string]>(
                'DELETE FROM temp.native_pass_open_steps WHERE session=?',
              ).get(current.id)
              db.query<unknown, [string]>(
                'UPDATE temp.native_pass_queue SET parts_done=1 WHERE id=?',
              ).get(current.id)
              partProjection.reset()
              continue
            }
            if (!identifier(row.id)) throw new Error('Native part cursor unavailable')
            if (
              (row.kind === 'step-start' || row.kind === 'step-finish') &&
              !identifier(row.message_id)
            )
              throw new Error('Native step message identity unavailable')
            let value: NativeUsagePassStep | undefined
            if (
              row.kind === 'step-finish' &&
              identifier(row.message_id) &&
              row.session_id === current.id
            ) {
              value = measurement(row, current.parent, issues)
              const bytes = Buffer.byteLength(JSON.stringify(value))
              if (bytes > pageBytes) throw new Error('Native numeric row exceeds packet capacity')
              if (payloadBytes + bytes > pageBytes) break
            }
            const delta = row.kind === 'step-start' ? 1 : row.kind === 'step-finish' ? -1 : 0
            if (delta && identifier(row.message_id))
              db.query<unknown, [string, string, number]>(
                `INSERT INTO
              temp.native_pass_open_steps(session,message,delta) VALUES (?,?,?) ON CONFLICT(session,message)
              DO UPDATE SET delta=delta+excluded.delta`,
              ).get(current.id, row.message_id, delta)
            fingerprint.update(JSON.stringify(['part', row]))
            partsRead++
            position++
            scanned++
            if (row.kind === 'step-finish') {
              stepsRead++
              if (!identifier(row.message_id) || row.session_id !== current.id)
                issues.add('native-step-identity')
              else if (value) {
                steps.push(value)
                payloadBytes += Buffer.byteLength(JSON.stringify(value))
              }
            }
            db.query<unknown, [string, string]>(
              'UPDATE temp.native_pass_queue SET part_after=? WHERE id=?',
            ).get(row.id, current.id)
            partProjection.advance()
            if (!messageCached && identifier(row.message_id) && identifier(row.session_id)) {
              db.query<unknown, [string, string, unknown, unknown]>(
                `INSERT INTO temp.native_pass_message_models(message,session,provider,model)
              VALUES (?,?,?,?) ON CONFLICT(message,session) DO NOTHING`,
              ).get(row.message_id, row.session_id, row.provider, row.model)
              partProjection.rememberCachedMessage(row.session_id, row.message_id)
            }
            continue
          }
          const child =
            current.child_after === null
              ? db
                  .query<
                    SessionRow,
                    [string]
                  >('SELECT id,parent_id FROM session WHERE parent_id=?1 ORDER BY id LIMIT 1')
                  .get(current.id)
              : db
                  .query<
                    SessionRow,
                    [string, string]
                  >('SELECT id,parent_id FROM session WHERE parent_id=?1 AND id>?2 ORDER BY id LIMIT 1')
                  .get(current.id, current.child_after)
          if (!child) {
            db.query<unknown, [string]>('UPDATE temp.native_pass_queue SET done=1 WHERE id=?').get(
              current.id,
            )
            continue
          }
          if (!identifier(child.id)) throw new Error('Native child cursor unavailable')
          fingerprint.update(JSON.stringify(['child', child]))
          position++
          scanned++
          const visited = db
            .query<{ id: string }, [string]>('SELECT id FROM temp.native_pass_queue WHERE id=?')
            .get(child.id)
          if (visited || child.parent_id !== current.id) issues.add('native-tree-conflict')
          else
            db.query<unknown, [string, string]>(
              'INSERT INTO temp.native_pass_queue(id,parent) VALUES (?,?)',
            ).get(child.id, current.id)
          db.query<unknown, [string, string]>(
            'UPDATE temp.native_pass_queue SET child_after=? WHERE id=?',
          ).get(child.id, current.id)
        }
        const totals = counts(),
          body = {
            identity,
            ordinal: ordinal.toString(),
            scanPositionBefore: before,
            scanPositionAfter: position.toString(),
            scannedRawRows: String(scanned),
            counts: totals,
            sessions: nodes,
            steps,
            issues: [...issues].sort(),
            eof: eof ? { fingerprint: fingerprint.digest('hex'), counts: totals } : null,
          }
        const payloadDigest = sha256Hex(JSON.stringify(body)),
          cumulativeDigest = sha256Hex(JSON.stringify([previousDigest, payloadDigest]))
        const page: OriginalNativePassPage<I> = {
          ...body,
          cursor: after,
          previousDigest,
          payloadDigest,
          cumulativeDigest,
          nextCursor: eof
            ? null
            : JSON.stringify([identity.passId, (ordinal + 1n).toString(), cumulativeDigest]),
        }
        pending = page
        return structuredClone(page)
      } catch (error) {
        close()
        throw error
      }
    },
    acknowledge(number, digest) {
      if (closed || !pending || pending.ordinal !== number || pending.payloadDigest !== digest)
        throw new Error('Native original owner ACK changed frozen page')
      const final = pending.nextCursor === null
      previousDigest = pending.cumulativeDigest
      ordinal++
      pending = undefined
      if (final) {
        try {
          db.query<unknown, []>('COMMIT').get()
        } finally {
          close()
        }
      }
    },
    close,
  }
}

/** Original accepted pass protocol and identity checks retain their existing meaning. */
export function openOpencodeUsagePass(
  path: string,
  identity: NativeUsagePassIdentity,
  options: { readonly pageRows?: number; readonly pageBytes?: number } = {},
): NativeUsagePassReader {
  if (!['baseline', 'final'].includes(identity.phase))
    throw new RangeError('Native pass owner identity unavailable')
  return openOriginalOpencodeUsagePass(path, identity, options)
}

/** Same full original numeric parser/traversal, without invented before-spawn or admission fields. */
export function openHistoricalOpencodeUsagePass(
  path: string,
  identity: HistoricalNativePassIdentity,
  options: { readonly pageRows?: number; readonly pageBytes?: number } = {},
): HistoricalNativePassReader {
  if (identity.kind !== 'historical-observed')
    throw new RangeError('Historical native reference unavailable')
  return openOriginalOpencodeUsagePass(path, identity, options)
}

/** Each original root retains its own snapshot; only released physical handles belong to this report. */
export function createHistoricalOpencodeUsagePassFactory(
  path: string,
  options: {
    readonly pageRows?: number
    readonly pageBytes?: number
    readonly openDatabase?: (path: string) => ReadonlySqliteDatabase
  } = {},
) {
  const connections = createOpencodeReportConnections(path, options.openDatabase),
    active = new Set<HistoricalNativePassReader>()
  let closed = false
  return {
    open(identity: HistoricalNativePassIdentity): HistoricalNativePassReader {
      if (closed) throw new Error('Historical native reader factory closed')
      if (identity.kind !== 'historical-observed')
        throw new RangeError('Historical native reference unavailable')
      const state: { reader?: HistoricalNativePassReader } = {}
      const reader = openOriginalOpencodeUsagePass(path, identity, options, () =>
        connections.borrow(identity.sourceGeneration, () => {
          if (state.reader) active.delete(state.reader)
        }),
      )
      state.reader = reader
      active.add(reader)
      return reader
    },
    close() {
      if (closed) return
      closed = true
      for (const reader of [...active]) reader.close()
      connections.close()
    },
  }
}
