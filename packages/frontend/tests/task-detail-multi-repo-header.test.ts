// LOCKS: RFC-066 PR-C — task detail multi-repo header source-level guard.
//
// Spinning up the full task detail page would require the entire
// nodeRuns / outputs / clarify / review fixtures. Source-text grep is the
// minimum lock that proves the markup is wired:
//   F11a `tk.repoCount > 1` gates a `<details>` block.
//   F11b The block iterates `tk.repos.map(...)` rendering worktreeDirName +
//        baseBranch + redactGitUrl(repoUrl).
//   F11c i18n key `tasks.multiRepoSummary` drives the summary label.
//   F11d Single-repo tasks never render the block (no leakage into the
//        legacy detail card markup).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

describe('RFC-066 PR-C — task detail multi-repo header', () => {
  test('F11a `tk.repoCount > 1` gates the multi-repo summary block', () => {
    expect(SRC).toContain('tk.repoCount > 1')
    // The block uses a `<details>` with the canonical testid.
    expect(SRC).toContain('data-testid="task-detail-multi-repo"')
  })

  test('F11b iterates tk.repos with mountPath + baseBranch + redactGitUrl', () => {
    expect(SRC).toContain('tk.repos.map')
    // RFC-248: 显示的是**挂载路径**而不是 basename——嵌套布局下 basename 丢
    // 方位（`sdk` 说不清它在哪一层），`vendor/sdk` 才是用户能 `cd` 过去的东西。
    // RFC-248（实现门 P2）：多仓块改用共享的 `RepoLayoutTree` 渲染——挂载路径
    // 由它显示，这里锁「用的是共享树」而不是又一份扁平列表。
    expect(SRC).toContain('RepoLayoutTree')
    expect(SRC).toContain('mountPath: r.mountPath')
    expect(SRC).toContain('ref: r.baseBranch')
    // RFC-248: 每行的 testid 由共享树给出（`<prefix>-row-<mountPath>`），
    // 不再由这个页面自己拼——所以这里锁的是「传了稳定的 testidPrefix」。
    expect(SRC).toContain('testidPrefix="task-detail-repo-layout"')
    // RFC-024 redactGitUrl is reused for the URL column (no cleartext leak).
    expect(SRC).toContain('repoUrlRedacted: r.repoUrl')
  })

  test('RFC-248: 组溯源 chip 与只读 chip 都在多仓块里', () => {
    // 组名是启动时的快照（设计门 G5），组被删也要能渲染——所以读的是
    // `tk.repoGroupName` 而不是去查当前的组定义。
    expect(SRC).toContain('tk.repoGroupName')
    expect(SRC).toContain('task-detail-repo-group')
    // RFC-248（实现门 P2）：溯源按 repoGroupName 判定，**不能**再套在
    // `repoCount > 1` 里——单成员组也是组。
    const chipIdx = SRC.indexOf('task-detail-repo-group')
    const gateIdx = SRC.indexOf('tk.repoCount > 1')
    expect(chipIdx).toBeGreaterThan(0)
    expect(chipIdx).toBeLessThan(gateIdx)
    // 只读成员被改动过要有显式告警（AC-19）。
    expect(SRC).toContain('task-detail-readonly-dirty-banner')
  })

  test('F11c summary label sourced from i18n key `tasks.multiRepoSummary`', () => {
    expect(SRC).toContain("t('tasks.multiRepoSummary'")
  })

  test('F11d single-repo render does NOT include the multi-repo block markup outside the `repoCount > 1` guard', () => {
    // Confirm the markup is BELOW the gate (i.e. inside the conditional).
    const gateIdx = SRC.indexOf('tk.repoCount > 1')
    const blockIdx = SRC.indexOf('task-detail-multi-repo')
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(blockIdx).toBeGreaterThan(gateIdx)
  })
})
