// RFC-310 PR-1B —— 配置资源 queries（get/list，ACL 可见性过滤）。
//
// list 的可见性口径（RFC-099/231 惯例的最小实现）：owner === actor 或
// visibility === 'public'。resource_grants 精确过滤在 route 集成时统一接
// services/resourceAcl 的 filterVisibleRows（那一层拥有 grants 查询），本层
// 保持 port-only 依赖不触 DB 之外的服务。get 对不可见资源返回 null——调用
// 方以 404 呈现，与「不存在」同形（防资源存在性探测）。

import type { ConfigResourceRecord, ConfigResourceStore } from '../ports/configResourceStore'

export interface ResourceViewAudience {
  readonly actorUserId: string | null
  /** admin/manager 等 ACL bypass（route 集成时由 hasResourceAclBypass 提供）。 */
  readonly bypassAcl: boolean
}

export function isRecordVisible<TExtra>(
  record: ConfigResourceRecord<TExtra>,
  audience: ResourceViewAudience,
): boolean {
  if (audience.bypassAcl) return true
  if (record.visibility === 'public') return true
  return record.ownerUserId !== null && record.ownerUserId === audience.actorUserId
}

export function listConfigResources<TExtra>(
  store: ConfigResourceStore<TExtra>,
  audience: ResourceViewAudience,
  opts: { readonly includeArchived?: boolean } = {},
): ConfigResourceRecord<TExtra>[] {
  return store
    .list()
    .filter((record) => (opts.includeArchived === true ? true : record.archivedAt === null))
    .filter((record) => isRecordVisible(record, audience))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
}

export function getConfigResource<TExtra>(
  store: ConfigResourceStore<TExtra>,
  audience: ResourceViewAudience,
  id: string,
): ConfigResourceRecord<TExtra> | null {
  const record = store.getById(id)
  if (record === null) return null
  return isRecordVisible(record, audience) ? record : null
}
