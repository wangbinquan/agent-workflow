// RFC-310 T82/T81 —— webhook 投递该不该给这条 MR claim 落 wake hint。
//
// 抽成纯函数是因为它现在有两档而不是一档，而两档的边界正是「死代码 / 误唤醒」
// 的分界线；路由里那层 HTTP + 签名 + dispatcher 的壳让它几乎没法被直接断言。
//
// 语义（wake hint 只负责**叫醒**，状态一律由 reconciler 自采——与 T82 同一条纪律）：
//   - `active` claim：正常在跑的 Mission，唤醒；
//   - `released` claim 且其 Mission 是 `closed-unmerged`：这正是 **reopen 信号**。
//     MR 关闭时平台释放了 claim，外部把它重新打开时若不唤醒，reconciler 的 reopen
//     探针永远等不到触发，整条「建带链接的新 generation」的链就是死代码；
//   - 其余一律不唤醒：`merged` 的终态不接受重开；handoff 后 tracking-only 之类的
//     released 也不该被 webhook 拽回来。

export interface WebhookWakeInput {
  /** 该 (endpoint, project, iid) 当前归属的 claim 状态；null = 平台不认识这条 MR。 */
  readonly claimState: string | null
  /**
   * claim 所属 Mission 的 terminalKind。只在 claim 非 active 时需要读——active 档
   * 不查库，避免在 webhook 热路径上多打一次。
   */
  readonly missionTerminalKind: string | null
}

export function shouldWakeForWebhook(input: WebhookWakeInput): boolean {
  if (input.claimState === null) return false
  if (input.claimState === 'active') return true
  return input.missionTerminalKind === 'closed-unmerged'
}
