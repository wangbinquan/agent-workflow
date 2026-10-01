import { ObservationTokenUsageSchema, type ObservationTokenUsage } from '@agent-workflow/shared'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageSnapshot, NativeUsageStep } from '../application/ports/nativeUsageCapture'

interface PartRow {
  id: string
  session_id: string
  message_id: string
  time_created: number
  kind: string
  tokens: string | null
  provider: string | null
  model: string | null
}
interface Session {
  id: string
  parent_id: string | null
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const counter = (value: unknown) => {
  const parsed = ObservationTokenUsageSchema.shape.input.safeParse(
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : null
      : (value ?? null),
  )
  return parsed.success ? parsed.data : null
}
function step(row: PartRow, ancestors: readonly string[], issues: Set<string>): NativeUsageStep {
  const tokens = record(JSON.parse(row.tokens ?? 'null')),
    cache = record(tokens.cache)
  const output = counter(tokens.output),
    reasoning = counter(tokens.reasoning)
  const usage: ObservationTokenUsage = {
    input: counter(tokens.input),
    output:
      output === null || reasoning === null
        ? null
        : counter((BigInt(output) + BigInt(reasoning)).toString()),
    cacheRead: counter(cache.read),
    cacheWrite: counter(cache.write),
  }
  const model = id(row.provider) && id(row.model) ? { provider: row.provider, id: row.model } : null
  if (Object.values(usage).some((value) => value === null))
    issues.add('native-token-bucket-unknown')
  if (model === null) issues.add('native-model-unavailable')
  const occurredAt =
    Number.isSafeInteger(row.time_created) && row.time_created >= 0 ? row.time_created : null
  if (occurredAt === null) issues.add('native-time-unavailable')
  return {
    id: row.id,
    sessionId: row.session_id,
    parentSessionId: ancestors.at(-1) ?? null,
    ancestors,
    occurredAt,
    usage,
    model,
  }
}

/** Native SQLite is an external artifact, independent of AW's SQLite/PostgreSQL provider. */
export function readOpencodeUsageSnapshot(
  path: string | null,
  root: string,
  options: {
    readonly maxSessions?: number
    readonly maxSteps?: number
    readonly maxParts?: number
    readonly maxDepth?: number
    readonly budgetMs?: number
    readonly clock?: () => number
  } = {},
): NativeUsageSnapshot {
  const clock = options.clock ?? (() => performance.now()),
    deadline = clock() + (options.budgetMs ?? 400)
  const maxSessions = Math.min(1024, options.maxSessions ?? 128),
    maxSteps = Math.min(10000, options.maxSteps ?? 5000),
    maxParts = Math.min(50000, options.maxParts ?? 20000),
    maxDepth = Math.min(64, options.maxDepth ?? 32)
  const steps: NativeUsageStep[] = [],
    sessions: Array<{ id: string; ancestors: readonly string[] }> = [],
    issues = new Set<string>()
  let db: ReadonlySqliteDatabase | undefined,
    partsRead = 0
  try {
    if (!path || !id(root)) throw new Error('Native store unavailable')
    db = openReadonlySqliteDatabase(path)
    db.query<unknown, []>('PRAGMA busy_timeout = 0').get()
    db.query<unknown, []>('BEGIN').get()
    const found = db
      .query<Session, [string]>('SELECT id, parent_id FROM session WHERE id=?')
      .get(root)
    if (!found) {
      issues.add('native-root-unavailable')
      return { steps, sessions: 0, fingerprint: null, issues: [...issues] }
    }
    const queue = [{ id: root, ancestors: [] as readonly string[] }],
      visited = new Set<string>()
    while (queue.length) {
      if (clock() >= deadline) {
        issues.add('native-scan-budget')
        break
      }
      const current = queue.shift()!
      if (visited.has(current.id)) {
        issues.add('native-tree-conflict')
        continue
      }
      if (sessions.length >= maxSessions || current.ancestors.length > maxDepth) {
        issues.add('native-tree-budget')
        break
      }
      visited.add(current.id)
      sessions.push(current)
      // Read only numeric step data and exact assistant model metadata. Other parts count toward
      // the scan budget, but their text/tool arguments never leave the native database.
      const rows = db
        .query<PartRow, [string, number]>(
          `SELECT p.id, p.session_id, p.message_id, p.time_created,
        json_extract(p.data, '$.type') AS kind,
        CASE WHEN json_extract(p.data, '$.type')='step-finish' THEN json_extract(p.data, '$.tokens') END AS tokens,
        CASE WHEN json_extract(m.data, '$.role')='assistant' THEN json_extract(m.data, '$.providerID') END AS provider,
        CASE WHEN json_extract(m.data, '$.role')='assistant' THEN json_extract(m.data, '$.modelID') END AS model
        FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
        WHERE p.session_id=? ORDER BY p.id LIMIT ?`,
        )
        .all(current.id, Math.max(0, maxParts - partsRead) + 1)
      if (rows.length + partsRead > maxParts) {
        issues.add('native-part-budget')
        break
      }
      partsRead += rows.length
      const opened = new Map<string, number>()
      for (const row of rows) {
        const delta = row.kind === 'step-start' ? 1 : row.kind === 'step-finish' ? -1 : 0
        if (delta) opened.set(row.message_id, (opened.get(row.message_id) ?? 0) + delta)
      }
      if ([...opened.values()].some((value) => value > 0)) issues.add('native-step-unfinished')
      for (const row of rows) {
        if (clock() >= deadline) {
          issues.add('native-scan-budget')
          break
        }
        if (row.kind !== 'step-finish') continue
        if (!id(row.id) || !id(row.message_id) || row.session_id !== current.id) {
          issues.add('native-step-identity')
          continue
        }
        if (steps.length >= maxSteps) {
          issues.add('native-step-budget')
          break
        }
        steps.push(step(row, current.ancestors, issues))
      }
      if (issues.has('native-step-budget') || issues.has('native-scan-budget')) break
      const children = db
        .query<
          Session,
          [string, number]
        >('SELECT id, parent_id FROM session WHERE parent_id=? ORDER BY id LIMIT ?')
        .all(current.id, Math.max(0, maxSessions - sessions.length - queue.length) + 1)
      if (children.length + sessions.length + queue.length > maxSessions) {
        issues.add('native-tree-budget')
        break
      }
      for (const child of children) {
        if (!id(child.id) || child.parent_id !== current.id) {
          issues.add('native-tree-conflict')
          continue
        }
        queue.push({ id: child.id, ancestors: [...current.ancestors, current.id] })
      }
    }
    db.query<unknown, []>('COMMIT').get()
  } catch {
    issues.add('native-store-unavailable')
  } finally {
    try {
      db?.close()
    } catch {
      /* Closing a native reader never affects execution. */
    }
  }
  const metadataIssues = new Set([
    'native-token-bucket-unknown',
    'native-model-unavailable',
    'native-time-unavailable',
  ])
  const scanned = [...issues].every((issue) => metadataIssues.has(issue))
  return {
    steps,
    sessions: sessions.length,
    fingerprint: scanned ? sha256Hex(JSON.stringify([sessions, steps])) : null,
    issues: [...issues],
  }
}
