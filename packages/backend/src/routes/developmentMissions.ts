// RFC-310 PR-2 T31 —— DevelopmentMission 的 HTTP 面（design §12.1 的 PR-2 子集）。
//
// launch/list/get/requirement-source/cancel/retry/decision-trace 七端点；
// handoff/attach/resume/upgrade 与 answers/preview 随对应批次（PR-3/PR-7/PR-8）
// 挂载并在届时把四个剩余 permission 点入目录。mutation 都返回可追踪对象
// （missionId+status），不返回裸「已接受」。

import type { Hono } from 'hono'
import { z } from 'zod'

import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import {
  cancelMission,
  launchMission,
  retryBlockedMission,
  selectMissionRequirementSource,
  type LaunchDeps,
} from '@/modules/development-automation/application/commands/launchMission'
import { createSqliteAdmissionLookup } from '@/modules/development-automation/infrastructure/sqliteAdmissionLookup'
import {
  getDecisionTrace,
  getMissionDetail,
  listMissionSummaries,
} from '@/modules/development-automation/infrastructure/missionReadModels'
import { createSqliteMissionStore } from '@/modules/development-automation/infrastructure/sqliteMissionStore'
import type { AppDeps } from '@/server'
import { NotFoundError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export function mountDevelopmentMissionRoutes(app: Hono, deps: AppDeps): void {
  const launchDeps: LaunchDeps = {
    store: createSqliteMissionStore(deps.db),
    lookup: createSqliteAdmissionLookup(deps.db),
    now: () => Date.now(),
  }

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Launch a development mission (direct body/uploads or external id)',
    },
    async (c) => {
      const actor = actorOf(c)
      const body = z.record(z.unknown()).parse(await safeJsonOrEmpty(c.req.raw))
      const result = await launchMission(launchDeps, { ...body, createdBy: actor.user.id })
      return c.json(result, result.created ? 201 : 200)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'List development missions',
    },
    async (c) => c.json({ items: listMissionSummaries(deps.db) }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions/:id',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'Read one development mission (sources, readiness, block detail)',
    },
    async (c) => {
      const detail = getMissionDetail(deps.db, c.req.param('id'))
      if (detail === null) throw new NotFoundError('mission-not-found', 'mission not found')
      return c.json(detail)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/requirement-source',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Resolve the requirement source for a mission awaiting selection',
    },
    async (c) => {
      const body = z
        .object({ sourceKey: z.string().min(1) })
        .strict()
        .parse(await safeJsonOrEmpty(c.req.raw))
      const result = await selectMissionRequirementSource(launchDeps, {
        missionId: c.req.param('id'),
        sourceKey: body.sourceKey,
      })
      return c.json({ missionId: c.req.param('id'), ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/cancel',
      permissions: ['development-missions:cancel'],
      tokenAccess: 'allow',
      summary: 'Cancel a mission (fences writes; settles dispatched effects first)',
    },
    async (c) => {
      const result = await cancelMission(launchDeps, { missionId: c.req.param('id') })
      return c.json({ missionId: c.req.param('id'), ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/retry',
      permissions: ['development-missions:retry'],
      tokenAccess: 'allow',
      summary: 'Retry a blocked mission after remediation',
    },
    async (c) => {
      const result = await retryBlockedMission(launchDeps, { missionId: c.req.param('id') })
      return c.json({ missionId: c.req.param('id'), ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions/:id/decision-trace',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'Read the canonical guard/rule decision trace for a mission',
    },
    async (c) => {
      if (getMissionDetail(deps.db, c.req.param('id')) === null) {
        throw new NotFoundError('mission-not-found', 'mission not found')
      }
      return c.json({ items: getDecisionTrace(deps.db, c.req.param('id')) })
    },
  )
}
