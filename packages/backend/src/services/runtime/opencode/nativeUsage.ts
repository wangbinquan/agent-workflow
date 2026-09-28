import { isAbsolute, join } from 'node:path'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import {
  object,
  nativeId,
  type JsonObject,
  type RuntimeUsageContext,
  type RuntimeUsageFrame,
} from '../usage'
import { normalizeUsage } from './usage'

type ActualModel = { provider: string; id: string }

/** Mirrors OpenCode's explicit DB path and standard release channel using this child environment. */
export function opencodeUsageDatabasePath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = env.OPENCODE_DB
  if (explicit === ':memory:') return null
  if (explicit && isAbsolute(explicit)) return explicit
  const data =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : env.HOME && isAbsolute(env.HOME)
        ? join(env.HOME, '.local', 'share')
        : null
  return data ? join(data, 'opencode', explicit || 'opencode.db') : null
}

/** A stdout step's exact native message supplies the actual model, never a configured default. */
export function readOpencodeUsageModel(
  path: string | null,
  raw: JsonObject,
  session: string,
): ActualModel | null {
  const part = object(raw.part),
    id = nativeId(part?.id),
    message = nativeId(part?.messageID)
  if (!path || !id || !message || raw.sessionID !== session || part?.sessionID !== session)
    return null
  let db: ReadonlySqliteDatabase | undefined
  try {
    db = openReadonlySqliteDatabase(path)
    db.query<unknown, []>('PRAGMA busy_timeout = 0').get()
    const row = db
      .query<
        { data: string; part: string },
        [string, string, string]
      >('SELECT m.data AS data, p.data AS part FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id WHERE p.id=? AND p.session_id=? AND m.id=?')
      .get(id, session, message)
    if (!row || object(JSON.parse(row.part))?.type !== 'step-finish') return null
    const info = object(JSON.parse(row.data)),
      provider = nativeId(info?.providerID),
      model = nativeId(info?.modelID)
    return info?.role === 'assistant' && provider && model ? { provider, id: model } : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* No reader survives the call. */
    }
  }
}

/** One factory per invocation; a transient read failure cannot erase previously proven metadata. */
export function createOpencodeUsageNormalizer(env: Readonly<Record<string, string | undefined>>) {
  const path = opencodeUsageDatabasePath(env),
    proven = new Map<string, ActualModel>()
  return (raw: unknown, context: RuntimeUsageContext): RuntimeUsageFrame => {
    const input = object(raw)
    if (!input || input.type !== 'step_finish') return normalizeUsage(raw, context)
    const key = JSON.stringify([
      context.sessionId,
      object(input.part)?.id,
      object(input.part)?.messageID,
    ])
    const actual = readOpencodeUsageModel(path, input, context.sessionId) ?? proven.get(key) ?? null
    if (actual && !proven.has(key)) proven.set(key, actual)
    const result = normalizeUsage(raw, {
      ...context,
      provider: actual?.provider ?? null,
      actualModel: actual?.id ?? null,
    })
    return actual || !result.measurements.length
      ? result
      : { ...result, diagnostics: [...result.diagnostics, 'native-model-unavailable'] }
  }
}
