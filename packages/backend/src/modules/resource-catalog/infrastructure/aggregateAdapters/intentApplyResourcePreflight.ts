// RFC-359 W8 —— Intent apply 会话的归属预检：**一份实现，两个 provider 共用**。
//
// 合一前这三个 interface 加一个函数在同目录的两个适配器里各有一份**逐字相同**的副本
// （`legacyIntentApplyResourceParticipants.ts` 与 `postgresqlIntentApplyResourceParticipants.ts`），
// 差别只有类型名上的 `Legacy` / `Postgresql` 前缀——是纯粹的**命名分叉**，不是能力分叉：
// 函数体只经 `ResourceCatalogAclIdentityReadPort` 这个闭合端口取数，一行方言都没有。
//
// 两份并存的唯一后果就是「改一份、漂另一份」，且漂完两条路径各自的用例都还绿着。归中立那侧
// 只需要一个不带 provider 前缀的名字，零新增跨上下文边（同目录、同 bounded context）。
// 单一定义点由 `tests/architecture/rfc359-converged-twins.test.ts` 双向棘轮把守。
import { CATALOG_SELECTOR_KINDS, type CatalogSelectorKind } from '../../domain/resourceKinds'
import type { ResourceCatalogAclIdentityReadPort } from '../../application/ports/providerResourceCatalogPersistence'

export interface IntentApplyManifestEntry {
  readonly handle: string
  readonly resourceType: string
  readonly resourceId: string
}

export interface IntentApplyChangeset {
  readonly ops: ReadonlyArray<{
    readonly action: string
    readonly resourceType: string
    readonly target?: string
  }>
}

export interface IntentApplyResourcePreflight {
  readonly occupiedNames: ReadonlyMap<CatalogSelectorKind, ReadonlySet<string>>
  readonly copyOnlyTargets: ReadonlyMap<string, string>
}

function isCatalogSelectorKind(value: string): value is CatalogSelectorKind {
  return CATALOG_SELECTOR_KINDS.some((kind) => kind === value)
}

/**
 * Provider-neutral ownership preflight for one named Intent apply session.
 * Persistence identity stays in the owner adapter; Intent receives only the
 * two closed decisions needed by bundle resolution.
 */
export async function resolveIntentApplyResourcePreflight(
  identities: ResourceCatalogAclIdentityReadPort,
  ownerUserId: string,
  manifest: readonly IntentApplyManifestEntry[],
  changeset: IntentApplyChangeset,
): Promise<IntentApplyResourcePreflight> {
  const occupiedNames = new Map<CatalogSelectorKind, ReadonlySet<string>>()
  for (const type of CATALOG_SELECTOR_KINDS) {
    const names = await identities.listOwnedNames(type, ownerUserId)
    occupiedNames.set(type, new Set(names.map((name) => name.toLowerCase())))
  }

  const copyOnlyTargets = new Map<string, string>()
  const byHandle = new Map(manifest.map((entry) => [entry.handle, entry] as const))
  for (const op of changeset.ops) {
    if (op.action !== 'update' || op.target === undefined) continue
    const entry = byHandle.get(op.target)
    if (entry === undefined || !isCatalogSelectorKind(entry.resourceType)) continue
    const resourceOwnerUserId = await identities.getOwner(entry.resourceType, entry.resourceId)
    if (resourceOwnerUserId !== undefined && resourceOwnerUserId !== ownerUserId) {
      copyOnlyTargets.set(op.target, 'owned by another user or built-in')
    }
  }

  return Object.freeze({ occupiedNames, copyOnlyTargets })
}
