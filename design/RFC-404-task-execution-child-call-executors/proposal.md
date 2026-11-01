# RFC-404 task-execution 子任务调用节点迁入 engine/node（RFC-294 S6，design §5.5 第 3 步之二）

- **状态**：In Progress（2026-10-31 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；
  2026-10-31「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定
  （见 §6，可推翻）。纯结构重构，无用户可见变化。设计门免（同 RFC-402 / RFC-403）；实现门由本会话按路径限定、只审功能地自审一轮。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.5 第 3 步
- **前序**：[RFC-403](../RFC-403-task-execution-small-leaf-executors/proposal.md)（小型叶子节点，本 RFC 沿用其形状与守卫做法）
- **落位**：task-execution `engine/node/{call-workflow,call-workgroup}/`（执行器）、`engine/node/shared/child-call/`（两种 kind 共享的主体）、
  `application/`（共享判定与错误分类）、`domain/`（纯解析）、`application/ports`（窄合同）、`composition/`（端口绑定）

## 1. 背景

RFC-294 design §5.5 第 3 步：「依次迁 code-host、input / output、call-workflow / call-workgroup、agent、workgroup host」。RFC-403 迁完了
code-host、input / output 与 review / clarify。本 RFC 迁 call-workflow / call-workgroup。

现状（行号以提交 `2874dd182` 为准，`N` = `TE/composition/nodeMechanics.ts`，3656 行）：

- 两种 kind 经 `engine/node/childCallNodeExecutors.ts` 的委托壳 → `legacyArgs` → `N` 的同一个 `runCallWorkflowNode`（`N:965-1633`，669 行）
  执行；配套 helper 在 `N:938-963`（观察间隔、关停确认窗口、人工等待台账解析）与 `N:1635-1982`（结算、关停判定、子任务 runtime、继承
  工作区、两条发起臂、目标模板渲染），委托 actor 解析在 `N:146-177`。合计约 1070 行。
- 主体分八段：选择器与冻结闭包 → 上游输入 → 取行（带领养短路，RFC-243-LOCK：领养绝不 mint）→ 深度与子任务预算两道门 → 从本节点
  iso 派生子任务工作区 → 预铸子任务 id 后发起 → 等子任务终态（人工等待台账、中断子任务的一次续跑、关停判别）→ 终态映射、输出投影、
  先 done 后按 merge_state 合并。
- calls 不走 `runAssembly`、不占任何节点池名额（RFC-287 T9、RFC-243 实现门 P2-4 锁定的刻意例外），迁目录时不能改成 assembly 线。
- `parseIsoSubmodules`（`N:897-923`）除 calls 外还被 `wrapperMechanics.ts`、`executionMergeRecovery.ts` 从 `N` 引用；calls 迁走后 `N` 不再
  使用它。人工等待台账的解析在 `N` 与 `domain/resourceLimitUsage.ts`（`decodeCallHumanWait`）各有一份，语义相同。
- 子任务预算、终态观察、结果投影的实现在 `services/execution/{childBudget,executionWatch,outcome}.ts`，冻结闭包访问器在
  `TE/infrastructure/legacyCallClosure.ts`（`services/execution/closure.ts` 只是 4 行转导出）。

## 2. 目标

- **G1 两种 kind 迁入 engine**：call-workflow、call-workgroup 的执行器分别在 `engine/node/<registry key>/`，共享主体在
  `engine/node/shared/child-call/`，经显式端口执行，不再经过 `legacyArgs` 或 `TaskMechanicsState`；`N` 中 calls 主体与全部配套 helper
  删除，旧委托壳删除。
- **G2 共享实现各一份**：`parseIsoSubmodules` 归 domain，`W`、`executionMergeRecovery.ts` 改指；人工等待台账只留 domain 一份编解码；
  发起失败的错误码分类、取消竞态容忍与 calls 拒绝错误归 application，engine 不 import `@/util/errors`。
- **G3 跨 context 只走现有合同**：委托 actor（identity-access）、子任务发起 / 续跑 / 取消（task-execution 自己的 child launch 与 scheduler
  driver）由 composition 绑定注入；子任务继承的 runtime 仍由唯一的 `buildChildRuntime` 经 `pickInheritableRunConfig` 构造。
- **G4 守卫不缩**：按 `N` 路径或函数名取语料的守卫（RFC-243、RFC-284 T20、RFC-285 B3、RFC-287 T8 / T9、RFC-292、RFC-317、RFC-376、
  RFC-395、RFC-103、subagent live capture 等）精确改指并保留负例；Windows 两份 `paths:` 同步；账本按实测更新，只降不升。
- **G5 纯结构**：门的顺序、领养与续跑语义、关停判别、错误码与消息文本、输出投影、done 与合并的先后都不变。

## 3. 非目标

- agent-single（RFC-405）、workgroup host（RFC-406）的主体迁移；design §5.5 第 4、5 步。本 RFC 不宣称 S6 退出。
- `services/execution/{childBudget,executionWatch,outcome}.ts` 与 `infrastructure/legacyCallClosure.ts` 的实现迁移（本次经端口注入现有实现）；
  `services/execution/closure.ts` 转导出仍有其他使用方，保留。
- 子任务发起参与者、scheduler driver、identity-access 委托请求的合同改动。
- 安全相关改动。

## 4. 用户可见变化

无。HTTP / MCP / WS 合同、数据库结构、发布二进制的行为均不变。

## 5. 验收标准

- **AC-1 迁移**：两种 kind 的执行器在 `engine/node/<registry key>/`，共享主体在 `engine/node/shared/child-call/`，这些文件只 import RFC-403
  允许的层，不引用 `TaskMechanicsState`、`legacyArgs`；`nodeExecution.ts` 以显式端口构造执行器；`N` 中 calls 主体与 helper、旧委托壳
  不存在（结构锁锁定，含负例）。
- **AC-2 共享**：`parseIsoSubmodules`、人工等待台账编解码、发起错误分类各只有一份实现，消费者改指真实 owner，不留 re-export。
- **AC-3 行为不变**：RFC-243 调用 / 恢复矩阵（`rfc243-call-workflow`、`rfc243-parent-child-lifecycle`、`rfc243-executor-facade`）、
  RFC-271 / RFC-395 冻结闭包、RFC-284 T20 继承面、RFC-285 B3 委托 actor、RFC-287 T8 前奏矩阵与 T9 例外、RFC-292 trigger、
  RFC-317 状态转移、单非根成员工作区、P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：RFC-317 偏离账本的 call 领养站点随 owner 改指；RFC-376 setInterval 账本按新站点更新、数量不变；新结构锁覆盖执行器 /
  主体 owner、显式绑定、删除壳与 helper owner，均带负例；不靠放宽匹配。
- **AC-5 账本**：`architecture/counts.json`、`commons-debt.json`、`guard-manifest.json`、`architectureReport.ts` 映射、Windows `paths:`
  按完整候选实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **目录**：执行器各在自己的 registry key 目录（与 RFC-403 一致，结构锁按 key 定位）；两种 kind 共享的主体放 `engine/node/shared/child-call/`，
   不让 call-workgroup 去 import call-workflow 目录。
2. **task 级继承面留在 composition**：子任务 runtime（`buildChildRuntime` + `pickInheritableRunConfig`）、scheduler driver 与委托 actor
   （含 NULL owner 的历史投影）都由绑定填入；engine 只组装本节点的请求（名称、成员、limits、工作区、闭包子集、目标）并保留
   `call-owner-inactive` 判定。
3. **错误分类归 application**：`ValidationError` / `DomainError` / `NotFoundError` 的码提取、`task-not-cancelable` 与 NotFound 的取消竞态
   容忍、三种拒绝错误的构造放 `application/childCallErrors.ts`，engine 调用它；判定仍属 task-execution，不下放到绑定。
4. **人工等待台账合一**：engine 改用 `domain/resourceLimitUsage.ts` 的解码，并在同文件补编码函数；写出的 JSON 键名与顺序不变。
5. **`parseIsoSubmodules` 归 domain**：纯解析（共享 schema + domain 类型），新文件 `domain/isoSubmodules.ts`，不改动 `domain/taskCheckpoint.ts`。
6. **领养后重建 iso 的顺序进绑定**：取 scope、逐仓 HEAD、recoverKey、restore（含 forced paths 与 submodules 还原）原样作为一个工作区端口方法；
   「base snapshot 缺失即 merge-back-failed」的判定留在 engine。
7. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
