// RFC-108 T18 (AR-03) — boot auto-resume (DEFAULT OFF, decision D1).
//
// `reapOrphanRuns` flips every task that was running across a daemon restart to
// `interrupted` (errorSummary='daemon-restart') and then waits for a human to
// click Resume. When `autoResumeOnBoot` is enabled, this closes that loop: each
// such task is re-driven automatically AT BOOT, but only through every guard the
// rest of RFC-108 built —
//   • circuit-breaker  (recordAutoRecoveryAttempt → skip if it quarantines),
//   • quarantine flag   (isAutoRecoverySuspended → skip),
//   • continuation intent + durable owner claim (same command path as a human),
//   • recovery audit     (a recovery_events row per resume),
//   • resumeTask itself  (revision CAS + snapshot-lost / live-child-survived
//                         escalation already refuse unsafe resumes and the
//                         breaker counts those failures toward quarantine).
//
// The actual resume is injected so this stays unit-testable without the full
// launch machinery; start.ts passes a thunk that calls resumeTask with real deps.

import { taskIdsWithRepoPrepRow } from '@/services/taskWorkspacePhase'
import { taskWorkspacePhase } from '@agent-workflow/shared'

import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  type BreakerConfig,
  isAutoRecoverySuspended,
  recordAutoRecoveryAttempt,
} from '@/services/recoveryBreaker'
import { createLogger } from '@/util/log'

const log = createLogger('auto-resume')

export interface AutoResumeOptions {
  operations: TaskRecoveryOperations
  breaker: BreakerConfig
  /** Resume one task. Throws on an unsafe/failed resume (counted by the breaker). */
  resume: (taskId: string) => Promise<void>
  /**
   * RFC-287 G7（plan.md T13⑥「boot reap / auto-resume 识别『准备未完成』**改重跑
   * 准备**」）：仓库准备未完成的任务不能走 resume（它必然撞
   * `task-repo-prep-incomplete`），要重跑的是准备本身。注入而非直调，避免
   * autoResume → task 的新依赖边。缺省不传 = 退回「跳过」，老调用方不受影响。
   */
  retryRepoPrep?: (taskId: string) => Promise<void>
  now?: () => number
}

export interface AutoResumeResult {
  resumed: string[]
  skipped: string[]
}

/**
 * Auto-resume every task that a daemon restart left `interrupted`. Idempotent:
 * resumeTask submits the same canonical continuation intent as a human command,
 * so a task already being driven has one durable winner; a second pass finds
 * nothing because successful resumes leave `running`/terminal.
 */
export async function autoResumeInterruptedTasks(
  opts: AutoResumeOptions,
): Promise<AutoResumeResult> {
  const { operations, breaker, resume, retryRepoPrep } = opts
  const now = opts.now ?? Date.now
  // RFC-187 T13 (Codex P1-7①) — a SECOND wedge shape this sweep must also catch: the
  // human answered a clarify, the answer + its pending continuation row committed, and the
  // daemon died before fire-and-forget `resumeTask` took over. The reaper flips that
  // pending row to `interrupted` but leaves the TASK `awaiting_human` (it only reaps
  // pending/running tasks), so the query above misses it and the answered continuation is
  // wedged forever. Such a task IS resumable: the engine's entry pass revives the killed
  // continuation and the normal adoption drives it. Only tasks with a killed continuation
  // qualify — a task legitimately parked awaiting a human answer has no such row and MUST
  // stay parked.
  // RFC-186 PR-2 (audit §5 F1): turn-engine workgroups (leader_worker /
  // free_collab) are NOW resumable — `resumeTask`→`runTask`→`runWorkgroupEngine`
  // re-derives everything from durable rows, adopts pending host runs, and (PR-2)
  // reconciles a `running` assignment whose node_run is terminal. The old RFC-165
  // exclusion (`!isTurnEngineWorkgroupTask`) that left them `interrupted` forever
  // — the direct cause of 3/10 production tasks wedged permanently — is removed.
  // Single-agent host + dynamic_workflow were already included.
  //
  // RFC-187 T13 — plus the awaiting_human-with-killed-continuation shape above. The join
  // can repeat a task (several killed continuations), and a task could in principle appear
  // in both sets, so merge by id.
  const candidates = await operations.listAutoResumeCandidates()

  // RFC-317 T50（LC-05）—— 一次查出这批候选里谁有 `__repo_prep__` 行。
  // 此前这里根本不看准备行，于是**存量**物化失败的任务行（空路径、无墓碑、也从来
  // 没有过准备行）会被路由去 `retryRepoPrep()`——而 AC-11 的重试入口对它不存在。
  const prepRowTaskIds = await taskIdsWithRepoPrepRow(
    operations,
    candidates.map((candidate) => candidate.id),
  )

  const resumed: string[] = []
  const skipped: string[] = []
  for (const t of candidates) {
    // RFC-287 G7 / AC-10 —— **准备阶段的任务不走 resume**。
    //
    // G7 之后出现了「任务行已落、工作树还没建出来」这一段。resume 对它必然失败
    // （`assertWorktreePresentForResume` 判 `task-repo-prep-incomplete`），可失败会被
    // 熔断器**计数**：每次 boot 烧一次，N 次之后这行任务被隔离，恢复审计里还留下一串
    // 归因错误的 `auto-resume failed`。它需要的是「重试准备仓库」（AC-11），不是续跑
    // 一个还不存在的工作树。这里显式跳过，且**不计入熔断**——它不是一次失败的恢复
    // 尝试，是一次根本不该发起的尝试。
    //
    // RFC-317 T50（LC-05）—— 判据现在**真的**与 `assertWorktreePresentForResume` 同源：
    // 三处共用 shared 的 `taskWorkspacePhase`。此前这句注释是错的——那时这里少判
    // `workspacePruningAt` 与「确有准备行」两条，对同一行给出的结论与 task.ts 不同。
    // 打了墓碑的是老的「工作区已回收」形态，仍按既有路径处理（resume 报 410、计熔断）。
    if (
      taskWorkspacePhase({
        worktreePath: t.worktreePath,
        workspacePruningAt: t.workspacePruningAt,
        workspacePrunedAt: t.workspacePrunedAt,
        hasRepoPrepRow: prepRowTaskIds.has(t.id),
      }) === 'preparing'
    ) {
      // plan.md T13⑥ 要的是**重跑准备**，不是跳过——daemon 在克隆中途重启，用户期望
      // 的是它继续把仓库准备好，而不是留一个要手点重试的任务。resume 对它必然失败
      // （`task-repo-prep-incomplete`），所以走单独的注入口。
      // 熔断仍然计：重跑准备是一次真正的恢复尝试，一个永远拉不动的远端应当在 N 次后
      // 被隔离，否则每次 boot 都白跑一轮克隆。
      if (retryRepoPrep === undefined) {
        log.info('auto-resume skipped a task still awaiting repository preparation', {
          taskId: t.id,
        })
        skipped.push(t.id)
        continue
      }
      if (await isAutoRecoverySuspended(operations, t.id)) {
        skipped.push(t.id)
        continue
      }
      if ((await recordAutoRecoveryAttempt(operations, t.id, breaker, now())).suspended) {
        skipped.push(t.id)
        continue
      }
      let ok = false
      try {
        await retryRepoPrep(t.id)
        await recordRecoveryEvent(operations, {
          taskId: t.id,
          kind: 'auto-resume',
          reason: 'autoResumeOnBoot:repo-prep',
          before: { status: 'interrupted' },
          after: { status: 'pending' },
          now: now(),
        })
        ok = true
      } catch (err) {
        log.warn('auto repo-prep retry failed', {
          taskId: t.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (ok === true) resumed.push(t.id)
      else skipped.push(t.id)
      continue
    }
    if (await isAutoRecoverySuspended(operations, t.id)) {
      skipped.push(t.id)
      continue
    }
    const { suspended } = await recordAutoRecoveryAttempt(operations, t.id, breaker, now())
    if (suspended) {
      skipped.push(t.id)
      continue
    }
    let ran = false
    try {
      await resume(t.id)
      await recordRecoveryEvent(operations, {
        taskId: t.id,
        kind: 'auto-resume',
        reason: 'autoResumeOnBoot',
        before: { status: 'interrupted' },
        after: { status: 'pending' },
        now: now(),
      })
      ran = true
    } catch (err) {
      log.warn('auto-resume failed', {
        taskId: t.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (ran === true) resumed.push(t.id)
    else skipped.push(t.id)
  }
  if (resumed.length > 0 || skipped.length > 0) {
    log.info('boot auto-resume swept interrupted tasks', {
      resumed: resumed.length,
      skipped: skipped.length,
    })
  }
  return { resumed, skipped }
}
