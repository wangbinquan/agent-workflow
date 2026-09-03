// RFC-101 — memory→skill fusion HTTP routes.
//
//   POST   /api/fusions                 launch a fusion (skill + memories + intent)
//   GET    /api/fusions?skillId=         list (own + admin-all)
//   GET    /api/fusions/:id              detail (owner / admin)
//   POST   /api/fusions/:id/approve      apply the proposed change
//   POST   /api/fusions/:id/reject       request changes + re-run
//   POST   /api/fusions/:id/cancel       cancel
//
// Authentication is the /api/* multiAuth gate; per-fusion authorization (skill
// write, memory manage, fusion ownership) is enforced in the KE application.
//
// RFC-353 T8（RFC-294 W4-E3）：本文件自 `routes/fusions.ts` 迁入 knowledge-evolution 的
// inbound 层，并收成 **decode-call-map**——「谁看得见哪条融合」原先在三个 handler 里各手写
// 一遍（列表过滤 / 待办计数 / 详情 404），现在只解出 viewer 交给 application，判据在
// `domain/fusionVisibility`。

import { FusionStatusSchema, LaunchFusionSchema, RejectFusionSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { directTaskInitiatorFromActorSource } from '@/modules/task-execution/inbound/directTaskInitiator'
import { registerRoute } from '@/routes/registry'
// RFC-353 T12：inbound 是本 context 自己的投递适配器，直接取 `application/`。
// **不经自己的 `public/`**——那一层是给别的 context 用的，只被自家 inbound 消费的
// 符号按 RFC-294 design §3.3「无 consumer 不公开」就不该出现在 public 面上。
import {
  approveFusion,
  cancelFusion,
  createFusion,
  rejectFusion,
  type FusionDeps,
} from '../application/fusionOrchestration'
import {
  countVisibleAwaitingApprovalFusions,
  getVisibleFusion,
  listVisibleFusionSummaries,
  type FusionViewer,
} from '../application/fusionViews'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { hasResourceAclBypass } from '@/services/resourceAcl'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'
import { safeJsonOrEmpty } from '@/util/http'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import type { MemoryScopeAuthority } from '@/modules/memory/public/catalog'
import type { FusionOperations } from '@/modules/knowledge-evolution/public/participants'
import { directRequestAuthority } from '@/routes/operationAuthority'

export interface FusionRouteDependencies {
  readonly operations: FusionOperations
  readonly configPath: string
  readonly directAuthority: DirectAuthorityBinding
}

export function mountFusionRoutes(app: Hono, deps: FusionRouteDependencies): void {
  /** 把请求上的操作者解成 application 认识的 viewer；这里不做任何可见性判断。 */
  function viewerOf(c: Parameters<Parameters<typeof registerRoute>[2]>[0]): FusionViewer {
    const actor = actorOf(c)
    return { userId: actor.user.id, aclBypass: hasResourceAclBypass(actor) }
  }

  function fusionDeps(): FusionDeps {
    // RFC-108 T4 (Codex impl gate P2): thread the per-node timeout floor so a
    // hung fusion agent is bounded like any other node. RFC-115: also thread
    // the global retry budget + default runtime (Codex F3) into the fusion task.
    const { defaultPerNodeTimeoutMs, defaultNodeRetries, sessionRestartBudget, defaultRuntime } =
      resolveLaunchRuntimeConfig(deps.configPath)
    return {
      operations: deps.operations,
      appHome: Paths.root,
      configPath: deps.configPath,
      ...(defaultPerNodeTimeoutMs !== undefined ? { defaultPerNodeTimeoutMs } : {}),
      ...(defaultNodeRetries !== undefined ? { defaultNodeRetries } : {}),
      ...(sessionRestartBudget !== undefined ? { sessionRestartBudget } : {}),
      ...(defaultRuntime !== undefined ? { defaultRuntime } : {}),
    }
  }

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions',
      permissions: ['tasks:execute', 'skills:update'],
      tokenAccess: 'allow',
      summary: 'Launch a memory→skill fusion (runs an agent)',
    },
    async (c) => {
      const parsed = LaunchFusionSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('fusion-invalid', 'invalid fusion payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const scopeAuthority: MemoryScopeAuthority = Object.freeze({
        actor,
        authority: directRequestAuthority(deps.directAuthority, actor),
      })
      const fusion = await createFusion(
        parsed.data,
        fusionDeps(),
        scopeAuthority,
        directTaskInitiatorFromActorSource(actor.source),
      )
      return c.json(fusion, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/fusions',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'List fusions',
    },
    async (c) => {
      const skillId = c.req.query('skillId')
      // Validate ?status against the enum (no `as` cast — RFC-054 W1-7); an
      // unknown value is treated as "no status filter".
      const statusRaw = c.req.query('status')
      const statusParsed =
        statusRaw !== undefined ? FusionStatusSchema.safeParse(statusRaw) : undefined
      const status = statusParsed?.success === true ? statusParsed.data : undefined
      // listFusionSummaries pushes status/skillId into SQL and never reads the
      // proposedDiff, so the inbox's 15s poll stays cheap. Full diff: /:id.
      return c.json(
        await listVisibleFusionSummaries(fusionDeps(), viewerOf(c), {
          ...(skillId ? { skillId } : {}),
          ...(status ? { status } : {}),
        }),
      )
    },
  )

  // Left-nav inbox badge. Reconciles running fusions (lazy done-detection), so
  // a fusion whose engine task just finished is surfaced within one poll. MUST
  // precede '/api/fusions/:id' so 'pending-count' isn't captured as an id.
  // Uses a narrow (id, ownerUserId) projection — no diff read/parse per poll.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/fusions/pending-count',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Count of fusions awaiting approval',
    },
    async (c) => {
      return c.json({
        count: await countVisibleAwaitingApprovalFusions(fusionDeps(), viewerOf(c)),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/fusions/:id',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Get one fusion',
    },
    async (c) => {
      // RFC-099-style existence isolation：不可见与不存在同形，判据在 application。
      const fusion = await getVisibleFusion(fusionDeps(), viewerOf(c), c.req.param('id'))
      if (fusion === null) {
        throw new NotFoundError('fusion-not-found', `fusion '${c.req.param('id')}' not found`)
      }
      return c.json(fusion)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions/:id/approve',
      permissions: ['skills:update', 'memory:update'],
      tokenAccess: 'allow',
      summary: 'Approve a fusion (bumps the skill version and fuses memory)',
    },
    async (c) => {
      return c.json(await approveFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions/:id/reject',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Reject a fusion and re-run it',
    },
    async (c) => {
      const parsed = RejectFusionSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('fusion-reject-invalid', 'invalid reject payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      return c.json(
        await rejectFusion(
          fusionDeps(),
          c.req.param('id'),
          parsed.data.feedback,
          actor,
          directTaskInitiatorFromActorSource(actor.source),
        ),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions/:id/cancel',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Cancel a fusion',
    },
    async (c) => {
      return c.json(await cancelFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
    },
  )
}
