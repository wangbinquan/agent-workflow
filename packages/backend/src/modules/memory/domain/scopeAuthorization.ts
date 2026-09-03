// RFC-352（RFC-294 W4-E2）—— memory scope 授权的**纯判据**。
//
// 为什么这个文件存在：在此之前同一套级联被写了两遍——
// `infrastructure/sqliteMemoryCatalog.ts` 一份、`infrastructure/postgresqlMemoryCatalogOperations.ts`
// 一份。两份都在 infrastructure 层（授权策略住在 SQL adapter 里），而且各自独立演进，
// 任何一次只改一边就是两个 provider 判据漂移，用户看到的权限取决于部署选了哪个数据库。
// 现在判据只有这一份，两个 provider 各自只负责**取事实**（是否 bypass、资源访问档），
// 判定交给这里。
//
// 这里零 IO、零 DB、零 Actor、零端口：输入是已经取好的事实，输出是布尔。
// 因此权限矩阵可以表驱动地对它做穷尽测试（见 `rfc285-b7-memory-matrix.test.ts`）。
//
// **判据本身逐字保持迁移前的语义**（RFC-099 D12 / RFC-248 AC-29 / RFC-305 / RFC-324 D9）。
// RFC-352 是结构迁移，不改任何权限档位；要改档位得单独立项。

import type { ResourceAccess } from '@agent-workflow/shared'

/** memory 的五种 scope。前两种挂在 ACL 资源上，后三种是平台级 scope。 */
export type MemoryScopeKind = 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'

/**
 * 平台级 scope：不挂在某个 ACL 资源上，因此不需要（也无法）取资源访问档。
 * RFC-248 AC-29 起 `repo_group` 与 `repo` / `global` 同档。
 */
export function isPlatformMemoryScope(scopeType: MemoryScopeKind): boolean {
  return scopeType === 'repo' || scopeType === 'repo_group' || scopeType === 'global'
}

/** 只有资源 scope 才需要去查访问档——平台 scope 查了也用不上，别做无谓查询。 */
export function memoryScopeNeedsResourceAccess(scopeType: MemoryScopeKind): boolean {
  return !isPlatformMemoryScope(scopeType)
}

/** 已经取好的授权事实。`resourceAccess` 仅资源 scope 有意义，平台 scope 传 `null`。 */
export interface MemoryScopeAuthorizationFacts {
  readonly hasAclBypass: boolean
  readonly scopeType: MemoryScopeKind
  readonly resourceAccess: ResourceAccess | null
}

/**
 * 读面（RFC-099 D12 + RFC-248 AC-29）：
 * ACL bypass 全读；平台 scope（repo / repo_group / global）**全员可读**；
 * 资源 scope 随资源可见性——能看见这个 agent / workflow 就能读它名下的记忆。
 */
export function decideMemoryScopeView(facts: MemoryScopeAuthorizationFacts): boolean {
  if (facts.hasAclBypass) return true
  if (isPlatformMemoryScope(facts.scopeType)) return true
  return facts.resourceAccess !== null && facts.resourceAccess !== 'none'
}

/**
 * 管理面（RFC-099 D12 + RFC-248 / RFC-305 + RFC-324 D9）：
 * ACL bypass 全管；平台 scope **仅** ACL bypass 可管；
 * 资源 scope 认 `write` 与 `own` 两档——RFC-324 D9 起「能改这个 agent / workflow 的人，
 * 也能管它名下的记忆」，读面不受影响。
 */
export function decideMemoryScopeManage(facts: MemoryScopeAuthorizationFacts): boolean {
  if (facts.hasAclBypass) return true
  if (isPlatformMemoryScope(facts.scopeType)) return false
  return facts.resourceAccess === 'write' || facts.resourceAccess === 'own'
}

/**
 * 列表逐行盖的 `canManage` 标记（给 UI 决定是否显示审批 / 编辑 / 归档按钮）。
 *
 * **它与 `decideMemoryScopeManage` 现在判据相同**，这是 RFC-352 修掉的一处真 bug：
 * 合并之前这段判据被抄了两遍且已经漂移——SQLite 侧停在 RFC-099 D12 的「只有 owner」
 * （`sqliteMemoryCatalog.ts` 旧 `annotateMemoryManageRights`），PostgreSQL 侧跟上了
 * RFC-324 D9 的 `write | own`（`postgresqlMemoryCatalogOperations.ts` 旧
 * `annotateManageRights`）。于是同一个拿到 `write` 授权的人，在 SQLite 部署上看不到
 * 审批 / 编辑 / 归档按钮、在 PostgreSQL 部署上看得到，**而两边的 API 门
 * （`decideMemoryScopeManage`）都放行**——界面欠了他本来就有的能力。
 *
 * 用户 2026-09-03 裁定按 `write | own` 对齐：与真正的 API 门一致，也与 PostgreSQL 现行
 * 行为一致。因此这个函数今天只是 `decideMemoryScopeManage` 的别名——保留独立名字是为了
 * 让「UI 标记」与「API 门」这两个问题各有明确的提问点，将来若要再分叉，分叉点在这里。
 */
export function decideMemoryRowManageStamp(facts: MemoryScopeAuthorizationFacts): boolean {
  return decideMemoryScopeManage(facts)
}
