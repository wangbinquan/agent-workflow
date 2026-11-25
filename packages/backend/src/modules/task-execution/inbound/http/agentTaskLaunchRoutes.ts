// RFC-589 — launch a single-agent task (`POST /api/agents/:id/tasks`). Moved verbatim from the agent routes (formerly
// `routes/agents.ts`, now resource-catalog's `inbound/http/agentRoutes.ts`): launching is a task-execution operation (the
// endpoint gates on `tasks:execute`), and resource-catalog may not take task-execution's launch operations (the DAG has
// task-execution -> resource-catalog only). The agent is read through resource-catalog's public query first; missing and
// not visible answer the same 404 as every other agent endpoint. The assembly root mounts this right after
// `mountAgentRoutes`, with the same dependency object.

import { rejectRetiredStartTaskKeys, StartAgentTaskSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AgentOperationContext } from '@/modules/resource-catalog/public/participants'
import type { AgentQueries } from '@/modules/resource-catalog/public/queries'
import type { AgentCatalogResource } from '@/modules/resource-catalog/public/types'
import { registerRoute } from '@/routes/registry'
// RFC-243 T2: agent launches go through the unified executor facade — this
// route must not call startAgentTask directly (source-text lock).
import { parseMultipartLaunch } from '@/platform/http/multipartLaunch'
import { NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import type {
  AgentRouteTaskLaunchOperations,
  TaskRouteMultipartFilePart,
  TaskRouteUploadLimits,
} from '../../application/ports/subjectTaskLaunch'

export interface AgentTaskLaunchRouteDependencies {
  /** The agent the launch starts from (resource-catalog's catalog query; only `get` is used). */
  readonly queries: Pick<AgentQueries, 'get'>
  readonly authorityFor: (actor: Actor) => AgentOperationContext
  /**
   * TaskExecution-owned launch boundary consumed by the Agent transport.  The
   * route never receives a database client or reconstructs provider-specific
   * launch dependencies.
   */
  readonly taskLaunch: AgentRouteTaskLaunchOperations
}

export function mountAgentTaskLaunchRoutes(
  app: Hono,
  module: AgentTaskLaunchRouteDependencies,
): void {
  const { queries } = module
  // RFC-099: load-or-404 that treats "missing" and "not visible" identically
  // (same code + message) so existence never leaks to non-granted users.
  async function loadVisibleAgent(actor: Actor, id: string): Promise<AgentCatalogResource> {
    const agent = await queries.get(module.authorityFor(actor), { id })
    if (agent === null) {
      throw new NotFoundError('agent-not-found', 'agent not found')
    }
    return agent
  }

  // RFC-165 §4 — launch a SINGLE-AGENT task (POST /api/agents/:id/tasks).
  // Service-layer entry for an agent subject; POST /api/tasks starts catalog
  // workflows. Permission-wise this
  // is a LAUNCH, gated by tasks:launch in server.ts (F15) — deliberately
  // exempt from the agents:write method gate. The schema only ever declared
  // modern space fields, so no raw-key gate is needed (workgroup precedent).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/agents/:id/tasks',
      executionGroup: 'task',
      // RFC-165 F15/N1: launching is a TASK operation on every subject face —
      // all three launch endpoints gate uniformly on the task execute point,
      // and the agent launch path is explicitly EXEMPT from the agent method
      // gate. Adding `agents:execute` here would silently reverse that
      // decision (and break its named regression, A9). RFC-247 D15 is "do not
      // change reach"; a mechanical `${resource}:execute` would have done
      // exactly that.
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Launch a task from an agent',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisibleAgent(actor, c.req.param('id'))
      // RFC-218: path<ext> input ports bind files via multipart — same parser
      // family as POST /api/tasks (platform/http/multipartLaunch). JSON stays the
      // only shape for text-port / zero-port launches.
      const ct = c.req.header('content-type') ?? ''
      let body: unknown
      let uploads:
        | { parts: TaskRouteMultipartFilePart[]; limits: TaskRouteUploadLimits }
        | undefined
      if (ct.toLowerCase().startsWith('multipart/form-data')) {
        const parsedForm = await parseMultipartLaunch(c.req.raw)
        body = parsedForm.payloadJson
        uploads = { parts: parsedForm.parts, limits: await module.taskLaunch.uploadLimits() }
      } else {
        try {
          body = await c.req.raw.json()
        } catch {
          body = {}
        }
      }
      // 实现门 P2 修复（F1 同型）：schema 非 strict，{scratch:true, repoPath}
      // 会被静默剥键降级成 scratch 启动——退役键必须在 parse 前整体拒收。
      const retired = rejectRetiredStartTaskKeys(body)
      if (retired !== null) {
        const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
        throw new ValidationError(
          clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
          clientOwnedGitIdentity
            ? `RFC-320 derives Git commit identity from the task creator; remove '${retired}'`
            : `field '${retired}' was retired by RFC-165 — launch with repoUrl/repos (file:// for local repos) or scratch`,
        )
      }

      // RFC-248 H9（实现门 P1）：`sourceTaskId` 由调用方控制。重放前先确认
      // 他**看得见**那个任务——否则「能启动某工作流但看不见任务 X」的用户可以
      // 传 X 的 id，让服务端读出 X 冻结的仓库构成并按它物化，而且泄漏形式是
      // 「任务成功启动」，完全不像一次越权。不可见与不存在同形（都 404）。
      {
        const src = (body as { sourceTaskId?: unknown }).sourceTaskId
        if (typeof src === 'string' && src.length > 0) {
          await module.taskLaunch.assertReplayVisible(actor, src)
        }
      }
      const parsed = StartAgentTaskSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('agent-launch-invalid', 'invalid agent launch payload', {
          issues: parsed.error.issues,
        })
      }
      const task = await module.taskLaunch.launch(actor, {
        agentId: existing.id,
        payload: parsed.data,
        ...(uploads === undefined ? {} : { uploads }),
      })
      return c.json(task, 201)
    },
  )
}
