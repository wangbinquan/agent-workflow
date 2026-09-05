import type { ResourceGrantLevel, ResourceVisibility } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { resolveAccessFrom, resourceAclAudienceAuthority } from '../../domain/resourceAccess'
import type { ResourceRequestContext } from '../../public/participants'
import type { ResourceMemoryScopeRef, ResourceScopeAccess } from '../../public/types'

export interface ResourceCurrentAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

/**
 * RFC-359 W4-D4 —— memory 的资源 scope（agent / workflow）访问判定参与者：与 memory 自己声明的端口
 * （`modules/memory/application/ports/resourceScopeAccess.ts`）结构相同；memory 持有外层原子事务并在其中
 * 刷新已 admit 的 actor，resource-catalog 只贡献 ACL 判定。不进 public——public 面不引 Actor、不点名事务句柄。
 */
export interface ResourceScopeAccessParticipant<Transaction> {
  accessOf(
    transaction: Transaction,
    pair: Readonly<{ readonly authority: ResourceRequestContext; readonly actor: Actor }>,
    scope: ResourceMemoryScopeRef,
  ): Promise<ResourceScopeAccess>
}

/**
 * RFC-359 W4-D4 —— memory 的资源 scope 访问判定只需要两件事实：scope 资源行（owner / visibility）
 * 与当前用户在该资源上的授权档。两件事实都在调用方交来的同一个事务句柄上读；provider 差异
 * 只剩「怎么读」，判定本身（`resolveAccessFrom`）只有这一处。
 */
export interface ResourceScopeAccessReads<Transaction> {
  scopeRow(
    transaction: Transaction,
    scope: ResourceMemoryScopeRef,
  ): Promise<Readonly<{ ownerUserId: string | null; visibility: ResourceVisibility }> | null>
  grantLevel(
    transaction: Transaction,
    scope: ResourceMemoryScopeRef,
    userId: string,
  ): Promise<ResourceGrantLevel | null>
}

/**
 * 唯一 owner 工厂。memory 持有外层原子事务并在其中刷新已 admit 的 actor；resource-catalog 只贡献
 * agent / workflow 的 ACL 判定。bypass 与非 private 受众不查授权表——与目录其余入口的判据同源。
 */
export function createResourceScopeAccessParticipant<Transaction>(
  reads: ResourceScopeAccessReads<Transaction>,
): ResourceScopeAccessParticipant<Transaction> {
  const participant: ResourceScopeAccessParticipant<Transaction> = {
    async accessOf(transaction, pair, scope) {
      const row = await reads.scopeRow(transaction, scope)
      if (row === null) return 'none'
      const audience = resourceAclAudienceAuthority(pair.actor)
      const grant =
        audience.bypass || !audience.private
          ? null
          : await reads.grantLevel(transaction, scope, pair.actor.user.id)
      return resolveAccessFrom(audience, pair.actor.user.id, row, grant)
    },
  }
  return Object.freeze(participant)
}
