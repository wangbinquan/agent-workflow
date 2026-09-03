// RFC-353 T8（RFC-294 W4-E3）—— 「谁看得见这条融合」的纯判据。
//
// 此前这条判断在 `routes/fusions.ts` 里逐个 handler 手写了三遍
// （列表过滤一遍、待办计数一遍、详情 404 一遍），三处都是
// `hasResourceAclBypass(actor) ? 全部 : 只看自己的`。三份手抄的老问题：
// 只要有人给其中一处加了条件（例如「协作者也算」），另两处就悄悄不一致——
// 而列表看得见、详情 404 这种不一致恰恰是最难被发现的那种。

/** 看这条融合的人。`aclBypass` 由调用方按既有 ACL 判定填好，这里不做任何权限计算。 */
export interface FusionViewer {
  readonly userId: string
  readonly aclBypass: boolean
}

/** 融合是私有的：只有归属者与持 bypass 的操作者看得见。 */
export function canViewFusion(viewer: FusionViewer, ownerUserId: string): boolean {
  return viewer.aclBypass || ownerUserId === viewer.userId
}

/** 列表过滤：与详情的 404 判据**同一个函数**，两者不可能再各自漂。 */
export function visibleFusions<T extends { readonly ownerUserId: string }>(
  viewer: FusionViewer,
  rows: readonly T[],
): T[] {
  return rows.filter((row) => canViewFusion(viewer, row.ownerUserId))
}
