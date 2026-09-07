// RFC-355 T5（RFC-294 W4-E4a）—— apply 日志（journal）收敛的**判据与诊断词汇**，两个 provider 共用。
//
// 收敛回答的是「重启之后，这条没走完的 apply 该怎么收场」。判据在此之前是两份：
// SQLite 的 `convergeIntentApplyJournal` 与 PostgreSQL 的
// `createPostgresqlIntentApplyJournalConvergence`，结构逐段并行、只有写回方式不同。
//
// 两份的代价已经看得见：**诊断标签开始分叉**——`intent-converge-left-retryable`
// 只有 SQLite 记，`intent-resource-abort-failed` / `intent-resource-roll-forward-recovery-failed`
// 只有 PostgreSQL 记。运维在两种部署上 grep 同一类失败，拿到的是不同的词。
//
// **RFC-359 W7 的进度与欠账**（这段账要一直记到两份合一为止）：
//   · 已抬齐 `intent-left-retryable`（apply 期）——原来只有 SQLite 记，PG 侧同一件事没有名字；
//     现在两侧同一常量、同一 payload 形状，对拍在
//     `tests/rfc359-w7-intent-apply-operations-conformance.test.ts` 的 A 段。
//   · 已抬齐 `intent-apply-artifact-roll-forward-retryable`——原来只有 PG 记（因为只有 PG
//     判插件发布存在性），SQLite 补上同一判定后共用同一常量。
//   · **仍欠**：`intent-converge-left-retryable`（**收敛期**，上面那条的孪生词）到今天还是
//     只有 SQLite 记——PG 的 converge 在补偿失败时写回了 error 却不记这个词。它是同一族的
//     最后一条残差，抬齐它需要动 PG 的两处 converge（`postgresqlIntentApplyOperations` 与
//     `postgresqlIntentApplyArtifactLifecycle` 各一份），单独立项。
//   · `intent-resource-*` 两条对应 PG 独有的资源会话中止/提交后尾巴，是**真能力差**，
//     不是欠账（SQLite 的会话根本没有那两个方法），对拍里作为显式分叉留在 B 段。
//
// 本文件只收「判什么、记什么词」；**读行与写回仍归 provider**（SQLite 是同步 `dbTxSync`、
// PostgreSQL 是 async 事务，形状本就不同——RFC-353 已经踩过一次把 async 塞进同步事务的坑）。

/** 收敛只关心 journal 行的这几列。 */
export interface IntentApplyJournalRowView {
  readonly id: string
  readonly state: string
  readonly updatedAt: number
  readonly error: string | null
}

/** 一条待收敛的行该走哪条路。 */
export type IntentApplyConvergeAction =
  | { readonly kind: 'skip' }
  | { readonly kind: 'compensate' }
  | { readonly kind: 'roll-forward' }

/**
 * 判据本身。`activeJournalIds` 是「本进程正在跑的 apply」——收割它会把一个活事务的
 * prestage 补偿掉、然后让它的 journal CAS 失败（P2-1）；`reapBefore` 之后更新过的行
 * 同样放过，它可能只是一次慢安装。
 */
export function decideIntentApplyConverge(
  row: IntentApplyJournalRowView,
  input: {
    readonly reapBefore: number
    readonly activeJournalIds: ReadonlySet<string>
  },
): IntentApplyConvergeAction {
  if (row.state === 'failed') return { kind: 'skip' }
  if (row.state === 'prepared' || row.state === 'applying') {
    if (input.activeJournalIds.has(row.id) || row.updatedAt > input.reapBefore) {
      return { kind: 'skip' }
    }
    return { kind: 'compensate' }
  }
  if (row.state === 'committed') return { kind: 'roll-forward' }
  return { kind: 'skip' }
}

/**
 * 收敛与 apply 共用的诊断词汇。**两个 provider 必须记同一组词**——
 * `rfc355-intent-provider-parity.test.ts` 用集合相等把它钉死。
 *
 * 之所以做成常量而不是各处写字面量：字面量在两个文件里各写一遍，正是它们分叉的方式。
 */
export const INTENT_APPLY_DIAGNOSTICS = Object.freeze({
  /** journal 的 artifact 列解不开——它是恢复的唯一凭据，宁可留着让人修，也不假装收敛成功。 */
  journalArtifactCorrupt: 'intent-journal-artifact-corrupt',
  /** 补偿本身失败：行留在原状态、带上 retryable 说明，下一轮再来。 */
  convergeCompensationFailed: 'intent-converge-compensation-failed',
  /** 补偿有错，这一轮不推进终态。 */
  convergeLeftRetryable: 'intent-converge-left-retryable',
  /** apply 过程中的补偿失败（非收敛路径）。 */
  artifactCompensationFailed: 'intent-artifact-compensation-failed',
  /** apply 失败后未能推进终态，留待收敛。 */
  applyLeftRetryable: 'intent-left-retryable',
  /** 资源侧的中止动作失败。 */
  resourceAbortFailed: 'intent-resource-abort-failed',
  /** 前滚恢复失败。 */
  resourceRollForwardRecoveryFailed: 'intent-resource-roll-forward-recovery-failed',
  /** 单个工件的前滚没做完，这一条仍可重试（apply 期与收敛期共用）。 */
  artifactRollForwardRetryable: 'intent-apply-artifact-roll-forward-retryable',
} as const)

/**
 * 「提交已经落地，但幂等的提交后尾巴没做完」写回 journal 的说明文案。
 *
 * RFC-359 W7 抬齐①：它此前是**四份字面量**（两个 provider 的收敛各一份、PG 的 apply 一份、
 * PG 的 journal 收敛器一份），而 SQLite 的 apply 干脆把 `rollForward` 的返回值丢了、一份都没写。
 * 抬齐时把 SQLite 的 apply 补上，同时把文案收成这一个常量——同一件事在两个引擎、两个时机
 * （apply 期 / 收敛期）留下的必须是**同一句话**，否则运维 grep 到的仍是不同的东西。
 */
export const INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE =
  'retryable: committed roll-forward incomplete; inspect intent apply logs'
