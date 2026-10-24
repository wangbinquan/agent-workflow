// RFC-359 AC-1（命名债收尾 §5hj）—— 终态工作区回收策略，**provider 中立**。
//
// 它从 `modules/task-execution/infrastructure/taskLifecycle.ts` 拆出来。那段代码的注释自己就写着
// 「Provider-neutral policy evaluation **shared by** the SQLite lifecycle writer **and** the
// PostgreSQL task-execution adapter」——一段自述中立的策略住在 `sqlite/` 目录里，是位置债。
//
// 拆它的**直接触发点**：`rfc359-w8` 能力对账本按「文件里有没有 provider 锚点」判边，
// 而 `sqlite/` 这条路径就是一条 sqlite 锚。共用的取消实现
// （`childTaskLifecycleParticipant.ts`）为了取这个策略而 import 它，于是被判成「SQLite 侧适配器」，
// 凭空与一堆 PG 文件配出**假的成对适配器**（实测 2 对，且都没有对拍 ⇒ 直接顶穿
// `NAME_BLIND_UNVERIFIED_COUNT` 这条只降不升的棘轮）。
// **记一条判据教训**：中立实现住进 provider 目录、或引用住在 provider 目录里的中立代码，
// 都会让「按锚点判边」的账本得出错误结论——而那个结论的方向是**多记债**，不是少记。

import type { TaskStatus } from '@agent-workflow/shared'

import { createLogger } from '@/util/log'
import type {
  TerminalWorkspacePrunePolicy,
  TerminalWorkspacePruneDecision,
} from '../domain/terminalWorkspacePrune'
export type {
  TerminalWorkspacePrunePolicy,
  TerminalWorkspacePruneDecision,
} from '../domain/terminalWorkspacePrune'

const lifecycleLog = createLogger('lifecycle')

let terminalWorkspacePrunePolicy: TerminalWorkspacePrunePolicy | null = null

export function registerTerminalWorkspacePrunePolicy(
  provider: TerminalWorkspacePrunePolicy | null,
): void {
  terminalWorkspacePrunePolicy = provider
}

/** Provider-neutral policy evaluation shared by the SQLite lifecycle writer
 * and the PostgreSQL task-execution adapter. Storage-specific CAS remains in
 * each adapter; this helper only owns the configured business decision and
 * its fail-open diagnostic behavior. */
export async function resolveTerminalWorkspacePruneDecision(
  row: Parameters<TerminalWorkspacePrunePolicy>[0],
  to: TaskStatus,
): Promise<TerminalWorkspacePruneDecision> {
  if (terminalWorkspacePrunePolicy === null || (to !== 'done' && to !== 'canceled')) {
    return { prune: false }
  }
  try {
    return await terminalWorkspacePrunePolicy(row, to)
  } catch (err) {
    // Config is validated on normal daemon writes, but an out-of-band corrupt
    // file must not turn a successfully executed task into a lifecycle error.
    lifecycleLog.warn(
      `terminal workspace prune policy failed for ${row.taskId} → ${to}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { prune: false }
  }
}
