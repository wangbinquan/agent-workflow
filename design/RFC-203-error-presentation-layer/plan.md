# RFC-203 任务分解（plan）

> 三个 PR 交付（词条体量大，单 PR 会把评审面撑爆；拆分理由记录于此，符合仓规「如需拆分在 plan.md 说明」）。commit 前缀 `feat(errors): RFC-203 …`。

## PR-1 基建层（T1/T2/T4/T6）

- **RFC-203-T1 resolveApiError 解析器**
  新建 `frontend/src/i18n/errors.ts`：三级降级 + 归一（TypeError→network-unreachable、非 JSON 错误响应 capped res.text() 作 raw）+ overrides + 插值白名单 + `labelForCode` helper；`describeApiError` 改薄壳；client.ts 收编 WS 嵌套体。**L2 域模板 19 条 + fallback 去拼接随本 PR 落**（设计门 P1：契约切换与兜底词条必须同批，否则 PR-1 期间未映射错误只剩「请求失败」丢诊断）。测试：≥12 用例 + domainOf 全表 + 中间态兜底断言。
- **RFC-203-T2 ErrorBanner/ErrorDetails 富渲染**
  `ErrorDetails` 六形状 + 未知跳过 + raw 折叠；ErrorBanner 接 `overrides`；RFC-202 的 workflows.edit details 局部渲染迁入并删除。测试：六形状各一 + 未知安全。
- **RFC-203-T4 failureCode 端到端 + errorSummary 影射**
  shared NodeRunSchema + **Task/TaskSummary** 加可选 `failureCode`（failed-run oracle 投影，复用 pickFreshestRun）；getTaskNodeRuns/getTask/listTasks 映射；`lib/task-failure.ts` 三级 describeTaskFailure（影射表含 dw-generate-exhausted，接通 workgroups.dw.exhausted 死词条）；五个消费面改造（tasks.detail 横幅/meta、tasks 列表、NodeDetailDrawer、DynamicWorkflowPanel）。测试：透出 + 任务级投影 + 优先级 + 前缀令牌 + dw 面板专项。
- **RFC-203-T6 后端非统一体收敛 + 引用清单 ACL 化**
  tasks.ts:308（新码 call-target-method-required）/ plantuml×3 / ws/server×5 改统一体；deleteMcp/deletePlugin/deleteAgent/deleteWorkgroup/deleteSkill 的引用 details 改 principal-aware 形状（visible[]+hiddenCount，deleteWorkflow 先例）——未改造形状 ErrorDetails 只渲染计数（ACL 铁律）。测试：路由形状锁 + 他人私有引用不泄名。
- 门槛：全量四门 + binary smoke（shared 变更）。

## PR-2 词条批量（T3）

- **RFC-203-T3a L1 精确词条**：12 个全量域（task/task-question/clarify/review/workflow/upload/schedule/runtime/mcp/plugin/agent/skill）+ repo 高频子集 ~25 + auth 子集 ~12 + Tier-2 wire 码 + `network-unreachable`/`plantuml-*`，zh/en 双语，`__hint` 按需。
- **RFC-203-T3b L2 域模板 19 条 + L3 fallback 去原文拼接**；清理 5 个孤儿键。
- **RFC-203-T3c 校验 issue 词条**：`validation.*` 常见 ~40 精确 + 族兜底；`describeValidationIssue` helper；workflows.edit ValidationPanel 接入。
- 测试：词条完整性（zh/en diff 空、19 域齐、样式抽查断言）+ 校验面板中文化断言。
- 词条撰写规范：标题 = 用户语言一句话；hint = 明确动作（去哪里、点什么）；禁止内部术语（node_run/envelope/CAS/iso）。

## PR-3 分叉清零迁移（T5）

- **RFC-203-T5a** 6 处私有 describeError 替换 + 各消费点断言更新；DetailHeaderActions 改走 ErrorBanner+ErrorDetails（agents/skills 删除引用清单的实际屏幕入口）；PlantUmlBlock.proxyRender 接 resolveApiError。**注意（PR-1 实现门 P2 后续约束）**：PlantUmlBlock 的 3 处裸 fetch 接 resolveApiError 时必须同时换成 `fetchOrNetworkError`（api/client.ts 导出），否则离线时显示原文 "Failed to fetch"；换完把它加进 `rfc203-network-tagging-source-lock.test.ts`。
- **RFC-203-T5b** 22 处裸 `.error-box` 迁 ErrorBanner（workgroup 8 + home 3 优先）；视觉零回归自查（错误态不在基线路径，home 三处确认基线为正常态）。
- **RFC-203-T5c** DISPATCH_ERROR_KEYS→overrides、describeRecoveryKind→labelForCode；源码锁三条（私有 describeError 零命中 / error-box 白名单 / fallback 不拼原文）。
- 收尾：Codex 实现门（每 PR 各一次）；design/plan.md 状态翻转；STATE.md 记录；push 后按 sha 查 CI。

## 验收清单（对应 proposal §5）

- [x] A1 resolveApiError 三级 + 归一 + 兼容壳（PR-1，36749ddf；归一改边界打标见 design §1.10）
- [x] A2 ErrorDetails 六形状（PR-1，36749ddf）
- [x] A3 词条 L1≥150（实 302+27hint）/ L2×19 / 校验≥40（实 65 全量）/ 孤儿清零（PR-2，见 design §1.11）
- [x] A4 failureCode 端到端 + 影射表 ≥12（PR-1；PR-1 实现门补 dw-reject-exhausted）
- [x] A5 分叉清零 + 源码锁（PR-3，见 design §1.13：T5a/T5b/T5c 三批 + 三源码锁）
- [x] A6 非统一体收敛（PR-1，36749ddf）+ 引用清单 ACL 化（**勘误**：此半截 PR-1 漏项，补課于 PR-3，见 design §1.13-T6）
- [x] A7 全量门槛（PR-1 / PR-2 均四门全绿 + 定向 e2e）

## 协调注意

- `zh-CN.ts`/`en-US.ts` 现已释放（RFC-201 落地），但 PR-2 是巨型词条 diff——动手前 `git status` 确认无并发占用，提交按精确 pathspec。
- `tasks.detail.tsx`/`NodeDetailDrawer` 是高频冲突文件，实现期间每次动手前检查在途改动。
- 与 RFC-B（静默失败清零）的边界：本 RFC 不加 MutationCache/toast；RFC-B 落地时直接复用 resolveApiError。
