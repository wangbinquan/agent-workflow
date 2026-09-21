// RFC-367 —— 蒸馏会话的**实时**事件落库 sink。
//
// 取代 RFC-043 的事后 opencode SQLite 走查（`distillSessionCapture.ts`）：候选解析读
// `runSystemAgent` 的 `eventText`，会话页读这里写的行，**两者同源于一条规范化事件流**。
// 历史上这两条路各解析一次同一段输出，于是出现过「会话页明明显示了 envelope、候选却是 0」
// （RFC-117 的回归注释记过一次，2026-09-21 又复发一次，见 RFC-367 proposal §1）。
//
// 契约（`services/sessionEventSink.ts`）：**sink 的持久化失败绝不能改变 agent 的业务结果**。
// 因此这里所有失败都只落日志 / marker 行，从不抛给调用方。
import type { ProviderNeutralDatabase } from '@/db/query'
import { memoryDistillEvents } from '@/db/schema'
import { DISTILL_CAPTURE_FAILED_KIND } from '@/modules/runtime-management/public/types'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'
import { createLogger } from '@/util/log'

const log = createLogger('memory-distill-session-event-sink')

/**
 * `memory_distill_events.session_id` 是 NOT NULL，而流首的若干事件可能在 runtime 报出
 * session id **之前**到达。用 `parseSessionTree` 自己的未知会话哨兵，这样即使一次运行从头到尾
 * 没拿到 id，详情页仍能渲染出该 attempt（尤其是 `markTerminal` 写的 capture-failed marker
 * ——AC-9 的失败必须在 UI 上留痕）。
 */
const UNKNOWN_SESSION_ID = '(unknown)'

type SinkEvent = Parameters<SystemAgentEventSinkV1['append']>[0]

interface PendingRow {
  ts: number
  kind: string
  payload: string
  sessionId: string | null
  parentSessionId: string | null
}

export interface MemoryDistillSessionEventSinkInput {
  readonly distillJobId: string
  readonly attemptIndex: number
}

/**
 * 每次 `runDistill` 的一轮运行一个 sink 实例。写入串行化（promise tail），顺序即事件顺序
 * ——`listEvents` 按 `(attemptIndex, ts, id)` 排序，乱序写会让会话树错位。
 */
class MemoryDistillSessionEventSink implements SystemAgentEventSinkV1 {
  private tail: Promise<void> = Promise.resolve()
  private rootSessionId: string | undefined
  /** root 未知前的缓冲：flush 时统一补上 root id。 */
  private pending: PendingRow[] = []
  private stopped = false

  constructor(
    private readonly db: ProviderNeutralDatabase,
    private readonly job: MemoryDistillSessionEventSinkInput,
  ) {}

  append(event: SinkEvent): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(async () => {
      const row: PendingRow = {
        ts: event.ts,
        kind: event.kind,
        payload: event.payload,
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
      }
      if (row.sessionId === null && this.rootSessionId === undefined) {
        this.pending.push(row)
        return
      }
      await this.insert([row])
    })
  }

  setRootSessionId(sessionId: string, _previousSessionId?: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(async () => {
      this.rootSessionId = sessionId
      if (this.pending.length === 0) return
      const buffered = this.pending
      this.pending = []
      await this.insert(buffered)
    })
  }

  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(async () => {
      // 缓冲里还压着行 → 用哨兵落盘，别把证据丢了。
      if (this.pending.length > 0) {
        const buffered = this.pending
        this.pending = []
        await this.insert(buffered)
      }
      if (state !== 'complete') {
        await this.insert([
          {
            ts: Date.now(),
            kind: DISTILL_CAPTURE_FAILED_KIND,
            payload: JSON.stringify({
              sessionID: this.rootSessionId ?? null,
              reason: reason ?? state,
            }),
            sessionId: null,
            parentSessionId: null,
          },
        ])
      }
      this.stopped = true
    })
  }

  private async insert(rows: readonly PendingRow[]): Promise<void> {
    if (rows.length === 0) return
    const values = rows.map((row) => ({
      distillJobId: this.job.distillJobId,
      attemptIndex: this.job.attemptIndex,
      ts: row.ts,
      kind: row.kind,
      payload: row.payload,
      sessionId: row.sessionId ?? this.rootSessionId ?? UNKNOWN_SESSION_ID,
      parentSessionId: row.parentSessionId,
    }))
    try {
      await this.db.insert(memoryDistillEvents).values(values)
    } catch (err) {
      // 观测面失败不得反噬业务结果（sessionEventSink.ts 的契约）。
      log.warn('distill-session-event-persist-failed', {
        distillJobId: this.job.distillJobId,
        attemptIndex: this.job.attemptIndex,
        rows: values.length,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => undefined)
    return next
  }
}

export function createMemoryDistillSessionEventSink(db: ProviderNeutralDatabase) {
  return (input: MemoryDistillSessionEventSinkInput): SystemAgentEventSinkV1 =>
    new MemoryDistillSessionEventSink(db, input)
}
