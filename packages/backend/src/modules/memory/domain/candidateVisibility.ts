// RFC-352 T8/AC-6（RFC-294 W4-E2）—— RFC-285 B7（Q4）候选收窄的**唯一**判据。
//
// 规则本身一句话：`status='candidate'` 的行是**未经人审的蒸馏产物**（含正文），读面只对
// 持 `resource-acl:bypass` 的操作者开放；人审发布成 `approved` 之后才回到全员读面。
//
// 为什么要把它收成一份：T8 之前，这条规则在 `routes/memories.ts` 里被**手抄了四遍**——
// 列表、`include=body` 的审批队列、`facets` 聚合、详情 404 各写一份 `status !== 'candidate'`，
// 而分页路径（`application/listPage.ts`）又是第五份。四个手抄件的形状还各不相同
// （facets 那份外面套了一层 `status === 'candidate' &&`），下一次改判据时漏掉任何一处，
// 症状都是「某个入口能看到别人的未审候选」——而这正是本 RFC 开局撞到的 canManage 漂移的同一类。
//
// 判据是纯的：只看行的 status 与调用者是否被允许看候选，不碰 DB / ACL 表 / 端口。
// 「调用者是否被允许看候选」由边界层一次性 decode（`hasResourceAclBypass(actor)`）后传进来。

/** 一条能参与候选收窄的行：只需要 status。 */
export interface CandidateNarrowable {
  readonly status: string
}

export interface CandidateVisibilityOptions {
  /** 调用者是否可以看未审候选（= `resource-acl:bypass`）。 */
  readonly includeCandidates: boolean
}

/** 单行判定：这一行对调用者是否应当**隐藏**（详情路由据此给出与不存在同形的 404）。 */
export function isMemoryHiddenCandidate(
  row: CandidateNarrowable,
  options: CandidateVisibilityOptions,
): boolean {
  return row.status === 'candidate' && !options.includeCandidates
}

/** 批量收窄：保持入参顺序，只滤掉对调用者应当隐藏的候选行。 */
export function narrowCandidateRows<T extends CandidateNarrowable>(
  rows: readonly T[],
  options: CandidateVisibilityOptions,
): T[] {
  if (options.includeCandidates) return [...rows]
  return rows.filter((row) => !isMemoryHiddenCandidate(row, options))
}
