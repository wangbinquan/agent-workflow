# RFC-056 patch 2026-05-25 — 前端运行历史 / Session 选择器 label 必须把 `crossClarifyIteration` 纳入

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up（第七份 RFC-056 patch）。
Scope: bug-fix patch（纯前端展示）。按 `CLAUDE.md` RFC workflow §6 例外条款，
作为 RFC-056 patch 落档而非独立 RFC。

Pairs with（同根因 / 同症状的前序 patch）：

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)
- [`patch-2026-05-24-retry-preserves-cross-clarify-iteration.md`](./patch-2026-05-24-retry-preserves-cross-clarify-iteration.md)
- [`patch-2026-05-25-questioner-rerun-bumps-cci.md`](./patch-2026-05-25-questioner-rerun-bumps-cci.md)
- [`patch-2026-05-25-questioner-cascade-no-skip.md`](./patch-2026-05-25-questioner-cascade-no-skip.md)
- [`patch-2026-05-25-fresher-noderun-includes-cci.md`](./patch-2026-05-25-fresher-noderun-includes-cci.md)
- [`patch-2026-05-26-review-dispatch-respects-cci.md`](./patch-2026-05-26-review-dispatch-respects-cci.md)

## 1. Symptom

跨节点反问场景：questioner 抛出若干问题，用户在 `/clarify/{nodeRunId}`
里把**所有**问题的 scope 都切换成"反问者 (questioner)"，提交"提交并继续反问"。

期望（与 patch-2026-05-25 `questioner-rerun-bumps-cci` 修复后的行为一致）：

- 后端 `mintQuestionerRerun` 正确 mint 一条新的 questioner pending node_run，
  `crossClarifyIteration = max+1, retryIndex = 0`，跑起来，user 在 UI 上看到这条
  新 attempt 出现在 Session tab 的 attempts 下拉以及 Stats tab 的"运行历史"里。

实际：questioner 后台确实重跑了（DB 里能看到新 node_run，session 树也能切到
新行的 opencode session），但**前端 Session tab 的 attempts 下拉**和
**NodeDetailDrawer Stats tab 的运行历史**显示的"执行轮次"仍然是"初次"——和
原始 attempt 完全同名，用户在 UI 上根本分不出哪条是新的、哪条是旧的，行为
看起来像"questioner 没重跑"。

## 2. Root cause — 前端两处 label 函数没读 `crossClarifyIteration`

后端那一串 patch 已经把 cross-clarify rerun 的 mint / dispatch / freshness
通通修对：node_run 表里就是有一条 `(iteration=0, reviewIteration=0,
clarifyIteration=0, crossClarifyIteration=1, retryIndex=0)` 的新行。

前端两个 label 函数继续按"前 RFC-056 时代"的四元组算 label：

```ts
// packages/frontend/src/lib/node-history.ts (NodeDetailDrawer Stats 运行历史)
export function formatIterationLabel(run: NodeRun, opts: IterationLabelOpts): string {
  const parts: string[] = []
  if (run.iteration > 0) parts.push(opts.t('nodeDrawer.iterLoop', { n: run.iteration }))
  if (run.reviewIteration > 0)
    parts.push(opts.t('nodeDrawer.iterReview', { n: run.reviewIteration }))
  if (run.clarifyIteration > 0)
    parts.push(opts.t('nodeDrawer.iterClarify', { n: run.clarifyIteration }))
  if (parts.length === 0) parts.push(opts.t('nodeDrawer.iterInitial')) // ← cci=1 落这里
  if (run.retryIndex > 0) parts.push(opts.t('nodeDrawer.iterRetry', { n: run.retryIndex }))
  return parts.join(' · ')
}

// packages/frontend/src/components/node-session/SessionTab.tsx (attempts 下拉)
function iterLabel(a: NodeRun, t: TFunction): string {
  if (a.clarifyIteration > 0) return t('nodeDrawer.iterClarify', { n: a.clarifyIteration })
  if (a.reviewIteration > 0) return t('nodeDrawer.iterReview', { n: a.reviewIteration })
  if (a.iteration > 0) return t('nodeDrawer.iterLoop', { n: a.iteration })
  if (a.retryIndex > 0) return t('nodeDrawer.iterRetry', { n: a.retryIndex })
  return t('nodeDrawer.iterInitial') // ← cci=1 也落这里
}
```

questioner rerun 行的四元组 `(0, 0, 0, 0)`，五元组 cci=1——两条 label 都
fallthrough 到 `iterInitial`，i18n 字串就是 `初次 / initial`，于是 UI 上"新旧
attempt 同名"。同时 `nodeRunHistory` 的 sort key 也漏了 cci，cci 不同的兄弟行
顺序退化成 `startedAt` 比较，视觉上"新的 cci=1 行"还会跟原 cci=0 行混在一起。

## 3. Fix

### 3.1 新增 i18n key `iterCrossClarify`

- `packages/frontend/src/i18n/zh-CN.ts`：
  - 类型声明里 `iterClarify` 行下方加 `iterCrossClarify: string`
  - 字面量同样在 `iterClarify: '反问#{{n}}'` 下方加
    `iterCrossClarify: '跨反问#{{n}}'`
- `packages/frontend/src/i18n/en-US.ts`：对应位置加
  `iterCrossClarify: 'cross-clarify#{{n}}'`

### 3.2 `formatIterationLabel`（`packages/frontend/src/lib/node-history.ts`）

在 `clarifyIteration` 分支后追加 `crossClarifyIteration` 分支，保持
canonical 顺序 `loop · review · clarify · cross-clarify`；`retryIndex`
继续在最后追加。文档 comment 同步更新为五元组语义，并写明
mintQuestionerRerun 场景下漏读 cci 的后果（避免下次回归）。

### 3.3 `nodeRunHistory` sort（同上文件）

排序键改为 `(iteration, reviewIteration, clarifyIteration,
crossClarifyIteration, retryIndex, startedAt)`，与
`patch-2026-05-25-fresher-noderun-includes-cci.md` 后端 comparator 顺序
对齐。这样 cci 不同的兄弟行在历史列表里有确定顺序，新行总在旧行之后。

### 3.4 `iterLabel`（`packages/frontend/src/components/node-session/SessionTab.tsx`）

`clarifyIteration` 检查之后立刻检查 `crossClarifyIteration`——保持
"clarify 路径"优先于"loop / review / retry"的现有 UX，同时让 cross-clarify
路径有自己的 chip。附 comment 解释 mintQuestionerRerun 为什么必须读 cci。

## 4. 不退化保证

1. **所有 cci=0 路径**（绝大多数 self-clarify / 无 cross-clarify 工作流）：
   新分支条件恒假，label 走与旧版字节级一致的代码路径；sort 也回退到旧四元组
   逻辑。既有 `node-history-split.test.ts` / `session-attempts-picker.test.tsx`
   全套断言保持原值。
2. **clarify + cross-clarify 都非零**：label 同时输出两个 chunk
   （`反问#N · 跨反问#M`），保留 chronological 含义。新增单测覆盖。
3. **cross-clarify + retry**：retry chunk 仍排在末尾
   （`跨反问#N · 重试#M`），与既有"clarify + retry"语义对称。新增单测覆盖。
4. **`iterLabel` 与 `formatIterationLabel` 出现分歧**：本 patch 让两者对
   cross-clarify 的判定一致（都新增分支），不引入新的不一致点。

## 5. Tests

文件改动：

- `packages/frontend/src/i18n/zh-CN.ts`（类型 + 字面量各一行）
- `packages/frontend/src/i18n/en-US.ts`（字面量一行）
- `packages/frontend/src/lib/node-history.ts`（comment + sort + label）
- `packages/frontend/src/components/node-session/SessionTab.tsx`（`iterLabel` + comment）
- `packages/frontend/tests/node-history-split.test.ts`（+4 case：sort cci，
  label cross-clarify only / clarify+cross / cross+retry）
- `packages/frontend/tests/session-attempts-picker.test.tsx`（既有 "iter label
  distinguishes ..." 用例扩成 5 类，包含 cross-clarify 行）

运行门槛（按 CLAUDE.md "Test-with-every-change" §运行门槛）：

```
bun run typecheck && bun run test && bun run format:check
```

按 [feedback_post_commit_ci_check]，push 后立刻查 GitHub Actions。

## 6. Out of scope

- **不改任何后端 mint / dispatch / comparator 代码**：纯前端展示 patch。
- **不改 schema / migration / WebSocket 协议**：`crossClarifyIteration`
  早就在 `NodeRun` schema 里（`schemas/task.ts:232`），前端 query / WS payload
  已经收到该字段，只是没用。
- **不改 `i18n.attemptsCount` / `attemptPickerLabel` 等周边 key**：本 patch
  只新增 `iterCrossClarify`，不动既有 key。
- **不动 NodeDetailDrawer 的高亮 / 排序 / dom 结构以外的渲染逻辑**：本 patch
  最小修；UI 只多出"`跨反问#N`" chip 这一处新增。

## 7. 用户验证路径

- 任意已存在的"跨节点反问"工作流：触发 questioner 抛问题，所有 scope 全选
  "反问者"，提交"继续反问"。
- 打开 NodeDetailDrawer Session tab：attempts 下拉应该至少出现两个 option，
  新 attempt label 含 `跨反问#1` / `cross-clarify#1`，旧 attempt 仍是 `初次 /
  initial`。
- 切到 Stats tab："运行历史"列表里同样能看到新增的 `跨反问#1` 行，且排在原
  `初次` 行之后，active 高亮在新行上。
