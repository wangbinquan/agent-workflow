// RFC-027 T4 — service helper for the GET …/node-runs/:nodeRunId/session
// endpoint. Stitches together: (a) the persisted node_run row (for
// promptText + startedAt), (b) the per-row sessionId-tagged events, and
// (c) the workflow snapshot's primary-agent-name resolution. Hands the
// final SessionTree off to the route layer (which serializes via
// SessionViewResponseSchema).
//
// We keep the pure parse step (parseSessionTree) in @agent-workflow/shared
// so the frontend can also call it if it ever needs to re-derive the
// tree client-side from raw event rows. Here we just do the IO and
// pass-through.

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  isAgentNodeKind,
  parseSessionTree,
  type ParseSessionInputEvent,
  type SessionTree,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns, tasks } from '@/db/schema'
import { readArchivedEvents } from '@/services/eventsArchive'
import { readNodeRunPrompt } from '@/services/nodeRunPrompt'
import { DomainError, NotFoundError } from '@/util/errors'
import { Paths } from '@/util/paths'

/** 会话树是「读全历史」的视图,但仍要有界:单个 node_run 的归档回读封顶,
 *  避免一次请求把整份 JSONL 拉进内存(实现门 P1-2 的同源约束)。 */
const ARCHIVED_SESSION_EVENT_CAP = 20_000
/**
 * RFC-311 T13：DB 侧事件的两段上限。
 * - PREFIX 只为**定根**：`deriveRootSessionId` 只需要最早那几条带 sessionId 的事件，
 *   给足余量即可，不必大。
 * - TAIL 承载用户实际要看的近期内容，与归档侧上限同量级。
 */
const SESSION_ROOT_PREFIX_CAP = 500
const SESSION_TAIL_CAP = 20_000

/**
 * Workflow node kinds for which an opencode session exists (everything
 * an agent process produces). Input / output / wrapper / review nodes
 * never spawn opencode so they have nothing to render in the Session
 * tab; the route returns 410 for those so the frontend can show a
 * "session not applicable" hint instead of an empty tree.
 */
// RFC-060 PR-E: agent-multi removed; agent-single is the only prompt-capable kind.

export async function getSessionTree(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  /** 测试注入:把两段上限调到几十条，才测得出「超限时根还对不对」。 */
  caps: { rootPrefix?: number; tail?: number } = {},
): Promise<{ tree: SessionTree }> {
  const taskRows = await db
    .select({ snapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  const runRows = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      promptText: nodeRuns.promptText,
      // RFC-311 T21:新行正文在文件里,取路径供双读还原。
      promptPath: nodeRuns.promptPath,
      startedAt: nodeRuns.startedAt,
      opencodeSessionId: nodeRuns.opencodeSessionId,
      retryIndex: nodeRuns.retryIndex,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const run = runRows[0]
  if (run === undefined || run.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  const { nodeKind, primaryAgentName } = resolveNodeMetaFromSnapshot(
    taskRows[0]!.snapshot,
    run.nodeId,
  )
  if (nodeKind !== null && !isAgentNodeKind(nodeKind)) {
    throw new DomainError(
      'node-kind-not-supported',
      `node '${run.nodeId}' (kind=${nodeKind}) does not produce an opencode session`,
      410,
    )
  }

  // RFC-027 §UX merge — when the requested node_run shares an opencode
  // session_id with sibling node_runs in this task (RFC-026 inline
  // clarify reruns), unify their events + treat each round's promptText
  // as a separate user message in the merged conversation flow.
  const inlineSiblings = await loadInlineSiblings(db, taskId, run)
  const targetNodeRunIds = inlineSiblings.map((s) => s.id)
  const promptText = inlineSiblings[0]!.promptBody
  const startedAt = inlineSiblings[0]!.startedAt
  const extraUserPrompts: Array<{ text: string; ts: number }> = []
  for (let i = 1; i < inlineSiblings.length; i++) {
    const s = inlineSiblings[i]!
    if (s.promptBody !== null && s.promptBody !== '') {
      extraUserPrompts.push({ text: s.promptBody, ts: s.startedAt ?? 0 })
    }
  }

  const logsDir = Paths.logsDir
  // RFC-311 T13：DB 侧此前**无上限**（归档侧早就有 ARCHIVED_SESSION_EVENT_CAP）。
  // 长会话下这条查询会把该任务的全部事件一次性取回，跑在 daemon 唯一的同步连接上。
  //
  // 但这里**不能像 stdout 那样只保尾**：紧接着的注释已经记着，会话前半段一旦缺失，
  // `deriveRootSessionId` 会退化成「取残留事件里的第一个 sessionId」（通常是子代理），
  // 整棵树就以子代理为根渲染——不是少了历史，是渲染出**错误结构**。
  // 所以取两段：**最早 PREFIX 条**（定根用，必须在）+ **最新 TAIL 条**（近期内容），
  // 中间那段在超限时舍弃。两条查询各自有界，合并后按 (ts, id) 去重排序。
  const columns = {
    id: nodeRunEvents.id,
    ts: nodeRunEvents.ts,
    kind: nodeRunEvents.kind,
    sessionId: nodeRunEvents.sessionId,
    parentSessionId: nodeRunEvents.parentSessionId,
    payload: nodeRunEvents.payload,
  }
  const where = inArray(nodeRunEvents.nodeRunId, targetNodeRunIds)
  const [prefix, tailDesc] = await Promise.all([
    db
      .select(columns)
      .from(nodeRunEvents)
      .where(where)
      .orderBy(asc(nodeRunEvents.ts), asc(nodeRunEvents.id))
      .limit(caps.rootPrefix ?? SESSION_ROOT_PREFIX_CAP),
    db
      .select(columns)
      .from(nodeRunEvents)
      .where(where)
      .orderBy(desc(nodeRunEvents.ts), desc(nodeRunEvents.id))
      .limit(caps.tail ?? SESSION_TAIL_CAP),
  ])
  const byId = new Map<number, (typeof prefix)[number]>()
  for (const row of prefix) byId.set(row.id, row)
  for (const row of tailDesc) byId.set(row.id, row)
  const rows = [...byId.values()].sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts - b.ts))

  // 实现门 P1-4:RFC-311 的字节水位把事件归档从「生产从未触发」变成长会话常态,
  // 而这条路径此前只读 DB——归档掉的前半段会话一旦消失,deriveRootSessionId 会
  // 退化成「取残留事件里的第一个 sessionId」(通常是**子代理**会话),整棵对话树
  // 就以子代理为根渲染:不是少了历史,是渲染出错误结构。归档 JSONL 现在同样落
  // sessionId/parentSessionId,这里按 node_run 逐个补回并与 DB 行合并。
  const archivedEvents: ParseSessionInputEvent[] = []
  for (const id of targetNodeRunIds) {
    const archived = await readArchivedEvents(logsDir, taskId, id, 0, ARCHIVED_SESSION_EVENT_CAP)
    for (const a of archived) {
      archivedEvents.push({
        id: a.id,
        ts: a.ts,
        kind: a.kind,
        sessionId: a.sessionId,
        parentSessionId: a.parentSessionId,
        payload: a.payload,
      })
    }
  }
  const events: ParseSessionInputEvent[] = [
    ...archivedEvents,
    ...rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      sessionId: r.sessionId,
      parentSessionId: r.parentSessionId,
      payload: r.payload,
    })),
  ].sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts - b.ts))

  const rootSessionId = deriveRootSessionId(events)

  const tree = parseSessionTree({
    rootSessionId,
    promptText,
    startedAt,
    primaryAgentName: primaryAgentName ?? 'agent',
    events,
    ...(extraUserPrompts.length > 0 ? { extraUserPrompts } : {}),
  })
  return { tree }
}

/** RFC-311 T21:字段刻意**不叫** promptText——那个名字从此只指数据库那一列。
 *  这里装的是已经过 `readNodeRunPrompt` 双读解析的正文,改名让「读了列」与
 *  「读了正文」在类型层就分得开,守卫因此可以简单地禁掉一切 `.promptText` 读。 */
interface InlineSiblingRow {
  id: string
  promptBody: string | null
  startedAt: number | null
  retryIndex: number
}

/**
 * Returns the chronological chain of node_runs that share an opencode
 * session id with the requested run. When opencodeSessionId is null
 * (legacy / isolated mode), returns just [run] so the rest of
 * getSessionTree degrades to the pre-merge single-attempt query.
 */
async function loadInlineSiblings(
  db: DbClient,
  taskId: string,
  run: {
    id: string
    promptText: string | null
    promptPath: string | null
    startedAt: number | null
    opencodeSessionId: string | null
    retryIndex: number
  },
): Promise<InlineSiblingRow[]> {
  if (run.opencodeSessionId === null) {
    return [
      {
        id: run.id,
        promptBody: readNodeRunPrompt(run),
        startedAt: run.startedAt,
        retryIndex: run.retryIndex,
      },
    ]
  }
  const rows = await db
    .select({
      id: nodeRuns.id,
      promptText: nodeRuns.promptText,
      promptPath: nodeRuns.promptPath,
      startedAt: nodeRuns.startedAt,
      retryIndex: nodeRuns.retryIndex,
    })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.opencodeSessionId, run.opencodeSessionId)))
  if (rows.length === 0) {
    return [
      {
        id: run.id,
        promptBody: readNodeRunPrompt(run),
        startedAt: run.startedAt,
        retryIndex: run.retryIndex,
      },
    ]
  }
  // RFC-074 PR-C: chronological ordering is pure ULID id-order (creation
  // order) — the first sibling is round 0 (smallest id, the original ask) and
  // later clarify rounds / retries (minted later, larger id) append in order.
  // This replaces the retired (clarifyIteration, retryIndex, startedAt) sort.
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // RFC-311 T21:行里带的是列或路径,统一在出口处双读还原成正文,调用方(会话
  // 视图把首条当主 prompt、其余当追加轮次)看到的形状不变。
  return rows.map((r) => ({
    id: r.id,
    promptBody: readNodeRunPrompt(r),
    startedAt: r.startedAt,
    retryIndex: r.retryIndex,
  }))
}

interface SnapshotNode {
  id?: unknown
  kind?: unknown
  agentName?: unknown
}

function resolveNodeMetaFromSnapshot(
  snapshotJson: string,
  nodeId: string,
): { nodeKind: string | null; primaryAgentName: string | null } {
  try {
    const snap = JSON.parse(snapshotJson) as { nodes?: SnapshotNode[] }
    const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
    for (const n of nodes) {
      if (typeof n.id !== 'string' || n.id !== nodeId) continue
      const kind = typeof n.kind === 'string' ? n.kind : null
      const name = typeof n.agentName === 'string' ? n.agentName : null
      return { nodeKind: kind, primaryAgentName: name }
    }
  } catch {
    // Snapshot unreadable → fall through with nulls; route still 200s with
    // a best-effort tree (no kind gating, agentName="agent" fallback).
  }
  return { nodeKind: null, primaryAgentName: null }
}

function deriveRootSessionId(events: ParseSessionInputEvent[]): string | null {
  for (const e of events) {
    if (e.parentSessionId === null && e.sessionId !== null) return e.sessionId
  }
  for (const e of events) {
    if (e.sessionId !== null) return e.sessionId
  }
  return null
}
