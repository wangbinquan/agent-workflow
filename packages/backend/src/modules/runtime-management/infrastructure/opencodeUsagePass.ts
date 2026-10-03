import { createHash } from 'node:crypto'
import { ObservationTokenUsageSchema } from '@agent-workflow/shared'
import { openReadonlySqliteDatabase } from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import { sha256Hex } from '@/util/hash'
import type {
  NativeUsagePassCounts,
  NativeUsagePassIdentity,
  NativeUsagePassPage,
  NativeUsagePassReader,
  NativeUsagePassSession,
  NativeUsagePassStep,
} from '../application/ports/nativeUsagePass'

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
interface PartRow {
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
  row: PartRow,
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
export function openOpencodeUsagePass(
  path: string,
  acceptedIdentity: NativeUsagePassIdentity,
  options: { readonly pageRows?: number; readonly pageBytes?: number } = {},
): NativeUsagePassReader {
  const identity = Object.freeze({ ...acceptedIdentity })
  if (
    Object.values(identity).some((value) => !identifier(value)) ||
    !['baseline', 'final'].includes(identity.phase)
  )
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
  const db = openReadonlySqliteDatabase(path),
    issues = new Set<string>(),
    fingerprint = createHash('sha256')
  let closed = false,
    ordinal = 0n,
    sessionsRead = 0n,
    partsRead = 0n,
    stepsRead = 0n,
    position = 0n,
    previousDigest = sha256Hex(JSON.stringify(identity)),
    pending: NativeUsagePassPage | undefined
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
      db.close()
    }
  }
  try {
    db.query<unknown, []>('PRAGMA busy_timeout=0').get()
    db.query<unknown, []>('PRAGMA temp_store=FILE').get()
    db.query<unknown, []>('PRAGMA temp.cache_size=-8192').get()
    db.query<unknown, []>('BEGIN').get()
    const root = db
      .query<SessionRow, [string]>('SELECT id,parent_id FROM session WHERE id=?')
      .get(identity.rootSessionId)
    if (!root || !identifier(root.id)) throw new Error('Native root unavailable')
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
            // Extract only numeric/model fields. Text/tool bodies are never buffered or transported.
            // Keep the non-null continuation as an actual composite-index range.
            // A nullable OR makes SQLite rescan every prior part for every original row.
            const fields = `SELECT p.id,p.session_id,p.message_id,p.time_created,
              json_extract(p.data,'$.type') AS kind,
              CASE WHEN json_type(p.data,'$.tokens.input') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.input') END AS input,
              CASE WHEN json_type(p.data,'$.tokens.output') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.output') END AS output,
              CASE WHEN json_type(p.data,'$.tokens.reasoning') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.reasoning') END AS reasoning,
              CASE WHEN json_type(p.data,'$.tokens.cache.read') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.read') END AS cache_read,
              CASE WHEN json_type(p.data,'$.tokens.cache.write') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.write') END AS cache_write,
              CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.providerID') END AS provider,
              CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.modelID') END AS model
              FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
              `
            const row =
              current.part_after === null
                ? db
                    .query<
                      PartRow,
                      [string]
                    >(fields + ' WHERE p.session_id=?1 ORDER BY p.id LIMIT 1')
                    .get(current.id)
                : db
                    .query<
                      PartRow,
                      [string, string]
                    >(fields + ' WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT 1')
                    .get(current.id, current.part_after)
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
              continue
            }
            if (!identifier(row.id)) throw new Error('Native part cursor unavailable')
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
        pending = {
          ...body,
          cursor: after,
          previousDigest,
          payloadDigest,
          cumulativeDigest,
          nextCursor: eof
            ? null
            : JSON.stringify([identity.passId, (ordinal + 1n).toString(), cumulativeDigest]),
        }
        return structuredClone(pending)
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
