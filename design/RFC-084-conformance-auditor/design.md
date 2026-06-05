# RFC-084 — 技术设计：确定性结构一致性审计节点

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
> 行号引用以撰写时（commit `5e33550` 附近）为准，实现期以源码实际为准。

## 0. 依赖与定位（gated on RFC-083）

- **硬依赖 RFC-083**：复用其 `packages/shared/src/schemas/structuralDiff.ts` 的 `SymbolNode` / `SymbolEdge` / `SymbolKind` 词汇与 `graphDiff` 纯函数，以及基线 `web-tree-sitter` per-file 解析。RFC-083 现 Draft、等批准；**RFC-084 实现排在其后**——至少其 PR-A（schema 合并）与基线 per-file 解析可复用时才能动 code 图抽取。
- RFC-083 内部 `graphDiff(oldGraph, newGraph)` 已有"把单状态源码解析成图"的路径。RFC-084 需要它把**单状态解析**导出为可复用原语：`parseFileToGraph(filePath, text, langId) → { nodes: SymbolNode[], edges: SymbolEdge[] }`。此原语在 **backend**（RFC-083 §3 `services/structuralDiff/lang`，WASM 解析），RFC-084 执行器同在 backend，import 干净；但它**尚未落地**（见下）。这是跨 RFC 协调项（OQ-1）。
- **落地现状（撰写时，工作树已有 RFC-083 并行实现的未追踪改动）**：`packages/shared/src/schemas/structuralDiff.ts`（`SymbolNode`/`SymbolEdge`/`SymbolKind`/`EdgeKind`/`StructuralDiff` 的 zod + 类型，已经过 `index.ts` barrel 导出）与 `packages/shared/src/structuralDiffGraph.ts`（set-diff）**已在树中**——共享 schema 可**立即复用**。但**基线 tree-sitter per-file 解析仍未落地**（无 `packages/backend/grammars/`、backend 无 `web-tree-sitter` 引用）。故 gate 收窄为：仅 code 图抽取（T6）等 RFC-083 后端解析；其余照 schema 先行。
- **不依赖 tree-sitter 的部分可先行**：类图 → spec 图解析、conformance-diff oracle、Violation schema、节点 / 调度 / 校验 / 前端。只有 code 图抽取（T6）卡 gate；其前用接口占位 / 适配。

## 1. 节点模型与派发（确定性非进程节点）

- `conformance-audit` 加入 `NODE_KIND`（`workflow.ts:30`）；`isProcessNodeKind` 返回 **false**（`:60`）；`NODE_KIND_BEHAVIORS` 补**非进程五元组** `{ retryCascade:'skip', limits:'opt-out', orphanReap:'leave-alone', gc:'gc-with-task', shutdown:'no-op' }`（`node-kind-behavior.ts`，`satisfies Record<NodeKind,_>` 不补则编译失败）。
- 调度**两处**（均已核验）：
  1. `runOneNode` 派发链（`scheduler.ts:1253` 的 `input` 分支后）加 `if (node.kind === 'conformance-audit') return dispatchConformanceAuditNode(state, args)`。
  2. **独立第二道 allowlist 守卫**（`scheduler.ts:268-281`，非派生自 behavior 表）同步加 `&& node.kind !== 'conformance-audit'`——否则任务被 fail "scheduler does not yet support conformance-audit nodes"。
- 执行器 `dispatchConformanceAuditNode`（新文件 `packages/backend/src/services/conformanceAudit.ts`）：`readPortAtIteration`（scheduler helper，`:3415`）取 diagram + code → 解析 → diff → `insertNodeRun(db, taskId, node.id, 'done', 0, iteration)` → 写 3 个 `nodeRunOutputs` 行 → `broadcastNodeStatus` → `return { kind:'ok' }`。结构**完全仿 output 节点**（`scheduler.ts:1110-1132`）：无子进程、无 `OPENCODE_CONFIG_CONTENT`、无 envelope。
- `WORKFLOW_SCHEMA_VERSION` 4 → 5（`workflow.ts:24`）+ `migrateDefinitionToLatest` 追加 v4 → v5 纯元数据 if-块（旧文档不带新 kind）。

## 2. 共享数据模型（复用 RFC-083 + 新增 Violation）

spec 图与 code 图**统一**用 RFC-083 的 `SymbolNode` / `SymbolEdge`（`kind`: class / interface / method / field / …；`EdgeKind`: `contains` / `calls` / `imports` / `inherits` / `implements` / `references`），保证比对 apples-to-apples。注意（按已落地的 `structuralDiff.ts`）：
- 方法 / 字段是**带 `parentId` 的 `SymbolNode`**（指向其类），不是边——"缺方法"= 一个 `kind=method`、`parentId=类` 的节点在 spec 有、code 无。
- `SymbolNode.id = ${filePath}#${qualifiedName}:${kind}` **含 filePath**；spec 侧（来自类图）无真实路径，故 spec↔code **匹配按 `(kind, qualifiedName)`，绝不按 `id`**。
- 依赖方向用 `calls`/`imports`/`references` 边；继承 / 实现用 `inherits`/`implements` 边。

新增 `packages/shared/src/schemas/conformance.ts`（zod）：

```ts
ConformanceConfig {
  diagramSource: PortRef          // 上游 planning agent 的输出端口
  codeSource: PortRef             // git-wrapper 的 git_diff (list<path>)
  layerOrder?: string[]           // 声明的分层顺序，用于 layering-breach
  checks?: { classes, methods, fields, inheritance, dependencyDirection,
             layering, cardinality, planCoverage: boolean }   // 默认全开
  violationsPort?: string         // 默认 'violations'
  summaryPort?: string            // 默认 'violations_summary'
  countPort?: string              // 默认 'violations_count'
}

Violation {
  category: 'CLASS-mismatch' | 'FUNC-mismatch' | 'SPEC-quality'
  code: 'missing-class' | 'extra-class' | 'missing-method' | 'extra-method'
      | 'missing-field' | 'wrong-inheritance' | 'wrong-dependency-direction'
      | 'layering-breach' | 'cardinality-mismatch' | 'plan-coverage-gap'
      | 'spec-unparseable' | 'spec-underspecified'
  severity: 'error' | 'warning' | 'info'
  subject: string                 // 受影响符号的 qualifiedName
  detail: string
  location?: string               // file:line（来自 code 图 SymbolNode.range）
  planRef?: string                // 关联的类图元素，便于追溯
}
```

纯库 `packages/shared/src/conformance/`（**零新依赖**——`shared` 现仅 yaml + zod；类图解析手写）：

- `classDiagramParser.ts`：`parseClassDiagram(text) → { nodes, edges }`。PlantUML + Mermaid `classDiagram` 子集，行状态机；关系 glyph 确定性映射（`<|--` 泛化 / `..|>` 实现 / `*--` 组合 / `o--` 聚合 / `-->` 有向依赖 / `"1"` `"0..*"` 基数）。产出 RFC-083 词汇的 spec 图。
- `conformanceDiff.ts`：`diffConformance(specGraph, codeGraph, opts) → Violation[]`。复用 RFC-083 `graphDiff` 的身份元组 **`(kind, qualifiedName, signature)`**（`SymbolNode.signature`）+ `bodyHash` 改名 sem，但语义是 **spec ∖ code = missing**、**code ∖ spec = extra（仅在映射范围内）**、边比对（`inherits`/`implements` 继承、`calls`/`imports`/`references` 依赖方向）、`layerOrder` 分层、基数桶。签名缺省（类图常不写参数类型）时降级为名字级匹配 + `spec-underspecified`，不报假 `signature` 不符。
- `planCoverage.ts`：`planCoverage(specGraph, touchedSymbols | paths) → Violation[]`。
- `violations.ts`：`serializeViolations(v[]) → { json, summary, count }`，**规范排序**（按 `(severity, code, subject)`）保证字节确定性。
- 仅 schema + 纯库导出到 `packages/shared/src/index.ts`；**不导出任何 service**（RFC-079 barrel 初始化环教训）。

## 3. 数据流

1. **diagram**：`diagramSource` 指向上游 planning agent 的输出端口（markdown 文本，含 PlantUML/Mermaid）。`readPortAtIteration` 取文本 → `parseClassDiagram` → specGraph。解析失败 → 单条 `spec-unparseable`（severity warning），节点**仍 done**。
2. **code**：`codeSource` 指向 git-wrapper 的 `git_diff`（list<path>，换行分隔）。取改动文件路径 → 从 `task.worktreePath` 读文件文本 → RFC-083 `parseFileToGraph` → codeGraph（仅改动文件；跨文件类型 best-effort，按 RFC-083 `Confidence` 标注）。
3. **diff**：`diffConformance(specGraph, codeGraph)` + `planCoverage` → `Violation[]` → `serializeViolations` → 写三端口：`violations`（JSON；**空集 = 空串**以配合 `port-empty`）、`violations_summary`（markdown，fixer 经 edge 当 prompt 输入消费）、`violations_count`（整数文本）。
4. **收敛**：节点**跨迭代无状态**（每轮 `readPortAtIteration` 取最新 worktree run）。fixer 减少违规 → auditor 报得更少 → `violations` 空 → loop 退出；否则到 `max_iterations` → `exhausted`。因 `retryCascade:'skip'`，上游重试不会 mint 陈旧占位审计行。

```
wrapper-loop {
  wrapper-git { worker(agent-single) } ──git_diff──┐
  planning-agent ──class_diagram──┐                │
                                  ▼                ▼
                       conformance-audit (确定性、无 LLM)
                                  │ violations / _summary / _count
                                  ▼
                       fixer(agent-single) 编辑 worktree
}
exit_condition = port-empty(violations)
```

## 4. 与现有模块耦合点（清单）

`shared/schemas/workflow.ts`（NODE_KIND / version / ConformanceAuditNodeSchema）· `shared/node-kind-behavior.ts`（行）· `shared/schemas/conformance.ts`（新）· `shared/conformance/*`（新纯库）· `shared/src/index.ts`（barrel，仅 schema+纯库）· **RFC-083 `structuralDiff.ts` + `parseFileToGraph`（依赖）** · `backend/services/conformanceAudit.ts`（新）· `backend/services/scheduler.ts`（派发 + 第二守卫 + `readPortAtIteration`）· `backend/services/workflow.validator.ts`（校验两源）· `backend/services/workflow.ts`（version 5 迁移）· `frontend canvas/WorkflowCanvas.tsx`（NODE_TYPES / toFlowNodes）· `nodePalette.ts` · `NodeInspector.tsx`（复用 Field/Select/Switch/ChipsInput/TextInput）· `canvas/nodes/types.ts` · `i18n/zh-CN.ts` + `en-US.ts`。

## 5. 失败模式与防护（逐条有测试）

| 模式 | 防护 |
|---|---|
| 类图解析失败 | `spec-unparseable`，节点 done（不抛、不卡门） |
| 类图弱（无类型 / 无基数） | 对应检查降级为 `spec-underspecified` info，**不误报** missing |
| 改动文件 tree-sitter 解析错 | 该文件跳过 + 记 degraded，不牵连整体（沿用 RFC-083 per-file 隔离） |
| 合法重命名 | 经 `graphDiff` 重命名 sem 降级为低优先（或 name-map），不报 missing+extra |
| code 比 spec 更对 / spec 陈旧 | extra / divergence 默认 warning **不卡门**；v1 策略：advisory，由人 / loop 裁决 |
| 二进制 / 超大文件 | 跳过 + note |
| 空 diff | 直接 done，violations 空串 |

## 6. 测试策略（test-with-every-change，纯函数优先）

- **oracle 测试**：每个 violation code 一正一负 fixture（`packages/shared/tests/conformance/` + `fixtures/conformance/`）。模式仿既有 `affectsDefinition` / `parseAgentMarkdown` oracle 测试。
- **方言等价**：PlantUML fixture 与等价 Mermaid fixture 解析出 canonical-equal 的 spec 图。
- **确定性**：`serializeViolations` 同一集合任意插入序 → 字节一致 JSON（锁住 loop 退出不抖）。
- **property（fast-check，backend 已有 devDep）**：随机 spec/code 图对，`diffConformance` 为空 **iff** code 在映射范围内是 spec 的合规超集（loop 单调收敛所依赖的不变量）。
- **schema lock**（仿 `packages/shared/tests/wrapper-fanout-schema.test.ts`）：`NODE_KIND` 含 `conformance-audit`、`isProcessNodeKind===false`、behavior 行为非进程元组、`WORKFLOW_SCHEMA_VERSION===5`、`migrateDefinitionToLatest` v1..v5 级联、`ConformanceAuditNodeSchema` 解析最小节点。
- **执行器测试**（注入 fake-db，仿 `mcpProbe.test.ts`）：node_run 以 `done` mint、三端口写入 `nodeRunOutputs`、`broadcastNodeStatus` 被调、`{kind:'ok'}`；失败用例（坏类图 → `spec-unparseable` 仍 done，永不抛）。
- **源码守卫**（运行时组件难驱动时的最低兜底）：断言 `dispatchConformanceAuditNode` 不出现 `OPENCODE_CONFIG_CONTENT`——锁死"确定性节点"不变量。
- **集成**：workflow fixture 接 `git-wrapper.git_diff → conformance-audit.codeSource`、`planning.class_diagram → diagramSource`、`exit_condition=port-empty(violations)`；断言 fixer 清空 violations 即退出、否则 exhausted。

## 7. 开放问题定稿

- **OQ-1**：RFC-083 暴露 `parseFileToGraph` 的确切签名（backend `services/structuralDiff/lang`，WASM）——该后端解析撰写时**尚未落地**（共享 schema + set-diff 已落），code 图抽取 gated 于此；实现期与 RFC-083 协调把"单状态解析"导出为可复用点。
- **OQ-2**：类图方言 v1 = PlantUML + Mermaid 双解析（确认双支持，还是先一个）。
- **OQ-3**：`layerOrder` 来源 = 节点配置显式 `string[]`（v1 提案）vs 从类图包 / 命名空间分组推断。
- **OQ-4**：`violations` 空集 = 空串（配 `port-empty`）还是 `'[]'`——v1 定**空串**，fixer / exit_condition 一致。
- **OQ-5**：大 diff 是否经 `wrapper-fanout` 按文件分片——v1 **不分**，整体跑一次（推荐 MVP）。
- **OQ-6**：`diagramSource` 端口 kind 约束（markdown vs 专用 `class_diagram` kind）——v1 接受 markdown 文本。
