// RFC-353 T9（RFC-294 W4-E3）—— `GET /api/skills/:id/provenance`。
//
// 路径挂在 `/api/skills/*` 下（用户视角这就是技能详情的一部分），但**实现归
// knowledge-evolution**：它要把 resource-catalog 的版本流水与 memory 的融合记录拼起来，
// 那是知识演化的判断，两个 owner 谁都不该替对方拼。RFC-294 的目标边表里
// `knowledge-evolution → resource-catalog` 与 `→ memory` 都在，反向边不在，
// 所以只能由 KE 这边挂路由并向下取用。
//
// 路由本身只 decode-call-map：解出技能 id 与操作者，确认技能可见（不可见与不存在同形，
// RFC-099），再把 application 的结果原样 json 出去。

import type { Hono } from 'hono'

import { actorOf, type Actor } from '@/auth/actor'
import {
  bindSkillProvenanceDeps,
  getSkillProvenance,
} from '@/modules/knowledge-evolution/public/queries'
import type { FusedIntoSkillMemory, MemoryScopeAuthority } from '@/modules/memory/public/catalog'
import type { SkillOperationContext } from '@/modules/resource-catalog/public/participants'
import type { SkillQueries, SkillVersionQueries } from '@/modules/resource-catalog/public/queries'
import { registerRoute } from '@/routes/registry'
import { NotFoundError } from '@/util/errors'

export interface SkillProvenanceRouteDependencies {
  readonly skills: Pick<SkillQueries, 'get'>
  readonly versions: Pick<SkillVersionQueries, 'list'>
  readonly authorityFor: (actor: Actor) => SkillOperationContext
  readonly memoryAuthorityFor: (actor: Actor) => MemoryScopeAuthority
  readonly listFusedInto: (skillId: string) => Promise<FusedIntoSkillMemory[]>
  readonly filterVisibleMemories: (
    authority: MemoryScopeAuthority,
    rows: readonly FusedIntoSkillMemory[],
  ) => Promise<FusedIntoSkillMemory[]>
}

export function mountSkillProvenanceRoutes(
  app: Hono,
  deps: SkillProvenanceRouteDependencies,
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/provenance',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Where each version of a skill came from (fused memories per version)',
    },
    async (c) => {
      const actor = actorOf(c)
      const id = c.req.param('id')
      const skillAuthority = deps.authorityFor(actor)
      // RFC-099 存在性隔离：技能不可见与不存在同形，和 `/api/skills/:id` 一致。
      const skill = await deps.skills.get(skillAuthority, { id })
      if (skill === null) throw new NotFoundError('skill-not-found', 'skill not found')
      return c.json(
        await getSkillProvenance(
          bindSkillProvenanceDeps({
            listVersions: async (skillId) => [
              ...(await deps.versions.list(skillAuthority, { id: skillId })),
            ],
            listFusedInto: deps.listFusedInto,
            filterVisible: deps.filterVisibleMemories,
            authority: deps.memoryAuthorityFor(actor),
          }),
          id,
        ),
      )
    },
  )
}
