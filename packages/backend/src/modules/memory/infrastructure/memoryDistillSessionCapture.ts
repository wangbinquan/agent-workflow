import type { DbClient } from '@/db/client'
import { memoryDistillEvents } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { DISTILL_CAPTURE_FAILED_KIND, getRuntimeDriver } from '@/services/runtime'
import type {
  DistillSessionCaptureContext,
  DistillSessionCaptureSink,
} from '@/services/runtime/types'
import { createLogger } from '@/util/log'
import type { MemoryDistillCaptureInput } from '../application/ports/distillWorkStore'

const log = createLogger('memory-distill-session-capture')

function captureContext(
  input: MemoryDistillCaptureInput,
  sink: DistillSessionCaptureSink,
): DistillSessionCaptureContext {
  return {
    distillJobId: input.distillJobId,
    attemptIndex: input.attemptIndex,
    rootSessionId: input.rootSessionId,
    sink,
    log,
  }
}

function sqliteSink(db: DbClient): DistillSessionCaptureSink {
  return Object.freeze({
    async append(events: Parameters<DistillSessionCaptureSink['append']>[0]) {
      if (events.length === 0) return
      await db.insert(memoryDistillEvents).values([...events])
    },
    async markFailed(input: Parameters<DistillSessionCaptureSink['markFailed']>[0]) {
      try {
        await db.insert(memoryDistillEvents).values({
          distillJobId: input.distillJobId,
          attemptIndex: input.attemptIndex,
          ts: Date.now(),
          kind: DISTILL_CAPTURE_FAILED_KIND,
          payload: JSON.stringify({ sessionID: input.rootSessionId, reason: input.reason }),
          sessionId: input.rootSessionId,
          parentSessionId: null,
        })
      } catch {
        // Capture is diagnostic and must never replace the distiller outcome.
      }
    },
  })
}

function postgresqlSink(db: PostgresqlDatabaseClient): DistillSessionCaptureSink {
  return Object.freeze({
    async append(events: Parameters<DistillSessionCaptureSink['append']>[0]) {
      if (events.length === 0) return
      await db.insert(memoryDistillEvents).values([...events])
    },
    async markFailed(input: Parameters<DistillSessionCaptureSink['markFailed']>[0]) {
      try {
        await db.insert(memoryDistillEvents).values({
          distillJobId: input.distillJobId,
          attemptIndex: input.attemptIndex,
          ts: Date.now(),
          kind: DISTILL_CAPTURE_FAILED_KIND,
          payload: JSON.stringify({ sessionID: input.rootSessionId, reason: input.reason }),
          sessionId: input.rootSessionId,
          parentSessionId: null,
        })
      } catch {
        // Capture is diagnostic and must never replace the distiller outcome.
      }
    },
  })
}

export function createSqliteMemoryDistillSessionCapture(db: DbClient) {
  const sink = sqliteSink(db)
  return async (input: MemoryDistillCaptureInput): Promise<void> => {
    await getRuntimeDriver(input.protocol).captureDistillSession?.(captureContext(input, sink))
  }
}

export function createPostgresqlMemoryDistillSessionCapture(db: PostgresqlDatabaseClient) {
  const sink = postgresqlSink(db)
  return async (input: MemoryDistillCaptureInput): Promise<void> => {
    await getRuntimeDriver(input.protocol).captureDistillSession?.(captureContext(input, sink))
  }
}
