import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import { sha256Hex } from '@/util/hash'
import type { NativeSpan, NativeSpanSnapshot } from '../application/ports/nativeSpanCapture'

interface SessionRow {
  id: string
  parent_id: string | null
  time_created: number
}
interface PartRow {
  id: string
  session_id: string
  message_id: string
  time_created: number
  time_updated: number
  kind: string | null
  call_id: string | null
  tool: string | null
  status: string | null
  tool_start: number | null
  tool_end: number | null
  provider: string | null
  model: string | null
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200
const nativeTime = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const uniqueKey = (span: NativeSpan) => JSON.stringify([span.sessionId, span.kind, span.callId])

/** Independent metadata scan: numeric SQL, fingerprints, and resume baselines are untouched. */
export function readOpencodeSpanSnapshot(
  path: string | null,
  root: string,
  options: {
    readonly maxSessions?: number
    readonly maxParts?: number
    readonly maxSpans?: number
    readonly maxDepth?: number
    readonly budgetMs?: number
    readonly clock?: () => number
  } = {},
): NativeSpanSnapshot {
  const clock = options.clock ?? (() => performance.now())
  const bounded = (value: number | undefined, ceiling: number) =>
    value === undefined || !Number.isFinite(value)
      ? ceiling
      : Math.max(1, Math.min(ceiling, Math.floor(value)))
  const maxSessions = bounded(options.maxSessions, 128)
  const maxParts = bounded(options.maxParts, 20000)
  const maxSpans = bounded(options.maxSpans, 5000)
  const maxDepth = bounded(options.maxDepth, 32)
  const deadline =
    clock() +
    Math.max(0, Math.min(400, Number.isFinite(options.budgetMs) ? options.budgetMs! : 400))
  const spans = new Map<string, NativeSpan>()
  const issues = new Set<string>()
  let db: ReadonlySqliteDatabase | undefined
  let scannedSessions = 0,
    scannedParts = 0,
    rootCreatedAt: number | null = null
  const add = (span: NativeSpan) => {
    const key = uniqueKey(span)
    if (spans.has(key)) {
      issues.add('native-span-identity-conflict')
      const original = spans.get(key)!
      spans.set(key, {
        ...original,
        state: { startedAt: null, endedAt: null, nativeObservedAt: null, status: 'unknown' },
        issues: ['native-span-identity-conflict'],
      })
    } else if (spans.size < maxSpans) spans.set(key, span)
    else issues.add('native-span-budget')
  }
  try {
    if (!path || !identity(root)) throw new Error('Span source unavailable')
    db = openReadonlySqliteDatabase(path)
    db.query<unknown, []>('PRAGMA busy_timeout=0').get()
    db.query<unknown, []>('BEGIN').get()
    const first = db
      .query<SessionRow, [string]>('SELECT id,parent_id,time_created FROM session WHERE id=?')
      .get(root)
    if (!first) throw new Error('Span root unavailable')
    if (first.parent_id !== null) issues.add('native-span-root-parent-conflict')
    rootCreatedAt = nativeTime(first.time_created)
    if (rootCreatedAt === null) issues.add('native-root-time-unavailable')
    const queue: { session: SessionRow; ancestors: readonly string[] }[] = [
      { session: first, ancestors: [] },
    ]
    const seen = new Set<string>()
    while (queue.length > 0) {
      if (clock() >= deadline) {
        issues.add('native-span-scan-budget')
        break
      }
      const current = queue.shift()!
      if (seen.has(current.session.id)) {
        issues.add('native-span-tree-conflict')
        continue
      }
      if (scannedSessions >= maxSessions || current.ancestors.length > maxDepth) {
        issues.add('native-span-tree-budget')
        break
      }
      seen.add(current.session.id)
      scannedSessions++
      const allowance = maxParts - scannedParts
      const rows = db
        .query<PartRow, [string, number]>(
          `SELECT p.id,p.session_id,p.message_id,p.time_created,p.time_updated,
        json_extract(p.data,'$.type') AS kind,
        CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.callID') END AS call_id,
        CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.tool') END AS tool,
        CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.state.status') END AS status,
        CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.state.time.start') END AS tool_start,
        CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.state.time.end') END AS tool_end,
        CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.providerID') END AS provider,
        CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.modelID') END AS model
        FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
        WHERE p.session_id=? ORDER BY p.id LIMIT ?`,
        )
        .all(current.session.id, allowance + 1)
      const completeSession = rows.length <= allowance
      const admitted = rows.slice(0, allowance)
      scannedParts += admitted.length
      if (!completeSession) issues.add('native-span-part-budget')
      const starts = new Map<string, PartRow[]>(),
        finishes = new Map<string, PartRow[]>()
      for (const row of admitted) {
        if (row.kind === 'step-start' || row.kind === 'step-finish') {
          const index = row.kind === 'step-start' ? starts : finishes
          index.set(row.message_id, [...(index.get(row.message_id) ?? []), row])
        }
      }
      for (const row of admitted) {
        if (clock() >= deadline) {
          issues.add('native-span-scan-budget')
          break
        }
        const scope = {
          sessionId: current.session.id,
          parentSessionId: current.ancestors.at(-1) ?? null,
          ancestors: current.ancestors,
          parentCallId: null,
        }
        if (row.kind === 'tool') {
          if (!identity(row.call_id) || !identity(row.tool)) {
            issues.add('native-tool-identity-unavailable')
            continue
          }
          const startedAt = nativeTime(row.tool_start),
            endedAt = nativeTime(row.tool_end)
          const invalid = startedAt !== null && endedAt !== null && endedAt < startedAt
          if (invalid) issues.add('native-span-time-conflict')
          add({
            ...scope,
            callId: row.call_id,
            kind: 'tool',
            label: row.tool.slice(0, 120),
            model: null,
            measurementRecordId: null,
            state: {
              startedAt: invalid ? null : startedAt,
              endedAt: invalid ? null : endedAt,
              nativeObservedAt: nativeTime(row.time_updated),
              status: invalid
                ? 'unknown'
                : row.status === 'completed'
                  ? 'success'
                  : row.status === 'error'
                    ? 'error'
                    : ['pending', 'running'].includes(row.status ?? '')
                      ? 'open'
                      : 'unknown',
            },
            ...(invalid ? { issues: ['native-span-time-conflict'] } : {}),
          })
        } else if (row.kind === 'step-finish') {
          if (!identity(row.id)) {
            issues.add('native-model-identity-unavailable')
            continue
          }
          const start =
            completeSession &&
            starts.get(row.message_id)?.length === 1 &&
            finishes.get(row.message_id)?.length === 1
              ? nativeTime(starts.get(row.message_id)![0]!.time_created)
              : null
          const end = nativeTime(row.time_created),
            invalid = start !== null && end !== null && end < start
          const model = identity(row.model)
            ? { provider: identity(row.provider) ? row.provider : null, id: row.model }
            : null
          if (invalid) issues.add('native-span-time-conflict')
          add({
            ...scope,
            callId: row.id,
            kind: 'model',
            label: model?.id.slice(0, 120) ?? 'model',
            model,
            measurementRecordId: 'opencode:step:' + row.id,
            state: {
              startedAt: invalid ? null : start,
              endedAt: invalid ? null : end,
              nativeObservedAt: nativeTime(row.time_updated),
              status: invalid ? 'unknown' : 'success',
            },
            ...(invalid ? { issues: ['native-span-time-conflict'] } : {}),
          })
        }
      }
      // A child session has real activity, but its last update is never proof of execution end.
      if (current.ancestors.length > 0 && admitted.length > 0) {
        const activity = admitted
          .map((row) => nativeTime(row.time_created))
          .filter((at): at is number => at !== null)
        add({
          sessionId: current.session.id,
          parentSessionId: current.ancestors.at(-1)!,
          ancestors: current.ancestors,
          callId: current.session.id,
          kind: 'native-agent',
          label: 'native-agent',
          parentCallId: null,
          model: null,
          measurementRecordId: null,
          state: {
            startedAt: activity.length ? Math.min(...activity) : null,
            endedAt: null,
            nativeObservedAt: null,
            status: 'unknown',
          },
        })
      }
      if (!completeSession || issues.has('native-span-scan-budget')) break
      const children = db
        .query<
          SessionRow,
          [string, number]
        >('SELECT id,parent_id,time_created FROM session WHERE parent_id=? ORDER BY id LIMIT ?')
        .all(current.session.id, maxSessions + 1)
      if (children.length > maxSessions) issues.add('native-span-tree-budget')
      for (const session of children.slice(0, maxSessions)) {
        if (!identity(session.id) || session.parent_id !== current.session.id) {
          issues.add('native-span-tree-conflict')
          continue
        }
        queue.push({ session, ancestors: [...current.ancestors, current.session.id] })
      }
    }
  } catch {
    issues.add('native-span-source-unavailable')
  } finally {
    if (db) {
      try {
        db.query<unknown, []>('ROLLBACK').get()
      } catch {
        /* The source remains external and read only. */
      }
      try {
        db.close()
      } catch {
        /* Metadata failure cannot affect numeric capture. */
      }
    }
  }
  const result = [...spans.values()]
  return {
    rootSessionId: root,
    rootCreatedAt,
    clockQuality: rootCreatedAt === null ? 'unknown' : 'same-host-native',
    spans: result,
    fingerprint: issues.size === 0 ? sha256Hex(JSON.stringify(result)) : null,
    scannedSessions,
    scannedParts,
    issues: [...issues],
  }
}
