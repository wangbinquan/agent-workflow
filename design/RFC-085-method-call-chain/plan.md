# RFC-085 — 任务分解

> 状态:Draft。**未经用户批准不进入实现**。编号 `RFC-085-Tn`。

## 依赖前提

- RFC-083 已 Done(符号集 / `collectClassMembers` / 深度 SCIP / `stripCommentsAndStrings` / 结构视图四视图)——本 RFC 全部建立其上。
- 不依赖 RFC-084(conformance-auditor),与之并行无冲突(各自只读 RFC-083 产物)。

## 阶段 1 —— 直接被调(MVP:点方法看它调了谁)

- **RFC-085-T1 — shared schema**:加 `callSiteSchema` + `StructuralDiff.callSites`(default `[]`)。测试:schema parse + 默认空 + 向后兼容(旧 JSON 不含字段仍 valid)。
- **RFC-085-T2 — 后端有序调用提取**(依赖 T1):`structuralDiff/callGraph.ts`(PURE `extractCallSites(method, tree, typeTable)` + 启发式目标解析)+ `gitBackend.augmentCallSites` 接入 computeFromWorktree/BetweenRefs;复用 RFC-083 parse 树(透传,避免二次 parse)+ `MAX_ANALYZE_BYTES` + 注释/字符串 strip。测试:§6 后端 PURE 用例 + 真实 git 仓 assemble 断言。
- **RFC-085-T3 — 前端直接被调视图**(依赖 T1;可与 T2 并行用 mock 数据):`lib/callChain.ts` 雏形(只取直接被调)+ `<CallChainView>` 缩进列表 + 结构树/关系图方法行的"看调用链"入口(`onJumpToCallChain`)。测试:纯函数 + 点击触发 + 渲染 smoke。

→ **PR-A**(T1+T2+T3):MVP「点方法 → 它直接调用的方法(可解析的精确连、不可解析的灰显)」。

## 阶段 2 —— 递归调用链

- **RFC-085-T4 — `buildCallChain` 递归 + 展开/环/截断**(依赖 T3):递归展开、`maxDepth`/`maxNodes`、环检测、`unresolved`/`external` 作叶子;视图加逐层 `▸` 展开。测试:递归、环检测、截断、叶子化(§6)。

→ **PR-B**(T4):多层调用链可展开。

## 阶段 3 —— 时序图

- **RFC-085-T5 — 时序图数据预言**(依赖 T4,PURE):调用链 → 有序消息流(lifeline 去重 + 消息顺序 + depth/激活)。测试:PURE 顺序/去重断言。
- **RFC-085-T6 — 时序图渲染**(依赖 T5):按 design §3.3 选 mermaid(方案 A)或自绘 SVG(方案 B)——**实现前用 ExitPlanMode/询问定渲染方案**;`<SequenceDiagram>`。测试:渲染 smoke(lifeline 数 + 消息数)+ 视觉对齐自查(与 /agents 等核心页 side-by-side)。若引 mermaid:`build:binary` smoke 确认前端依赖不破单二进制构建。

→ **PR-C**(T5+T6):时序图视图。

## PR 拆分建议

| PR | 含 | 交付 |
| --- | --- | --- |
| PR-A | T1+T2+T3 | 点方法看直接被调(精确+未解析) |
| PR-B | T4 | 递归调用链展开 |
| PR-C | T5+T6 | 时序图 |

每个 PR commit 前缀 `feat(scope): RFC-085 ...`;均需全绿门槛(typecheck/test/format,动 shared/后端加 build:binary)。

## 验收清单

- [ ] T1 schema:`callSites` 可选、默认空、旧响应向后兼容。
- [ ] T2:`this.foo`/`foo`/`field.foo`(类型在 diff)→ `resolved`;类型在 diff 外 → `external`;链式/无法定位 → `unresolved`;`order` = 源码顺序;注释/字符串调用被排除。
- [ ] T2:真实 git 仓(Java + TS)fixture 端到端断言一条已知调用链。
- [ ] T3:点结构树/关系图方法行 → 弹出直接被调列表;`unresolved` 灰显;旧 diff 入口禁用 + 空态。
- [ ] T4:递归 ≥3 层;环检测不死循环;`maxDepth`/`maxNodes` 截断标注。
- [ ] T5:调用链 → 有序消息流,lifeline 去重、消息按序。
- [ ] T6:时序图渲染 smoke;渲染方案经用户确认;若引依赖,单二进制 smoke 通过。
- [ ] 深度 SCIP 不可用自动回退启发式,视图不崩、标"基线精度"。
- [ ] 全程门槛全绿;CI 三项 + e2e 绿。

## 风险 & 缓解

| 风险 | 缓解 |
| --- | --- |
| 调用图覆盖低(当前 Java SCIP 回退,impact 稀) | 阶段 1 用 tree-sitter 启发式自给自足,不只靠 SCIP;精度边界显式标注 |
| 接收者类型解析弱(动态/链式) | 分 `resolved`/`external`/`unresolved` 三档,宁缺毋滥,绝不臆造 |
| 时序图渲染复杂/引依赖 | 数据与渲染解耦(T5 出数据、T6 出渲染);mermaid vs 自绘待拍板;依赖过单二进制 smoke |
| 二次 parse 性能 | 复用 RFC-083 既有 parse 树,不重复 parse |
