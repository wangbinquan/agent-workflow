// RFC-352（RFC-294 W4-E2）—— `RepositoryScopeAuthorizationInTx` 的**唯一** owner 工厂。
//
// 由来：memory 的 scope Move 需要判「这条记忆能不能挂到某个仓库 / 仓库组名下」，此前它是
// 直接 select `cachedRepos` / `repoGroups` 两张 source-control 的表做的（两个 provider 各一份）。
// 跨 context 直读别人的表是 RFC-294 明令禁止的形状，`design.md:3441` 因此要求 source-control
// 提供这个 offered participant。
//
// **判据逐字保持迁移前**：repo / repo_group scope 的管理权今天就是「仅 `resource-acl:bypass`」
// （RFC-248 / RFC-305）。不引入仓库属主委派——那是权限档位变更，须单独立项。
//
// 为什么工厂只有一个：capability 类型带私有 brand，只能由 owner 工厂铸造（RFC-294
// capability-forge 守卫要求 brand + readonly + 唯一工厂 + `Object.freeze` + 私有运行时注册表）。
// provider 差异被收窄到「这行还在吗」这一件事实（`RepositoryScopeExistenceReads`），
// 它不是 capability，可以两个 provider 各实现一份；判据本身只有这一处。

import type {
  RepositoryScopeAuthorizationInTx,
  RepositoryScopeMaybePromise,
  RepositoryScopeSubject,
  RepositoryScopeTarget,
} from '../public/participants'

/**
 * 各 provider 只需提供「这行还在吗」这一件事实。**刻意不放在 `public/`**：memory 从不认识它，
 * 对外合同只有铸好的 capability；放进 public 会多一个零 consumer 的公共符号
 * （RFC-294 design §3.3「无 consumer 不公开」）。
 */
export interface RepositoryScopeExistenceReads<Transaction> {
  exists(
    transaction: Transaction,
    target: RepositoryScopeTarget,
  ): RepositoryScopeMaybePromise<boolean>
}

/**
 * 私有运行时注册表：只有经本工厂铸出的实例才在册。结构等价的对象即便通过了类型断言，
 * 也不在这个 WeakSet 里——与 resource-catalog 的 `trustedResourceScopeAuthorizations` 同形。
 */
const trustedRepositoryScopeAuthorizations = new WeakSet<object>()

export function isTrustedRepositoryScopeAuthorization(value: object): boolean {
  return trustedRepositoryScopeAuthorizations.has(value)
}

/** 唯一判据点：两个 provider 共用，杜绝「同一段判据抄两遍然后各自演进」。 */
function canManageRepositoryScope(subject: RepositoryScopeSubject): boolean {
  return subject.hasResourceAclBypass
}

export function createRepositoryScopeAuthorizationInTx<Transaction>(
  reads: RepositoryScopeExistenceReads<Transaction>,
): RepositoryScopeAuthorizationInTx<Transaction> {
  const participant = Object.freeze({
    exists(transaction: Transaction, target: RepositoryScopeTarget) {
      return reads.exists(transaction, target)
    },
    canManage(
      _transaction: Transaction,
      subject: RepositoryScopeSubject,
      _target: RepositoryScopeTarget,
    ) {
      return canManageRepositoryScope(subject)
    },
  }) as unknown as RepositoryScopeAuthorizationInTx<Transaction>
  trustedRepositoryScopeAuthorizations.add(participant)
  return participant
}
