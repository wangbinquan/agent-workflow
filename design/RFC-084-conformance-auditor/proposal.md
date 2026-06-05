# RFC-084 — 确定性结构一致性审计节点（类 / 功能对应校验）

> 产品视角。技术契约见 [design.md](./design.md)，任务分解见 [plan.md](./plan.md)。

## 背景

AI 生成代码相对"既有 plan / 类图"会产生两类漂移：

- **类不对应（结构漂移）**：缺类 / 多类、缺方法 / 字段、签名不符、继承 / 实现关系错、依赖方向反、分层越界、基数（一对多 / 可选-必填）不符。
- **功能不对应（行为漂移）**：缺行为 / 错行为、违反不变量、未满足验收标准。

平台已有 Code → Audit → Fix 主循环，但目前 Audit 端靠 LLM auditor agent 重读 diff——这恰恰是平台存在意义要消灭的失败模式：parent context 膨胀、模型精度衰减、判决不可复现。我们要的是一个**确定性、框架级**的审计能力：吃（上游规划 agent 产出的类图 + git_diff/worktree），纯计算吐出结构化 violations，供 fixer 消化，由 loop 驱动收敛——**全程不 spawn opencode**。

**理论边界必须如实呈现**（不夸大"形式化验证"）：

- 类不对应 = 有限图 / 集合 diff，**可判定、便宜、无 LLM**——这是把"形状"对"形状规约"做匹配，而类图本就是形状规约，名副其实。
- 功能不对应**一般不可判定**（Rice 定理：任何非平凡语义性质归约到停机）。只能验到"行为被形式化成契约 / 属性 / 测试"的程度，且那份 oracle 本身未经验证。

因此 **v1 只做结构层（类不对应）+ plan 覆盖率**；行为层（功能不对应）留后续独立 RFC。

## 目标

1. 新增**确定性非进程节点** `conformance-audit`：读 `diagramSource`（类图）+ `codeSource`（git_diff），输出 `violations` / `violations_summary` / `violations_count` 三个端口。
2. 结构一致性检查：缺 / 多 类、缺 / 多 方法 / 字段、继承（extends / implements）边错、依赖方向反、按声明 `layerOrder` 的分层越界、基数桶不符。
3. **plan 覆盖率**：每个规划类至少命中一个改动符号 / 文件，否则报 `plan-coverage-gap`（AI"悄悄漏实现"的最高价值信号）。
4. **复用 RFC-083** 的 `SymbolNode` / `SymbolEdge` 词汇 + web-tree-sitter 解析 + `graphDiff` 身份 / 重命名逻辑——**不另造一套 ClassIR**。
5. 接入 Code → Audit → Fix：`wrapper-loop` 的 `exit_condition = port-empty(violations)` 驱动单调收敛。
6. **建议式（advisory）**：节点恒 `status=done`，不硬卡门；收敛归 loop 拥有。
7. 类图本身不可靠时（LLM 生成 / 弱规约），把"规约太弱 / 解析失败"作为**一等输出**，而非假装通过。

## 非目标（v1）

- 方法签名 / 参数类型逐一深比（留 v2，依赖 RFC-083 深度解析保真度）。
- 功能不对应（契约 / 属性 / 差分 / 行为覆盖）——单列后续 RFC（行为层）。
- 跨文件深度依赖图 / 影响面（RFC-083 深度 / SCIP 模式才有）。
- 自实现 tree-sitter / AST：直接依赖 RFC-083 引擎（用户决策：保真度优先于"现在就上"）。
- 硬卡门 / 让 task 失败的语义。
- 非功能验收（性能 / 安全 / 并发）。

## 用户故事

- 作为编排者，我在 loop 里放一个 `conformance-audit` 节点；worker 改完代码后它确定性地列出"类图里有但代码没实现的类 / 方法""依赖方向反了""漏实现的规划项"，fixer 据此修，loop 自动收敛——没有任何 LLM 重读 diff。
- 作为编排者，当上游规划 agent 给的类图太糊（无类型 / 无基数），节点明确告诉我"规约太弱，无法验证 X"，而不是悄悄报绿。

## 验收标准

- 每个 violation code 都有正 / 负 fixture 测试通过。
- PlantUML 与等价 Mermaid 类图解析出**同一个** spec 图（方言不承重）。
- `serializeViolations` 规范排序、字节级确定性（loop 退出不抖）。
- 节点**不 spawn opencode**（源码守卫：执行器不出现 `OPENCODE_CONFIG_CONTENT`）。
- 端到端：`git-wrapper → conformance-audit → fixer` 包在 `wrapper-loop`，fixer 清空 violations 即退出，否则 `exhausted`。
- `bun run typecheck && bun run test && bun run format:check` 全绿 + 单二进制 smoke + CI。

## 决策记录（2026-06-05，用户定）

- **类图来源** = 上游 planning agent 的输出端口（非 input 节点 / 非 repo 文件）。
- **code-IR 精度** = 复用 RFC-083 web-tree-sitter（保真优先；**gated on RFC-083**）。
- **门 vs 建议** = 恒 `done`，交给 loop 收敛（建议式）。
- 落 RFC-084 三件套，等批准再编码。

## 开放问题（实现前在 design.md 定稿）

见 [design.md §7](./design.md)。核心两条：RFC-083 暴露 `parseFileToGraph` 的确切签名（code 图抽取 gated 于此）；类图方言 v1 是否 PlantUML + Mermaid 双解析。
