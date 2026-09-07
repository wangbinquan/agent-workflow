// RFC-359 W10 —— 资源包应用回执的**信封判定**：一份中立实现，两个引擎共用。
//
// # 这一层判什么
//
// `resource_bundle_applies` 的一行进入 `committed` 之后，崩溃收敛器每一轮都会对它做一次幂等
// 回放（`application/resourcePackageMaintenance.ts` 的 `converge`）。回放之前要先问一句：
// **这一行的回执还成不成立**。判据只有两条，且都与落盘格式无关：
//
//   · `state='committed'` 就**必须**带回执（`receipt_json IS NOT NULL`）——两个引擎的提交臂
//     都是「同一条 UPDATE 里一起写 state 与 receipt」，所以「committed 却没有回执」只可能来自
//     库被外部改过；
//   · 回执必须**认领这一行**（`receipt.journalId === row.id`）——回执是幂等重放的返回值
//     （`replayBundleApplyOutcome`），认错行意味着重放会把别人那次导入的结果讲给这次的调用方。
//
// # 为什么只判信封，不判载荷
//
// `applied[]` 的逐条形状**两个引擎不一样**，而且这个不一样是被单独钉住的既有事实：SQLite 写
// `opId`（`services/bundle/provider.ts` 的 `BundleAppliedOp`），PostgreSQL 写 `operationId` 且
// 读回侧是 zod `.strict()`；同源的落盘工件格式差异由
// `tests/architecture/rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵管着。
//
// 所以这份中立判定**只碰两套格式的公共字段 `journalId`**。把载荷层一起收进来会立刻踩到一个
// 很贵的坑：PostgreSQL 的载荷 schema 拿到 SQLite 的真实回执会逐条 `.strict()` 拒收，全库
// committed 行当场集体停止 roll-forward。判据缺口账本当年写「不要直接给 SQLite 补
// `parseReceipt`」，说的就是这半边——信封那半边该合，载荷那半边不该。
//
// # 判定为什么是纯函数
//
// 没有任何引擎差异可言：输入是一行 journal 的 `id` 与 `receipt_json` 文本，输出是三态之一。
// 纯函数让两个引擎调同一份，也让四格判定可以脱离数据库单测。抛出的那一层
// （`assertCommittedApplyReceipt`）只负责把三态翻成两个引擎逐字相同的错误码。

/** committed 行的回执信封三态：`null` = 可以回放。 */
export type CommittedApplyReceiptIssue = 'missing' | 'mismatch'

/** 判定只需要 journal 行的这两个字段。 */
export interface CommittedApplyReceiptRow {
  readonly id: string
  readonly receiptJson: string | null
}

/**
 * 纯判定。`mismatch` 覆盖「回执认领了别的 journal」与「回执根本不是一个带 `journalId` 的信封」
 * ——两者对用户是同一件事：**这一行的回执不认领这一行**，回放它等于拿别处的结果当本次的结果。
 */
export function committedApplyReceiptIssue(
  row: CommittedApplyReceiptRow,
): CommittedApplyReceiptIssue | null {
  if (row.receiptJson === null) return 'missing'
  let decoded: unknown
  try {
    decoded = JSON.parse(row.receiptJson)
  } catch {
    return 'mismatch'
  }
  if (typeof decoded !== 'object' || decoded === null) return 'mismatch'
  const journalId = (decoded as { journalId?: unknown }).journalId
  return journalId === row.id ? null : 'mismatch'
}

/**
 * 判定 + 抛，并把**过了门的回执原文**交回去，让调用方不必再为「这里 `receiptJson` 一定非空」
 * 补一次断言或强转。两个引擎共用同一组错误码，于是同一行损坏的 journal 在两个引擎上给运维
 * 看到的 `resource-package-roll-forward-retryable` 逐字相同。
 */
export function assertCommittedApplyReceipt(row: CommittedApplyReceiptRow): string {
  const issue = committedApplyReceiptIssue(row)
  if (issue !== null) throw new Error(`resource-package-committed-receipt-${issue}:${row.id}`)
  // `missing` 已经把 `null` 挡在门外，这里的非空是判定的后置条件。
  return row.receiptJson ?? ''
}
