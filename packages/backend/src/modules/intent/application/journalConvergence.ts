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
