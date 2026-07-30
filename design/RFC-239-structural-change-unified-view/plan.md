# RFC-239 · 任务分解与交付计划

> 单 RFC 一次到位(用户决策 D4),但工程量大,拆 **4 个 PR 强顺序**交付;每个 PR 独立全绿(typecheck/lint/test/format:check)可合。测试随任务落地,无「先实现后补测」档。

## PR-1 数据与服务层(后端 + shared,不动 UI)

| # | 任务 | 细节 | 依赖 |
| --- | --- | --- | --- |
| T1 | shared:`FileStructuralDiff.renamedFrom?` | schema 可选字段 + 落盘老 JSON 兼容测试 | - |
| T2 | 后端:rename typed 枚举(新 API) | `util/git.ts` 新增 `gitChangedEntries(Between)`(`--name-status -z --find-renames`,NUL 解析不 trim;**不改**既有 `string[]` 函数——二轮 P1-2);结构侧全部改用;`assemble` readOld 用 oldPath、产出 `renamedFrom`;canonical repo label 单点函数(二轮 P1-3,文本 marker 与结构 merge 共用) | T1 |
| T3 | 后端:`gitDiffSnapshot --find-renames` | 文本 diff 与结构侧 rename 语义对齐(显式化,不依赖宿主 `diff.renames`);回归既有 diff 测试 | - |
| T4 | shared:`changeGroups.ts` 分组模型 | §1.3 规则全量 + 单测矩阵;输入为纯 DTO `ChangeGroupEntry`(二轮 P1-1,不含 UI 类型) | T5 |
| T5 | shared:`ChangeNarrative` schema + `classifyBreaking` 上移 | zod 宽松解析 + 单测;`structureSemantics` 上移 shared(前端 re-export 兼容、测试随迁),`diff` 包依赖以零依赖 `signatureTokensRemoved` 替换 + 等价锁(二轮 P1-1) | - |
| T6 | 后端:change-narrative 服务与端点 | GET/POST、权限(owner/collaborator/**admin**;GET 沿 mountTaskRoutes 现状 403 语义——二轮 P1-5)、single-flight 幂等、`buildNarrativePrompt` 纯函数、numstat `-z` textStats、**runSystemAgent 生产接线按 intent-builder 先例注入 ResolvedRuntime/containmentCoordinator/configDir/profile/opencodeCmd + runFn 测试 seam(二轮 P0-5)**、`narrative-v1` 零工具 permission profile、落盘/清理 + 删除竞态 re-check、`contentDigest` 后端单点下发(二轮 P0-4)、409/422 | T4,T5 |
| T7 | 后端:空态信号 `emptyHint` + file-content 端点 | scratch/no-changes 判定进结构响应;`GET /file-content`(§3.5:`basePath=renamedFrom??filePath`、两侧对称 `{exists:false}`、多仓各自 base_commit——二轮 P0-2;`openContainedFile` 句柄内检查消 TOCTOU——二轮 P0-3;超限/二进制守卫、任务可见性 gate) | T1 |

验收:`structural-diff-rename`/`worktree-diff-rename`/`change-narrative`/`changeGroups`/schema 测试全绿;既有 29 个 structural-diff 测试与 diff 测试回归绿。

## PR-2 前端骨架:页签合并(用旧呈现器换新布局,先立骨架)

| # | 任务 | 细节 | 依赖 |
| --- | --- | --- | --- |
| T8 | tab 合并与 URL 兼容 | `TaskDetailTab` 改 `changes`(8→7),旧值重定向,i18n 「结构变更」,capabilities 合并;task-detail-tabs 测试更新 | - |
| T9 | join 与页面编排 | `lib/changeReview.ts`(join/kind/textStats)+ `ChangeReviewPanel` 三路 query、退化横幅、空态矩阵(消费 T7) | T8 |
| T10 | 左栏 `ChangeOverviewSidebar` | 仓→组→文件(消费 T4)、组头统计/权重条/severity 点、已看迁移(§1.5 精确契约:`loadViewed/saveViewed` + 旧集合值格式逐字沿用,三类存量 JSON 测试——二轮 P1-4)+ Space + 组/总进度、键盘视觉序 | T9 |
| T11 | 右栏骨架 `ChangeFileDetail` | 文件头(renamedFrom/degraded)+ `DiffFileBody` 复用 + `MarkdownDiffView` 渲染/文本切换 | T9 |
| T12 | 旧组件删除/拆迁(含 e2e) | 删 `WorktreeDiffPanel`/`StructuralDiffView` 壳与 walkthrough 卡;`SignatureDiff`/`ImpactPanel`/`DependencyChangesPanel` 迁至 `components/changes/`;旧锁定测试逐条迁移更新(注明 RFC-239);**所有引用旧 tab/旧组件的 Playwright e2e 同 PR 迁移**(设计门修订:e2e 留到 PR-4 会让 PR-2 的 CI 红,不满足每 PR 独立绿) | T10,T11 |
| T13 | 范围/引擎工具条迁移 + 多仓 node 粒度放开 | `ChangeToolbar`;移除 `repoCount===1` 锁 | T9 |

验收:AC-1/2(骨架级)/5/8/9;前端全量测试 + **e2e** 绿;`grep` 旧 tab 值仅允许出现在 URL 兼容映射与其测试处(精确 allowlist,二轮 P1-1 勘误:重定向必须保留旧值字符串,「零残留」不成立),旧组件引用零残留。

## PR-3 前端增强:结构内嵌与下钻

| # | 任务 | 细节 | 依赖 |
| --- | --- | --- | --- |
| T14 | 概要树 `SymbolOutline` | 嵌套折叠(parentId 链)、import 聚合、全 added 折叠到容器级、`added+safe` 去 explain、纯搬移一行、severity/签名 diff/bodyDelta 保留;语义计算下沉 join 阶段一次算 | PR-2 |
| T15 | hunk↔符号双向 | `lib/hunkSymbolMap.ts` + 概要→diff 带行号滚动高亮 + hunk 符号徽标 + sticky 当前符号条 + diff→概要反向高亮 | T14 |
| T16 | 下钻覆盖层 | `DrilldownOverlay`(公共 Dialog 全屏形态,最小扩展)+ 图/影响面/调用链/依赖迁入 + 入口 gating | PR-2 |
| T17 | 图聚焦 + 影响面可点 | `StructuralGraph focusFiles` 过滤(纯函数)+ `ImpactPanel` 条目跳转 | T16 |

验收:AC-3/4(呈现侧)/6;`hunk-symbol-map`/`change-review-panel` 增量断言绿。

## PR-4 AI 导读端到端

| # | 任务 | 细节 | 依赖 |
| --- | --- | --- | --- |
| T18 | `ChangeNarrativeCard` 四态 | 按钮/生成中(轮询 GET)/就绪(总述+阅读顺序+组句回填组头)/失败重试;digest 过期提示;成员/非成员按钮态 | PR-1 T6, PR-2 |
| T19 | 收尾 | **新增**「结构变更」页签 e2e smoke(存量 e2e 迁移已在 T12/PR-2 完成);截图对照核心页做视觉对齐自查;docs 更新(若涉及) | 全部 |

验收:AC-7 全量;四项门禁 + e2e 绿。

## 里程碑与检查点

1. PR-1 合入 → 数据契约冻结(renamedFrom/changeGroups/narrative schema)。
2. PR-2 合入 → 旧两页签消失,新页签可用(结构概要暂为旧式平铺亦可接受的中间态**不存在**——T12 已把树换为分组骨架;PR-2 内右栏概要区暂缺,仅 diff + 文件头,不算回归:旧「结构」树能力在 PR-3 T14 以更强形态回归,PR-2 说明中向用户明示)。
3. PR-3 合入 → AC-3/4/6 全兑现。
4. PR-4 合入 → RFC Done:`design/plan.md` 索引改 Done,STATE.md 记账。

> 风险提示:PR-2 与 PR-3 间存在「概要树暂缺」的中间窗口(预计同 session 连续交付,窗口极短);若用户要求零窗口,可将 T14 并入 PR-2(代价:单 PR 变大)。

## 验收清单(对照 proposal AC)

- [ ] AC-1 页签合并 + 重定向(T8)
- [ ] AC-2 左栏分组总览全要素(T10)
- [ ] AC-3 概要树降噪 + 双向精确互跳(T14,T15)
- [ ] AC-4 rename 全链路(T1,T2,T3 + T11/T14 呈现)
- [ ] AC-5 markdown 渲染视图(T11)
- [ ] AC-6 下钻 + 图聚焦 + 影响面可点(T16,T17)
- [ ] AC-7 AI 导读全状态机(T6,T18)
- [ ] AC-8 空态矩阵(T7,T9)
- [ ] AC-9 多仓 node 粒度(T13)
- [ ] AC-10 四项门禁 + 测试纪律(全程)
