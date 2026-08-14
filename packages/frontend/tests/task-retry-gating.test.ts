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
  findRepoPrepRetryTarget,
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
  test('findRepoPrepRetryTarget：failed 与 interrupted 都算「卡在准备」', () => {
    const mk = (nodeId: string, status: string) => ({ id: 'r1', nodeId, status }) as never
    expect(findRepoPrepRetryTarget([mk('__repo_prep__', 'failed')])).not.toBeNull()
    // daemon 重启打断准备时 boot reap 落的就是 interrupted —— 只认 failed 会让这类
    // 任务掉回 worktree-missing 分支，UI 劝用户另起任务（正是第四态要消灭的误导）。
    expect(findRepoPrepRetryTarget([mk('__repo_prep__', 'interrupted')])).not.toBeNull()
  })

  test('findRepoPrepRetryTarget：其余状态与其余节点一律不算', () => {
    const mk = (nodeId: string, status: string) => ({ id: 'r1', nodeId, status }) as never
    for (const s of ['pending', 'running', 'done', 'canceled']) {
      expect(findRepoPrepRetryTarget([mk('__repo_prep__', s)]), s).toBeNull()
    }
    // 别的节点失败 ≠ 卡在准备。
    expect(findRepoPrepRetryTarget([mk('n1', 'failed')])).toBeNull()
    expect(findRepoPrepRetryTarget([])).toBeNull()
    expect(findRepoPrepRetryTarget(undefined)).toBeNull()
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

// RFC-287 G7 的 wire 锁**独立成组**。三轮门测试有效性自查指出：它们原本寄生在
// 下面那条 RFC-300 用例体内，RFC-300 那条一旦被改名 / 删掉，这批锁会跟着一起
// 消失，而且没有任何东西会因此变红——保护凭空蒸发，无人察觉。
describe('RFC-287 G7 wiring', () => {
  test('第四态真的 wire 进 UI（纯函数算得对 ≠ 有人用）', () => {
    // ⚠️ 二轮门自查实证：原来这里写的是 `toContain('REPO_PREP_NODE_ID')`，那是**空**
    // 断言——`import` 那一行就满足它；把判据改成 `r.status === 'done'`、甚至写死成
    // 永不成立，36 条照样全绿。判据本身已抽成纯函数并在上面直测；这里只锁「UI 确实
    // 调用了它、并把结果喂给 resumeStatus」。
    expect(DETAIL_SRC).toContain('findRepoPrepRetryTarget(nodeRuns.data?.runs)')
    expect(DETAIL_SRC).toContain('resumeStatus(tk.status, tk.worktreePath, repoPrepFailed)')
    expect(DETAIL_SRC).toContain("resumability === 'repo-prep-failed'")
    expect(DETAIL_SRC).toContain("t('tasks.resumeRepoPrepFailed')")
    // 反向：这条提示**不得**带「启动新任务」链接——那正是它要纠正的错误引导。
    const prepBanner = /resumability === 'repo-prep-failed'[\s\S]{0,900}?resumeRepoPrepFailed/.exec(
      DETAIL_SRC,
    )
    expect(prepBanner).not.toBeNull()
    expect(prepBanner![0]).not.toContain('relaunchFrom')
  })
})

describe('RFC-300 workspace capability wiring', () => {
  test('detail hides preserved/retry/sync affordances and renders both cleanup states', () => {
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

// RFC-287 AC-11 的 **UI 半场** —— 三轮门按 AC 逐条对账时挖出来的真缺口。
//
// 后端半场早就绿了（retryNode 认 `__repo_prep__` 并按 failed/interrupted 放行），
// 可用户点不到：UI 上唯一的重试入口是「画布点节点 → NodeDetailDrawer 的重试按钮」，
// 而画布画的是 `task.workflowSnapshot.definition.nodes`——合成行 `__repo_prep__`
// **不在工作流图里**，永远画不出来。当时横幅的注释还写着「下方节点表里那一行就能
// 重试」、文案也写着 "retry … in the node list below"，指的是一个不存在的东西。
// 于是 AC-11「重试作用于任务当前所处阶段」在准备阶段实际为零。
//
// 修法是把动作挂到横幅自己身上。下面三层锁：判据算得对 / 动作真的接上了 / 文案不再
// 指向不存在的入口。
describe('RFC-287 AC-11 — 准备失败的重试入口（UI 半场）', () => {
  const mk = (id: string, nodeId: string, status: string) => ({ id, nodeId, status }) as never

  test('findRepoPrepRetryTarget：给出准备行的 runId，且取最后一条', () => {
    // 重试会铸新的 node_run（retry_index 递增）。指向最早那次失败的话，第二次点重试
    // 会打到一条已经被 superseded 的行上。
    expect(
      findRepoPrepRetryTarget([
        mk('r1', '__repo_prep__', 'failed'),
        mk('r2', '__repo_prep__', 'failed'),
      ]),
    ).toBe('r2')
    expect(findRepoPrepRetryTarget([mk('r1', '__repo_prep__', 'interrupted')])).toBe('r1')
  })

  test('findRepoPrepRetryTarget：无准备失败时给 null（横幅与按钮都不出现）', () => {
    expect(findRepoPrepRetryTarget([mk('r1', '__repo_prep__', 'running')])).toBeNull()
    expect(findRepoPrepRetryTarget([mk('r1', 'n1', 'failed')])).toBeNull()
    expect(findRepoPrepRetryTarget([])).toBeNull()
    expect(findRepoPrepRetryTarget(undefined)).toBeNull()
  })

  test('横幅真的接上了重试动作（打的是既有单节点重试端点、cascade=false）', () => {
    // 光有纯函数不够——缺口正是「算得对但没人用」。这里锁 JSX 侧的接线。
    expect(DETAIL_SRC).toContain('const repoPrepRetryRunId = findRepoPrepRetryTarget(')
    expect(DETAIL_SRC).toMatch(/retryRepoPrep = useMutation/)
    // 端点形状：/nodes/{runId}/retry?cascade=false —— 准备是第 0 步，没有下游要级联。
    expect(DETAIL_SRC).toMatch(/\/nodes\/\$\{encodeURIComponent\(runId\)\}\/retry\?cascade=false/)
    // 按钮挂在横幅的 action 槽位上，并把 runId 传进去。
    expect(DETAIL_SRC).toMatch(/retryRepoPrep\.mutate\(repoPrepRetryRunId\)/)
    // 复用公共 btn class，不是自写 chrome（CLAUDE.md §Frontend UI consistency）。
    expect(DETAIL_SRC).toMatch(/className="btn btn--sm btn--primary"[\s\S]{0,200}retryRepoPrep/)
    // 失败要看得见：重试报错走 ErrorBanner，而不是静默。
    expect(DETAIL_SRC).toMatch(/ErrorBanner error=\{retryRepoPrep\.error\}/)
  })

  test('文案不再把用户指向不存在的「下方节点列表」', () => {
    // 这是缺口的另一半：即便按钮补上了，旧文案仍在教用户去找一个画不出来的行。
    expect(enUS.tasks.resumeRepoPrepFailed).not.toMatch(/node list below/i)
    expect(zhCN.tasks.resumeRepoPrepFailed).not.toContain('下方节点列表')
    // 两语都得有按钮文案，且 pending 态不同字（否则点下去毫无反馈）。
    expect(enUS.tasks.retryRepoPrep.length).toBeGreaterThan(0)
    expect(zhCN.tasks.retryRepoPrep.length).toBeGreaterThan(0)
    expect(enUS.tasks.retryRepoPrepPending).not.toBe(enUS.tasks.retryRepoPrep)
    expect(zhCN.tasks.retryRepoPrepPending).not.toBe(zhCN.tasks.retryRepoPrep)
  })
})
