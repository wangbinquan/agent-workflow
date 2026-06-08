# RFC-088 任务分解

PR 强序：PR-A（纯函数 + i18n，无 UI 行为）→ PR-B（tree 解释/分级/排序筛选）→
PR-C（walkthrough 导览卡 + 收尾）。每个 PR 自带测试、各自 CI 全绿才推进下一个。

## PR-A —— 语义纯函数 + i18n 地基

- **RFC-088-T1**：新建 `packages/frontend/src/lib/structureSemantics.ts`，实现
  `classifyBreaking` / `explainChange` / `orderAndFilterChanges` / `walkthroughItems`
  （契约见 design §2）。复用 `groupFileChanges` 与 `diffSignatureTokens`。保持 cycle-free。
- **RFC-088-T2**：i18n key——`tasks.structExplain*`（removed-public / sig-param / visibility-narrowed
  / renamed / added / body-only / private 等）+ severity chip 文案 + "可见性未知" + 排序/筛选/导览
  标签；en-US 值 + zh-CN `Resources` 类型 + zh-CN 值三处同步。
- **RFC-088-T3**：单测 `tests/structure-semantics.test.ts`——classifyBreaking 判定矩阵全覆盖、
  explainChange key/vars、orderAndFilterChanges、walkthroughItems（design §6）。
- 依赖：无（建于已并入 RFC-083 的 `diffSignatureTokens` 之上）。
- 验收：纯函数测试全绿；typecheck/format 绿；UI 未变。

## PR-B —— tree 解释 + 分级 + 排序/筛选

- **RFC-088-T4**：`StructuralDiffView` tree 行渲染 severity chip + explainChange 句子；uncertain
  标注。复用 RFC-083 delta 配色。
- **RFC-088-T5**：排序 `.segmented`（name/severity）+ changeType/severity 筛选 toggle；`StructuralTree`
  渲染前过 `orderAndFilterChanges`。汇总卡数字 `onClick` 即筛 + 新增"破坏性"汇总卡。
- **RFC-088-T6**：CSS——`.structure__severity--{breaking,risky}`、`.structure__explain`，全走主题
  var、复用公共 `.segmented`，不新写 radio/chrome。
- **RFC-088-T7**：渲染测试——chip 出现、点"破坏性"只剩 breaking、severity 排序置顶；扩
  `structure-view.test.tsx` 或新文件。
- 依赖：PR-A。
- 验收：交互测试全绿；视觉对齐 `/tasks` 现有结构 tab；门禁三连绿。

## PR-C —— walkthrough 导览卡 + 收尾

- **RFC-088-T8**：`WalkthroughCard` 组件，渲染在汇总卡与视图切换之间；Top-N by severity；点击走
  既有 `onJumpToHunk` / `openCallChain` / 选中文件回退；无非-safe 改动则不渲染。
- **RFC-088-T9**：渲染测试——有 breaking 时导览卡在最前且点击触发 `onJumpToHunk`（spy）；无破坏
  时不在 DOM；溢出"还有 K 处"。
- **RFC-088-T10**：收尾——`design/plan.md` RFC 索引状态改 Done；`STATE.md` 顶部"进行中 RFC"行更新
  为完成并在已完成表加行；按 [feedback_post_commit_ci_check] 推后查 CI。
- 依赖：PR-B。
- 验收：AC1–AC6 全部满足；单二进制 build smoke 绿（涉 shared 导出时按
  [reference_binary_build_module_cycle]）。

## 验收清单（对应 proposal AC）

- [ ] AC1 explainChange 全 changeType×kind×visibility 非空且正确，中英 key 齐（PR-A/T2/T3）
- [ ] AC2 classifyBreaking 判定矩阵 + 缺 visibility 保守降级（PR-A/T3）
- [ ] AC3 排序/筛选 + 汇总卡即筛，复用 `.segmented`（PR-B/T5/T7）
- [ ] AC4 导览卡按 severity Top-N + 跳转，无破坏不渲染（PR-C/T8/T9）
- [ ] AC5 纯函数优先 + 源码层文本断言兜底（PR-A/T3、PR-C/T9）
- [ ] AC6 typecheck/test/format 三连绿 + build smoke（每 PR）
