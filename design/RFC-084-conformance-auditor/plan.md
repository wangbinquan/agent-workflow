# RFC-084 — 任务分解与 PR 拆分

> 产品视角见 [proposal.md](./proposal.md)，技术契约见 [design.md](./design.md)。

## 依赖前置（gated on RFC-083）

- **T6（code 图抽取）硬依赖 RFC-083** 基线 `web-tree-sitter` 解析落地并暴露 `parseFileToGraph`（design §0 / OQ-1）。
- **T1（共享契约）依赖 RFC-083 `structuralDiff.ts` 的 `SymbolNode/SymbolEdge`**；若 RFC-083 尚未合并，先 vendor 最小类型别名，RFC-083 落地后切到其导出（避免重复定义）。
- **不依赖 tree-sitter 的任务可先行**：类图解析、`diffConformance`（over symbol 图）、`planCoverage`、Violation schema、节点 / 调度 / 校验 / 前端。
- 理想顺序：RFC-083 先合并其 schema PR + 基线解析 → 再开 RFC-084 PR-C 的 T6；RFC-084 其余任务可并行起步。

## PR 拆分（强序）

- **PR-A** 共享契约：NodeKind + `ConformanceAuditNodeSchema` + `Violation`/`ConformanceConfig` schema + behavior 行 + version 4→5 + schema lock 测试。必先 CI 绿。
- **PR-B** 纯库：`classDiagramParser` + `diffConformance` + `planCoverage` + `serializeViolations` + oracle/property 测试（测试随码落，不补后续）。
- **PR-C** 后端接线：`dispatchConformanceAuditNode` + scheduler 两处 + validator + version 5 迁移 + 执行器测试；含 T6 code 图抽取（**gated on RFC-083**，其前用接口占位 / 适配）。
- **PR-D** 前端：画布节点 + palette + Inspector（复用公共原语）+ i18n + 前端测试。
- **PR-E** 集成 + 文档：端到端 loop fixture + STATE.md / plan.md 收尾。

## 子任务

### PR-A — 共享契约
- **RFC-084-T1**：`shared/schemas/workflow.ts` 加 `'conformance-audit'` 到 `NODE_KIND`、`WORKFLOW_SCHEMA_VERSION` 4→5、`ConformanceAuditNodeSchema`（`.passthrough()`）；`node-kind-behavior.ts` 补非进程行；`shared/schemas/conformance.ts` 落 `ConformanceConfig`/`Violation` zod；`shared/src/index.ts` 导出 schema（不导 service）。**测试**：schema lock（仿 `wrapper-fanout-schema.test.ts`）。依赖：无*（*概念上依赖 RFC-083 `SymbolNode/SymbolEdge`，未合并先 vendor 最小别名）。

### PR-B — 纯库 + oracle 测试
- **RFC-084-T2**：`shared/conformance/` 纯库——`parseClassDiagram`（PlantUML + Mermaid 子集，行状态机，零依赖）、`diffConformance`（spec∖code=missing / code∖spec=extra / 继承边 / 依赖方向 / `layerOrder` 分层 / 基数桶，复用 RFC-083 `graphDiff` 身份元组 + 重命名 sem）、`planCoverage`、`serializeViolations`（规范排序）。依赖：T1。
- **RFC-084-T3**：纯函数 oracle + property 测试——每 violation code 一正一负 fixture；PlantUML≡Mermaid 解析等价；`serializeViolations` 字节确定性；fast-check superset-conformance 不变量。依赖：T2。**（与 T2 同 PR，测试是改动一部分。）**

### PR-C — 后端接线
- **RFC-084-T4**：`backend/services/conformanceAudit.ts` 的 `dispatchConformanceAuditNode`；接进 `scheduler.ts` `runOneNode` 派发链 **及** `:268-281` 第二 allowlist 守卫；mint node_run `done` + 写 `violations`/`_summary`/`_count` + broadcast。**测试**：注入 fake-db 执行器测试 + 源码守卫（无 `OPENCODE_CONFIG_CONTENT`）。依赖：T1、T2。
- **RFC-084-T5**：`workflow.validator.ts` 加 conformance-audit 校验分支（`diagramSource`/`codeSource` 可解析、code 源为 list<path> 形）；`workflow.ts` version 5 迁移。**测试**：validator 正负用例。依赖：T1。
- **RFC-084-T6**：code 图抽取——调用 RFC-083 `parseFileToGraph` 把改动文件 → codeGraph，接进执行器；坏文件 per-file 隔离 + degraded 标注。**测试**：小型多文件 fixture → 期望 codeGraph。依赖：T4、**RFC-083 基线解析**。

### PR-D — 前端
- **RFC-084-T7**：`canvas/nodes/ConformanceAuditNode.tsx`（仿 AgentNode/ReviewNode：kind pill + 两入 handle〔diagram/code〕+ violations 出 handle）；注册 `WorkflowCanvas.tsx` `NODE_TYPES` + `toFlowNodes` 投影；`nodePalette.ts` 加 PaletteItem/deserialize/SHORT 前缀/makeNode/buildPalette 项。依赖：T1。
- **RFC-084-T8**：`NodeInspector.tsx` 加 `case 'conformance-audit'` EditForm——**仅复用** `Field`/`Select`/`Switch`/`ChipsInput`/`TextInput`（diagram/code 源选择器仿 review inputSource；每检查项 `Switch`；`layerOrder` 用 `ChipsInput`；端口名 `TextInput`）；en-US/zh-CN i18n key。**测试**：前端 spec（渲染 + 提交走 `onCommitDef`）。依赖：T7。

### PR-E — 集成 + 文档
- **RFC-084-T9**：端到端 loop fixture（`git-wrapper → conformance-audit → fixer` 包 `wrapper-loop`，`exit_condition=port-empty(violations)`）；STATE.md「进行中 RFC」改 Done + 已完成清单加行 + plan.md RFC 索引 Draft→Done。push 后查 CI（双 OS typecheck/test/format + 单二进制 smoke + Playwright e2e）全绿。依赖：T4、T5、T6、T8。

## 依赖图

```
T1 → T2 → T3
T1 → T5
T1,T2 → T4 → T6 (+RFC-083 基线)
T1 → T7 → T8
T4,T5,T6,T8 → T9
```

## 验收清单

- [ ] 每个 violation code 正负 fixture 测试绿。
- [ ] PlantUML≡Mermaid 解析等价测试绿。
- [ ] `serializeViolations` 字节确定性测试绿。
- [ ] fast-check superset-conformance 不变量测试绿。
- [ ] schema lock 测试绿（VERSION===5、kind 含、isProcessNodeKind false、migrate 级联）。
- [ ] 执行器测试绿（done + 三端口 + broadcast + 坏类图仍 done）。
- [ ] 源码守卫绿（执行器无 `OPENCODE_CONFIG_CONTENT`）。
- [ ] 端到端 loop fixture 退出 / exhausted 行为正确。
- [ ] `typecheck && test && format:check` + 单二进制 smoke + CI 全绿。

## 备注

- **行为层（FUNC-mismatch：契约 / 属性 / 差分 / 行为覆盖）单列后续 RFC**，不在本 RFC 范围。
- 与 RFC-083 的协调是本 RFC 的最大外部风险：若 RFC-083 迟迟不落地，PR-A/B/D 仍可独立交付（用 vendor 类型别名 + 接口占位），但 T6 与端到端 PR-E 必须等 RFC-083 基线解析可复用。
- 遵守前台统一原则：Inspector 一律走公共原语，禁原生 HTML / 自写 chrome（违反即 code review 打回）。
