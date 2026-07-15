// GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName[?item=N] — RFC-193 §4.7.
//
// 阅读语义的统一出口：path 形端口的内容从 emit-time 归档读出（readPortArtifact
// 三级链：archive → task worktree 回退〔存量行〕→ missing），与 worktree 生命
// 周期解耦——wrapper 内节点的输出、worktree 已被 GC 的历史任务都照常可读。
//
//   - 无 ?item：元数据 JSON `{ items: [{ path, size, truncated, source }] }`。
//   - ?item=N：该 item 的原始字节，MIME 按源扩展名（对齐 worktree-files 表），
//     截断副本带 `X-AW-Artifact-Truncated: 1` 响应头；missing → 404。
//
// 门：canViewTask（任务成员制，RFC-099 D20——与 worktree-files.ts 同形）+
// nodeRun 归属校验（防跨任务读）。读取全程走 readPortArtifact（archive 引用
// containment + worktree lexical/realpath 双防御在原语内部，API 不自己拼根）。

import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { extname } from 'node:path'
import { actorOf } from '@/auth/actor'
import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { AppDeps } from '@/server'
import { readPortArtifact } from '@/services/portArtifacts'
import { canViewTask } from '@/services/taskCollab'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

export function mountPortArtifactRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks/:taskId/port-artifacts/:nodeRunId/:portName', async (c) => {
    const taskId = c.req.param('taskId')
    const nodeRunId = c.req.param('nodeRunId')
    // Hono 已按 URL 规则 decode 路径段；portName 是 percent-encode 往返段（D3）。
    const portName = decodeURIComponent(c.req.param('portName'))

    const taskRows = await deps.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    const task = taskRows[0]
    if (task === undefined) {
      throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    }
    const actor = actorOf(c)
    if (!(await canViewTask(deps.db, actor, task))) {
      throw new ForbiddenError('task-not-visible', `task '${taskId}' is not visible to this actor`)
    }

    // nodeRun 归属校验 — 跨任务 runId 与不存在同形 404（RFC-099 同形性原则）。
    const runRows = await deps.db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.taskId, taskId)))
      .limit(1)
    if (runRows[0] === undefined) {
      throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
    }

    const outRows = await deps.db
      .select()
      .from(nodeRunOutputs)
      .where(and(eq(nodeRunOutputs.nodeRunId, nodeRunId), eq(nodeRunOutputs.portName, portName)))
      .limit(1)
    const row = outRows[0]
    if (row === undefined) {
      throw new NotFoundError('port-not-found', `port '${portName}' not found on run`)
    }

    // RFC-005 同款：归档路径锚在 daemon app home（Paths.root getter，惰性读
    // AGENT_WORKFLOW_HOME）——AppDeps 不携带 appHome（对齐 reviews.ts appHomeFor）。
    const read = readPortArtifact({
      appHome: Paths.root,
      taskId,
      archiveJson: row.archiveJson ?? null,
      content: row.content,
      kind: row.kind ?? null,
      fallbackWorktreeRoot: task.worktreePath,
    })

    const itemParam = c.req.query('item')
    if (itemParam === undefined) {
      return c.json({
        items: read.items.map((it) => ({
          path: it.path,
          size: it.size,
          truncated: it.truncated,
          source: it.source,
        })),
      })
    }
    const idx = Number(itemParam)
    if (!Number.isInteger(idx) || idx < 0) {
      throw new ValidationError(
        'port-artifact-bad-item',
        `item '${itemParam}' must be a non-negative integer`,
      )
    }
    const item = read.items[idx]
    if (item === undefined || item.source === 'missing') {
      throw new NotFoundError(
        'port-artifact-missing',
        `item ${idx} of port '${portName}' has no readable artifact (archive absent and worktree fallback failed)`,
      )
    }
    const mime =
      (item.path !== null ? MIME_BY_EXT[extname(item.path).toLowerCase()] : undefined) ??
      'application/octet-stream'
    c.header('Content-Type', mime)
    if (item.truncated) c.header('X-AW-Artifact-Truncated', '1')
    return c.body(item.bytes as Uint8Array<ArrayBuffer>)
  })
}
