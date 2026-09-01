import { existsSync } from 'node:fs'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import type { DistillSessionCaptureContext } from '../types'
import { createLogger } from '@/util/log'
import { resolveOpencodeDbPath, transcodeOpencodeRowsToEvents } from './sessionCapture'
import { walkOpencodeSessions } from './sessionWalk'

export const DISTILL_CAPTURE_FAILED_KIND = 'rfc043/distill-capture-failed'

export interface CaptureDistillJobSessionResult {
  readonly capturedSessionIds: string[]
  readonly insertedEventRows: number
  readonly failed: boolean
  readonly failureReason?: string
}

export async function captureDistillJobSession(
  input: DistillSessionCaptureContext,
): Promise<CaptureDistillJobSessionResult> {
  const log = input.log ?? createLogger('distill-session-capture')
  const dbPath = input.opencodeDbPath ?? resolveOpencodeDbPath()
  if (!existsSync(dbPath)) {
    await input.sink.markFailed({ ...input, reason: 'opencode-db-not-found' })
    return {
      capturedSessionIds: [],
      insertedEventRows: 0,
      failed: true,
      failureReason: 'opencode-db-not-found',
    }
  }

  let opencodeDb: ReadonlySqliteDatabase | null = null
  try {
    opencodeDb = openReadonlySqliteDatabase(dbPath)
    const capturedSessionIds: string[] = []
    let insertedEventRows = 0
    for (const { session, messages, parts } of walkOpencodeSessions(
      opencodeDb,
      input.rootSessionId,
      { includeRoot: true },
    )) {
      capturedSessionIds.push(session.id)
      const events = transcodeOpencodeRowsToEvents({
        sessionId: session.id,
        messages,
        parts,
      }).map((event) => ({
        distillJobId: input.distillJobId,
        attemptIndex: input.attemptIndex,
        ts: event.ts,
        kind: event.kind,
        payload: event.payload,
        sessionId: session.id,
        parentSessionId: session.parent_id,
      }))
      if (events.length === 0) continue
      await input.sink.append(events)
      insertedEventRows += events.length
    }
    return { capturedSessionIds, insertedEventRows, failed: false }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.warn('distill-capture-error', { distillJobId: input.distillJobId, reason })
    await input.sink.markFailed({ ...input, reason })
    return {
      capturedSessionIds: [],
      insertedEventRows: 0,
      failed: true,
      failureReason: reason,
    }
  } finally {
    opencodeDb?.close()
  }
}
