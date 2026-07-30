# RFC-236 · 循环包装器达到迭代上限后的处理策略

- 状态：Done（2026-07-30；设计门、实现门均 APPROVED，P0/P1/P2=0；本地实现与验证完成）
- 日期：2026-07-30
- 发起：用户要求「给循环包装器的配置界面加个开关，放在最大迭代次数后面，用来控制循环
  超出次数后是直接失败还是继续流程执行下去」。
- 相关设计：P-4-01 / P-4-02、RFC-040（wrapper resume）、RFC-095（scope outcome）、
  RFC-096（done-only port 读取）、RFC-130（wrapper-private canonical）、
  RFC-193（port artifact 投影）。

## 1. 背景

`wrapper-loop` 当前只有一种达到上限后的语义：每轮 inner scope 成功，但直到
`maxIterations` 全部执行完仍未满足 `exitCondition` 时，wrapper 写成 `exhausted`，整个任务
失败，下游节点不再执行。

这个默认适合“退出条件是硬门”的循环，但不适合 best-effort 场景。例如循环负责有限轮优化、
审阅或修复时，使用者可能希望“最多尝试 N 次；若仍未达到理想条件，也采用最后一轮结果继续
交付”。目前只能删除退出门或人为放宽条件，无法同时表达“有限尝试”和“上限后继续”。

## 2. 目标

1. 在循环包装器检查器的“最大迭代次数”后增加一个开关。
2. 新增 `continueOnMaxIterations: boolean` 配置；缺失时严格等价于 `false`。
3. 开关关闭时保持现有 `exhausted → task failed` 行为。
4. 开关开启时，最后一轮 inner scope 已成功、但退出条件仍未满足，则采用最后一轮
   `outputBindings`，合并 loop-private canonical，将 wrapper 标为 `done` 并继续下游。
5. 内部节点失败、取消、人工停泊和 merge-back 失败/冲突继续走原有语义，不被该开关吞掉。
6. YAML、复制、意图构建、任务快照和 resume/retry 均保留同一字段语义。

## 3. 产品决策

- **D1 — 布尔 opt-in，默认失败**：字段名固定为 `continueOnMaxIterations`。只有精确
  `true` 开启；字段缺失或 `false` 继续使用现有失败语义，保证旧工作流、旧 YAML 和历史任务
  快照零行为漂移。
- **D2 — “达到上限”不多跑一轮**：`maxIterations=N` 仍只执行 N 轮。新策略只改变第 N 轮
  成功结束且退出条件为 false 后的收尾，不创建第 N+1 轮。
- **D3 — 最后一轮即交付轮**：继续模式采用 `iteration=N-1` 的 output binding 内容、kind
  与 artifact archive；缺失输出沿用现有成功退出路径的空值投影规则，不另造 fallback。
- **D4 — 与正常退出共用成功收尾**：最后一轮输出提升、wrapper-private canonical
  merge-back、冲突停泊、merge 失败和 `done` 广播必须走同一个 helper，不能复制两套容易漂移
  的收尾代码。
- **D5 — wrapper 状态为 `done`**：继续模式的 wrapper 是有意接受的成功节点，下游依赖只能
  在 `done` 后放行。不得把 `exhausted` 重新解释为“有时成功”，避免破坏
  `deriveFrontier`、恢复、诊断和失败呈现对该状态的全局不变量。
- **D6 — 只容忍退出条件未满足**：inner scope 的 `failed` / `canceled` / `awaiting_*`、
  wrapper merge conflict / merge failure 均维持现状。开关不是 continue-on-error。
- **D7 — 可诊断但不新增状态**：只有 wrapper 成功写成 `done` 后，继续分支才写结构化
  warning log；不在 canceled/failed 行留下“已继续”的误导标记，不新增 DB 状态、task 状态、
  持久字段或迁移。
- **D8 — UI 紧邻上限字段**：开关位于“最大迭代次数”输入框之后、退出条件区之前，复用公共
  `<Switch>`。中文文案为“达到迭代上限后继续流程”，提示明确“采用最后一轮输出”；英文提供
  同义文案。
- **D9 — 畸形配置 fail closed**：字段缺失合法且解释为 `false`；存在但不是 boolean 时，
  validator 与 scheduler 均以独立错误码拒绝，不把字符串 `"true"`、数字 `1` 等猜成开启。
- **D10 — 不升级 workflow schema version**：这是可选、向后兼容的 node 字段；
  `WorkflowNodeSchema.passthrough()` 已能无损 round-trip。无需 DB migration 或
  `$schema_version` bump。

## 4. 用户故事

### 4.1 默认硬门

作为已有工作流作者，我不操作新开关；循环达到上限仍显示 `exhausted`，任务失败，行为与升级前
完全一致。

### 4.2 Best-effort 继续

作为工作流作者，我开启“达到迭代上限后继续流程”；循环最多执行 N 轮。若退出条件提前满足，
正常退出；若最后仍不满足，系统采用第 N 轮输出和工作树改动，wrapper 完成，下游继续。

### 4.3 真实错误仍失败

即使开启继续模式，只要某轮 Agent 失败、任务被取消或最终 merge-back 失败，循环仍失败或停泊，
不会把未产出有效最后一轮结果的情况伪装为成功。

## 5. 验收标准

1. 循环检查器中，新开关紧跟“最大迭代次数”，旧节点缺字段时显示关闭。
2. 切换开关会持久化精确 boolean，并进入现有 inspector history/undo-redo。
3. 缺字段或 `false` 时，现有 exhausted 测试逐字节保持：wrapper=`exhausted`、task=`failed`、
   下游不执行、错误码仍为 `wrapper-loop-exhausted`。
4. `true` 且退出条件在前 N-1 轮满足时，按现有正常退出路径结束，不写上限继续 warning。
5. `true` 且 N 轮后仍不满足时，只运行 N 轮；wrapper=`done`、task 可继续，后续节点执行。
6. 继续分支的 wrapper 输出来自最后一轮，保留 content/kind/archive；loop-private canonical
   的全部轮次改动按现有成功路径 merge-back。
7. 继续分支若 merge conflict，仍进入 `awaiting_human`；merge failure 仍失败；inner
   failed/canceled/awaiting 语义不变。
8. 非 boolean 字段同时被静态 validator 与 runtime safety net 拒绝，并定位回新开关。
9. YAML round-trip、复制/粘贴、工作流同步差异和任务 snapshot 保留该字段；旧定义不被回填或
   自动开启。
10. 中英文文案、frontend/backend/shared 定向测试、typecheck、lint、format、相关 scheduler
    回归和真实浏览器检查全绿；实现完成前通过实现门。

## 6. 非目标

- 不新增第三种策略、重试次数或按错误类型继续。
- 不允许 inner node 失败后继续。
- 不改变 `exhausted` 的全局生命周期含义或颜色。
- 不给运行中的任务热切换策略；任务继续使用启动时冻结的 workflow snapshot。
- 不改变 exit condition 的四种 kind、iteration 编号或跨轮反馈能力。
- 不新增 DB 列、migration、Workflow `$schema_version` 或 NodeRunStatus。
- 不在本 RFC 新增任务级“带警告完成”状态或全站 warning center。

## 7. 实现结果

2026-07-30 已完成 shared strict reader、validator/runtime 双门、scheduler 共用成功收尾、
Inspector Switch、中英文/定位契约及全链回归。缺字段/false 的 exhausted 行为保持；true
只在末轮成功但条件未满足时采用末轮输出与 loop-private canonical，并以 wrapper=`done`
进入 generic downstream。

实现门结论为 **APPROVED（0 open P0/P1/P2）**，详细证据见
[`implementation-gate-2026-07-30.md`](./implementation-gate-2026-07-30.md)。用户随后于
2026-07-30 明确授权“提交上库”；提交、推送与 exact-SHA CI 证据由发布流程独立核验。
