// Gating predicates for the M3 Resume / Retry-node buttons (P-3-08 /
// P-3-09 wired into the UI). Both helpers exist so we can pin the
// behavior without mounting the full task-detail route — the backend
// API contract is exercised by the resume/retry service tests
// already; here we just make sure the UI doesn't offer the user a
// button that the API will 409 on.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  canOfferResume,
  deriveRepoPrepFailed,
  resumeStatus,
  taskDetailRefetchInterval,
} from '../src/routes/tasks.detail'
import { canRetryNodeRun } from '../src/components/NodeDetailDrawer'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

// The task-detail route is a giant runtime component; per this repo's idiom
// (rfc164-workgroup-tabs.test.ts) we pin the JSX wiring with source-level text
// assertions rather than mounting it. The pure-function tests above lock the
// DECISION; these lock that the button/hint are actually WIRED to it.
const DETAIL_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src/routes/tasks.detail.tsx'),
  'utf8',
)

describe('resumeStatus', () => {
  test('failed task with a worktree → ready', () => {
    expect(resumeStatus('failed', '/tmp/wt')).toBe('ready')
  })

  test('interrupted task with a worktree → ready (daemon-restart case)', () => {
    expect(resumeStatus('interrupted', '/tmp/wt')).toBe('ready')
  })

  test('failed task with empty worktreePath → worktree-missing (resume cannot recover)', () => {
    // This is the exact shape the demo-repo / no-commits failure had:
    // `git worktree add` blew up so worktreePath was never persisted.
    // The backend `resumeTask` is documented to "kick the scheduler
    // without re-creating the worktree" — so re-running would just
    // fail the same way. The UI must surface the alternate path.
    expect(resumeStatus('failed', '')).toBe('worktree-missing')
  })

  test('interrupted task with empty worktreePath → worktree-missing', () => {
    expect(resumeStatus('interrupted', '')).toBe('worktree-missing')
  })

  // RFC-287 G7 / AC-10 —— 第四态。仓库准备移到任务行落库**之后**才跑，于是「卡在
  // 准备」的失败与「工作区被回收」在 status + worktreePath 这两个标量上**完全同形**
  // （都是 failed + ''）。少了第三个入参就必然误判，而两者该给的下一步动作正好相反：
  // 前者是「重试准备那一步」（AC-11：重试作用于任务当前所处阶段），后者是「另起一个
  // 任务」。误判的代价不是文案难看，是把用户推去做一件完全没必要的事。
  test('准备失败 → repo-prep-failed（不得与 worktree-missing 混为一谈）', () => {
    expect(resumeStatus('failed', '', true)).toBe('repo-prep-failed')
    expect(resumeStatus('interrupted', '', true)).toBe('repo-prep-failed')
  })

  // 判据本身的直测——这是上面那条 wire 锁的另一半：wire 锁只保证「调用了」，
  // 这里保证「算得对」。二轮门自查证明少了这一半，判据可以任意改错而不被发现。
  test('deriveRepoPrepFailed：failed 与 interrupted 都算「卡在准备」', () => {
    const mk = (nodeId: string, status: string) => ({ nodeId, status }) as never
    expect(deriveRepoPrepFailed([mk('__repo_prep__', 'failed')])).toBe(true)
    // daemon 重启打断准备时 boot reap 落的就是 interrupted —— 只认 failed 会让这类
    // 任务掉回 worktree-missing 分支，UI 劝用户另起任务（正是第四态要消灭的误导）。
    expect(deriveRepoPrepFailed([mk('__repo_prep__', 'interrupted')])).toBe(true)
  })

  test('deriveRepoPrepFailed：其余状态与其余节点一律不算', () => {
    const mk = (nodeId: string, status: string) => ({ nodeId, status }) as never
    for (const s of ['pending', 'running', 'done', 'canceled']) {
      expect(deriveRepoPrepFailed([mk('__repo_prep__', s)]), s).toBe(false)
    }
    // 别的节点失败 ≠ 卡在准备。
    expect(deriveRepoPrepFailed([mk('n1', 'failed')])).toBe(false)
    expect(deriveRepoPrepFailed([])).toBe(false)
    expect(deriveRepoPrepFailed(undefined)).toBe(false)
  })

  test('第三个入参缺省时保持既有三态（老调用方与首帧不受影响）', () => {
    expect(resumeStatus('failed', '')).toBe('worktree-missing')
    expect(resumeStatus('failed', '/tmp/wt')).toBe('ready')
  })

  test('未失败的任务不因准备行而变可恢复', () => {
    expect(resumeStatus('running', '', true)).toBe('not-resumable')
    expect(resumeStatus('done', '/tmp/wt', true)).toBe('not-resumable')
  })

  test('done task → not-resumable (nothing to resume)', () => {
    expect(resumeStatus('done', '/tmp/wt')).toBe('not-resumable')
  })

  test('running task → not-resumable (would race the live scheduler)', () => {
    expect(resumeStatus('running', '/tmp/wt')).toBe('not-resumable')
  })

  test('pending task → not-resumable', () => {
    expect(resumeStatus('pending', '/tmp/wt')).toBe('not-resumable')
  })

  test('canceled task → not-resumable (no resume API endpoint for canceled)', () => {
    expect(resumeStatus('canceled', '/tmp/wt')).toBe('not-resumable')
  })
})

describe('RFC-300 workspace prune polling', () => {
  test('terminal tasks keep polling only until the durable prune is finalized', () => {
    expect(taskDetailRefetchInterval({ status: 'done', workspaceState: 'pruning' })).toBe(3000)
    expect(taskDetailRefetchInterval({ status: 'canceled', workspaceState: 'pruned' })).toBe(false)
    expect(taskDetailRefetchInterval({ status: 'done', workspaceState: 'available' })).toBe(false)
  })
})

// Regression: a failed TURN-ENGINE workgroup task (leader_worker / free_collab)
// used to show the Resume button, but POST /api/tasks/:id/resume 403s them —
// the builtin __workgroup_host__ anchor is read-only (assertTaskWorkflowNotBuiltin,
// locked by backend rfc167-dynamic-workflow-engine.test.ts). Clicking Resume
// surfaced "workflow is a built-in read-only resource". canOfferResume must gate
// the button on the workgroup dispatch mode so the UI never offers what the API
// refuses (this file's whole purpose per the header comment). Recovery for
// turn-engine groups is relaunch (RFC-164 §4.3/§12).
describe('canOfferResume', () => {
  const base = { status: 'failed' as const, worktreePath: '/tmp/wt' }

  test('failed plain-workflow task (not a workgroup) → offer resume', () => {
    expect(canOfferResume({ ...base, isWorkgroup: false, isDynamicWorkgroup: false })).toBe(true)
  })

  test('failed dynamic_workflow workgroup → offer resume (RFC-167 executing recovery)', () => {
    expect(canOfferResume({ ...base, isWorkgroup: true, isDynamicWorkgroup: true })).toBe(true)
  })

  test('failed turn-engine workgroup → NO resume (endpoint 403s builtin-readonly)', () => {
    expect(canOfferResume({ ...base, isWorkgroup: true, isDynamicWorkgroup: false })).toBe(false)
  })

  test('interrupted turn-engine workgroup → NO resume', () => {
    expect(
      canOfferResume({
        status: 'interrupted',
        worktreePath: '/tmp/wt',
        isWorkgroup: true,
        isDynamicWorkgroup: false,
      }),
    ).toBe(false)
  })

  test('workgroup with mode still loading (isDynamicWorkgroup=false) → NO resume (fail-safe)', () => {
    // Until the room config arrives a workgroup reads as turn-engine; hide the
    // button rather than flash one the API might refuse. A dynamic group
    // self-corrects to `true` one query later.
    expect(canOfferResume({ ...base, isWorkgroup: true, isDynamicWorkgroup: false })).toBe(false)
  })

  test('non-ready status never offers resume, workgroup mode notwithstanding', () => {
    expect(
      canOfferResume({ ...base, status: 'done', isWorkgroup: false, isDynamicWorkgroup: false }),
    ).toBe(false)
    expect(
      canOfferResume({ ...base, status: 'running', isWorkgroup: true, isDynamicWorkgroup: true }),
    ).toBe(false)
  })

  test('worktree-missing failed task never offers the resume button (hint handles it)', () => {
    expect(
      canOfferResume({
        status: 'failed',
        worktreePath: '',
        isWorkgroup: false,
        isDynamicWorkgroup: false,
      }),
    ).toBe(false)
  })
})

describe('RFC-300 workspace capability wiring', () => {
  test('detail hides preserved/retry/sync affordances and renders both cleanup states', () => {
    // RFC-287 G7：纯函数会算第四态不等于 UI 用上了它——这几条锁「真的 wire 进去」。
    //
    // ⚠️ 二轮门自查实证：原来这里写的是 `toContain('REPO_PREP_NODE_ID')`，那是**空**
    // 断言——`import` 那一行就满足它；把判据改成 `r.status === 'done'`、甚至写死成
    // 永不成立，36 条照样全绿。判据本身现已抽成纯函数 `deriveRepoPrepFailed` 并在
    // 上面直测；这里只锁「UI 确实调用了它、并把结果喂给 resumeStatus」。
    expect(DETAIL_SRC).toContain('deriveRepoPrepFailed(nodeRuns.data?.runs)')
    expect(DETAIL_SRC).toContain('resumeStatus(tk.status, tk.worktreePath, repoPrepFailed)')
    expect(DETAIL_SRC).toContain("resumability === 'repo-prep-failed'")
    expect(DETAIL_SRC).toContain("t('tasks.resumeRepoPrepFailed')")
    // 反向：这条提示**不得**带「启动新任务」链接——那正是它要纠正的错误引导。
    const prepBanner = /resumability === 'repo-prep-failed'[\s\S]{0,900}?resumeRepoPrepFailed/.exec(
      DETAIL_SRC,
    )
    expect(prepBanner).not.toBeNull()
    expect(prepBanner![0]).not.toContain('relaunchFrom')
    expect(DETAIL_SRC).toContain("(tk.workspaceState ?? 'available') === 'available'")
    expect(DETAIL_SRC).toContain('workspaceState={tk.workspaceState}')
    expect(DETAIL_SRC).toContain("tk.workspaceState === 'pruning'")
    expect(DETAIL_SRC).toContain("t('tasks.workspacePruning')")
    expect(DETAIL_SRC).toContain("t('tasks.workspacePruned')")
  })

  test('cleanup copy is present and translated in both locales', () => {
    expect(zhCN.tasks.workspacePruning).toContain('正在清理')
    expect(zhCN.tasks.workspacePruned).toContain('节点重试')
    expect(enUS.tasks.workspacePruning).toContain('being cleaned up')
    expect(enUS.tasks.workspacePruned).toContain('node retry')
  })
})

// Source-level wiring lock for the RFC-164/167 fix. canOfferResume above locks
// the decision; these lock that tasks.detail.tsx actually gates the Resume
// button on it (not the bare resumeStatus) and wires the turn-engine relaunch
// hint. A revert to `{resumability === 'ready' && (<button…resume/>)}` — the
// original bug that showed Resume on a turn-engine group whose /resume 403s —
// reds here even though the pure tests stay green.
describe('tasks.detail.tsx — resume button/hint wiring (source locks)', () => {
  test('the Resume button is gated on showResume := canOfferResume(...) with the workgroup flags', () => {
    expect(DETAIL_SRC).toMatch(/const showResume = canOfferResume\(\{/)
    expect(DETAIL_SRC).toMatch(/isWorkgroup,\s*\n\s*isDynamicWorkgroup,/)
    expect(DETAIL_SRC).toMatch(/\{showResume && \(/)
  })

  test('the Resume button is NOT gated directly on resumability alone (the original bug)', () => {
    // The buggy gate rendered the button whenever resumability was 'ready',
    // ignoring workgroup mode. `resumability === 'ready'` still legitimately
    // appears in the hint gate — what must be gone is it directly fronting the
    // <button> that fires resume.mutate().
    expect(DETAIL_SRC).not.toMatch(/\{resumability === 'ready' && \([\s\n]*<button/)
  })

  test('the turn-engine workgroup relaunch hint is wired (showWorkgroupResumeHint → resumeUnavailableWorkgroup)', () => {
    expect(DETAIL_SRC).toMatch(/const showWorkgroupResumeHint =[\s\S]*?!isDynamicWorkgroup/)
    expect(DETAIL_SRC).toMatch(
      /\{showWorkgroupResumeHint && !dismissedBanners\.has\(workgroupResumeBannerKey\) && \(/,
    )
    expect(DETAIL_SRC).toMatch(/tasks\.resumeUnavailableWorkgroup/)
    expect(DETAIL_SRC).toMatch(/dismissBanner\(workgroupResumeBannerKey\)/)
  })

  test('resumeUnavailableWorkgroup copy exists in both i18n bundles', () => {
    expect(enUS.tasks.resumeUnavailableWorkgroup.length).toBeGreaterThan(0)
    expect(zhCN.tasks.resumeUnavailableWorkgroup.length).toBeGreaterThan(0)
  })
})

describe('canRetryNodeRun', () => {
  test('failed run on a failed task → true', () => {
    expect(canRetryNodeRun('failed', 'failed')).toBe(true)
  })

  test('interrupted run on an interrupted task → true', () => {
    expect(canRetryNodeRun('interrupted', 'interrupted')).toBe(true)
  })

  test('exhausted run on a failed task → true (retries blown, fresh attempt OK)', () => {
    expect(canRetryNodeRun('exhausted', 'failed')).toBe(true)
  })

  test('canceled run on a canceled task → true (cancel/resume cycle)', () => {
    expect(canRetryNodeRun('canceled', 'canceled')).toBe(true)
  })

  test('failed run on a STILL-running task → false (API would 409 task-still-running)', () => {
    expect(canRetryNodeRun('failed', 'running')).toBe(false)
  })

  test('failed run on a pending task → false (scheduler is alive, would race)', () => {
    expect(canRetryNodeRun('failed', 'pending')).toBe(false)
  })

  test('done run on a done task → false (would redo finished work)', () => {
    expect(canRetryNodeRun('done', 'done')).toBe(false)
  })

  test('skipped run → false', () => {
    expect(canRetryNodeRun('skipped', 'done')).toBe(false)
  })

  test('running run → false (scheduler still owns it)', () => {
    expect(canRetryNodeRun('running', 'running')).toBe(false)
  })

  test('pending run → false', () => {
    expect(canRetryNodeRun('pending', 'failed')).toBe(false)
  })

  test('missing taskStatus → still gates on run (defensive)', () => {
    expect(canRetryNodeRun('failed', undefined)).toBe(true)
  })
})
