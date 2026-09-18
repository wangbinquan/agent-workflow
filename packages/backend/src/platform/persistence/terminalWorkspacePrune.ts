// RFC-359 AC-1（命名债收尾 §5hj）—— 终态工作区回收策略，**provider 中立**。
//
// 它从 `platform/persistence/sqlite/taskLifecycle.ts` 拆出来。那段代码的注释自己就写着
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

import type { tasks } from '@/db/schema'
import { createLogger } from '@/util/log'
import type { WorkspacePruneCause } from './sqlite/taskLifecycle'

const lifecycleLog = createLogger('lifecycle')

/**
 * RFC-317 LC-04 —— 回收判定连**原因**一起由注入方给出。
 *
 * 原本 port 返回裸 `boolean`，于是「要不要回收」被外置了、而「这次回收叫什么名字」
 * 仍留在 kernel 里硬编码（`workspacePruneCause: 'webhook-terminal' as const`）。
 * 那是**半次反转**：策略搬出去了，词汇表没搬——第二个来源要表达自己的原因，唯一的
 * 办法就是回来改这个通用写点。闭合联合把「不回收就没有原因」也变成编译期事实。
 */
export type TerminalWorkspacePruneDecision =
  | { readonly prune: false }
  | { readonly prune: true; readonly cause: WorkspacePruneCause }

/** RFC-300: daemon-composed policy deciding whether this exact terminal CAS
 * must also durably claim the task's owned workspace. Lifecycle receives only
 * neutral ownership/tombstone facts plus the task id; any origin-specific
 * attribution column is read by the policy itself, so this generic writer names
 * zero integrations. It never imports config or integration services. */
export type TerminalWorkspacePrunePolicy = (
  row: {
    taskId: string
    spaceKind: (typeof tasks.$inferSelect)['spaceKind']
    workspacePruningAt: number | null
    workspacePruneCause: (typeof tasks.$inferSelect)['workspacePruneCause']
    workspacePrunedAt: number | null
  },
  to: TaskStatus,
) => Promise<TerminalWorkspacePruneDecision>

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
