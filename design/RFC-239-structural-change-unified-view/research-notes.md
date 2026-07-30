# RFC-239 调研笔记(2026-07-30)

> 本文件是 proposal §1 的展开:当前实现盘点 + 业界调研全文摘要。结论性内容已收敛进 proposal/design,本文供追溯。

## 一、当前实现盘点(as-built)

### 数据层(丰富,基本不动)

- `packages/shared/src/schemas/structuralDiff.ts`:`SymbolNode`(kind/qualifiedName/signature/bodyHash/range/parentId/visibility/heritage/anonymous)、`SymbolChange`(changeType/before/after/signatureChanged/bodyChanged/bodyDelta/renamedFrom/hunkAnchor)、`ClassEdge`(inherits/references + fromMembers/toMembers)、`ImpactItem`、`DependencyChange`、`summary`(6 桶四元计数)。
- 后端 `services/structuralDiff/`:baseline(tree-sitter 8 语言)、assemble、gitBackend(变更枚举 + 跨文件 impact + classEdges)、refSelect(node 粒度配对)、store(终态任务落盘 `structural-diffs/{taskId}/task.json`)、deep/(SCIP 只升级 impact 置信)、callGraph/(懒加载调用链)。
- 已知数据缺口:`FileStructuralDiff.edges` 恒空;变更文件枚举无 rename 检测(重命名 → 全新增);`SymbolChange.detail?`(AI hook)从未落 schema。

### 呈现层(本 RFC 重做对象)

- 宿主 `routes/tasks.detail.tsx`:`worktree-diff`(RFC-021 `WorktreeDiffPanel`:文件夹树 + 已看进度 + unified diff)与 `worktree-structure`(RFC-083 `StructuralDiffView`)两个平行子页签;互跳单向(结构 → 文本,只传 filePath 丢行号);多仓锁死 task 粒度。
- `StructuralDiffView`:小 pill 摘要行 + 风险导览卡(walkthrough,只取 breaking/risky)+ 5 选 1 视图(树/关系图/影响面/依赖/调用链)。树 = 280px 文件列表(无计数)+ 单文件符号平铺(容器分组字典序、import 一等公民、每行 explain 句)。图 = xyflow 包级/类级,只读,点击高亮;类级 28 类即不可读。影响面 = 纯文本 `A ← B` 列表不可点。
- 实测(本机):snake 任务 18 文件/28 类/213 方法全 added → 风险体系整体失效、解释同义反复、import 噪音置顶;explorer scratch 重构任务 → 空态无解释。

### RFC 系列已明确 deferred 的项(本 RFC 部分兑现)

- RFC-083 OQ-4:图默认收窄是设计纪律;升级路径 Cytoscape/Mermaid 导出(未做,本 RFC 亦不做)。
- RFC-088 非目标:跨文件破坏性与 impact 合流、AI 摘要(本 RFC 以 AI 导读部分兑现)。
- RFC-089 遗留:文件树按仓标签(本 RFC 左栏按仓分组兑现)。
- STATE.md 记录:重命名显示为全新增(本 RFC G8 修复)。

## 二、业界调研全文(设计原则来源)

> 调研对象:GitHub 新版 Files Changed(2025-06 预览 → 2026-01 默认)、SemanticDiff、difftastic(作者博文)、CodeRabbit(Walkthrough/Overview/Atlas「change cohorts」)、Greptile(按变更性质自动选图型 + P0-P2 徽标)、CodeSee Review Maps(2024-02 停运)、AppMap(sequence-diagram-diff)、JetBrains/VS Code(collapse-unchanged、sticky scroll、移动检测连线)、Sourcegraph(hover 注智)、CodeScene(hotspot/X-Ray/change coupling/伴生缺失预警)、Google Critique/Gerrit(attention set、Tricorder 反馈闭环、patchset 间 diff)、GumTree(AST diff 编辑脚本)、变更解缠(ClusterChanges→UTANGO→ColaUntangle)、Collector-Sahab/ChangePrism(运行时增强与「总览+下钻」双层)。

**8 条收敛原则**(→ 标注本 RFC 落点):

1. **P1 叙事先行**:首屏 = 总结 + 分组表 + 阅读顺序,面板堆叠不产生直观(CodeRabbit/Greptile/Critique)。→ 左栏分组总览 + AI 导读。
2. **P2 意图/模块分组**:重组为 3–7 组,机械变更整组折叠;agent 平台的节点意图是天然分组输入(变更解缠学术线)。→ 静态分组模型(v1 按模块/性质;节点意图作为 AI 导读输入)。
3. **P3 先降噪,可见地隐藏**(SemanticDiff「invariance 过滤 + 计数展开」、difftastic 优雅降级)。→ import/搬移聚合 + 空态诊断化。
4. **P4 结构锚点内嵌 diff,而非平行页签**(VS Code sticky scroll、JetBrains 方法级历史、Sourcegraph hover)。→ 页签合并 + sticky 符号锚点 + 双向互跳。
5. **P5 图必须 gated、可回跳**(CodeSee 停运教训;CodeRabbit「图要赚到位置」;Greptile 按需选图型)。→ 图/影响面/调用链/依赖降为下钻,影响面可点击。
6. **P6 风险要有证据与反馈闭环**(CodeScene 证据链、Critique Tricorder 有用/没用按钮)。→ v1 仅部分:severity 保留 + 影响面可跳;历史耦合证据列为非目标。
7. **P7 注意力与进度是呈现的一部分**(GitHub Viewed、Critique attention set、CodeSee 勾选折叠)。→ 已看体系保留并上卷到组/总进度。
8. **P8 多轮评审 delta 的 delta**(Gerrit patchset)。→ 非目标,后续 RFC;「范围=各节点」部分覆盖。

**反例教训**:CodeSee(常驻依赖图,2024-02 停运)——图信息密度在中小变更过低、大变更糊成毛线团;AppMap(运行时 diff,接入摩擦大转向)——价值真、门槛高。两者共同指向:图与重型分析必须按需、且从属于 diff 主线。
