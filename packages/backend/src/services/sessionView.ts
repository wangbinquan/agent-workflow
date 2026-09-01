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

import {
  isAgentNodeKind,
  parseSessionTree,
  type ParseSessionInputEvent,
  type SessionTree,
} from '@agent-workflow/shared'
import type {
  TaskSessionReadModel,
  TaskSessionRunSource,
} from '@/modules/task-execution/public/types'
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
  readModel: TaskSessionReadModel,
  taskId: string,
  nodeRunId: string,
  /** 测试注入:把两段上限调到几十条，才测得出「超限时根还对不对」。 */
  caps: { rootPrefix?: number; tail?: number } = {},
): Promise<{ tree: SessionTree }> {
  const prefixCap = caps.rootPrefix ?? SESSION_ROOT_PREFIX_CAP
  const tailCap = caps.tail ?? SESSION_TAIL_CAP
  const source = await readModel.find({
    taskId,
    nodeRunId,
    rootPrefixCap: prefixCap,
    tailCap,
  })
  if (source.status === 'task-not-found') {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  if (source.status === 'node-run-not-found') {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
  const run = source.run

  const { nodeKind, primaryAgentName } = resolveNodeMetaFromSnapshot(
    source.workflowSnapshot,
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
  const inlineSiblings = source.siblings.map(materializeInlineSibling)
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
  // RFC-314 D2：窗口**按 id 取**，且**逐 node_run** 查询。两处都不是可有可无的：
  //   ① `ORDER BY ts` 与 `idx_events_node (node_run_id, id)` 不匹配 ⇒ USE TEMP B-TREE：
  //      为了挑出 2 万条，SQLite 先把该 run 的全部事件**连 payload** 灌进排序器。生产量级
  //      实测（单 run 10.8 万事件）**461.5ms + 122.0ms 两条**。改按 id 排，排序器消失。
  //   ② 只换排序键不够：`node_run_id IN (?,?,?)` 之后 SQLite 无法沿单一索引顺序产出全局
  //      有序结果，EXPLAIN 实测**照样 TEMP B-TREE**。所以按 run 各取各的窗口再合并。
  // 输出顺序不变——下面那次 (ts, id) 排序本来就在，语义差异只落在「哪些行进窗口」
  // （proposal §4 B2）。定根用的 prefix 按 id 取反而更贴合用途：root 会话的事件本就是
  // 最先写入的那批。
  // The selected provider adapter owns the bounded SQL windows; this service
  // only merges the closed rows with the filesystem archive projection.
  const rows = source.events

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
function materializeInlineSibling(run: TaskSessionRunSource): InlineSiblingRow {
  return {
    id: run.id,
    promptBody: readNodeRunPrompt(run),
    startedAt: run.startedAt,
    retryIndex: run.retryIndex,
  }
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
