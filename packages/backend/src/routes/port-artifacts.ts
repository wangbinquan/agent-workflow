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

import type { Hono } from 'hono'
import { extname } from 'node:path'
import { actorOf } from '@/auth/actor'
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'
import { registerRoute } from '@/routes/registry'
import { readPortArtifact } from '@/services/portArtifacts'
import { NotFoundError, ValidationError } from '@/util/errors'
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

export function mountPortArtifactRoutes(
  app: Hono,
  deps: { readonly taskExecutionReadModels: TaskExecutionReadModels },
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:taskId/port-artifacts/:nodeRunId/:portName',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read a node output port artifact',
    },
    async (c) => {
      const taskId = c.req.param('taskId')
      const nodeRunId = c.req.param('nodeRunId')
      // Hono 已 decode 路径段——不可二次 decodeURIComponent：合法端口名含字面
      // `%` 时前端发 %25、Hono 还原为 `%`，二次 decode 抛 URIError → 500
      // （Codex 实现门 P2）。
      const portName = c.req.param('portName')

      const actor = actorOf(c)
      const lookup = await deps.taskExecutionReadModels.portArtifacts.find({
        actor: {
          userId: actor.user.id,
          canReadAllTasks: actor.permissions.has('tasks:read:all'),
        },
        taskId,
        nodeRunId,
        portName,
      })
      if (lookup.status === 'task-not-found') {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
      if (lookup.status === 'node-run-not-found') {
        throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
      }
      if (lookup.status === 'port-not-found') {
        throw new NotFoundError('port-not-found', `port '${portName}' not found on run`)
      }
      const artifact = lookup.artifact

      const itemParam = c.req.query('item')
      const idx = itemParam === undefined ? undefined : Number(itemParam)
      if (idx !== undefined && (!Number.isInteger(idx) || idx < 0)) {
        throw new ValidationError(
          'port-artifact-bad-item',
          `item '${itemParam}' must be a non-negative integer`,
        )
      }

      // RFC-005 同款：归档路径锚在 daemon app home（Paths.root getter，惰性读
      // AGENT_WORKFLOW_HOME）——AppDeps 不携带 appHome（对齐 reviews.ts appHomeFor）。
      // 选择性读取（Codex 实现门 P2）：元数据请求零字节读，item 请求只读该下标。
      const read = readPortArtifact({
        appHome: Paths.root,
        taskId,
        archiveJson: artifact.archiveJson,
        content: artifact.content,
        kind: artifact.kind,
        fallbackWorktreeRoot: artifact.worktreePath,
        legacyRepoDirName: artifact.legacyRepoDirName,
        only: idx === undefined ? 'meta' : idx,
      })

      if (idx === undefined) {
        return c.json({
          items: read.items.map((it) => ({
            path: it.path,
            size: it.size,
            truncated: it.truncated,
            source: it.source,
          })),
        })
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
      // 拷贝为独立 ArrayBuffer：BodyInit 需要 ArrayBuffer 域的字节（Buffer 的
      // buffer 是 ArrayBufferLike 且可能是共享大池的切片）；≤2MiB 一次拷贝可忽略，
      // 且免去 `as` 逃逸（routes-no-cast 守卫）。
      return c.body(new Uint8Array(item.bytes).buffer)
    },
  )
}
