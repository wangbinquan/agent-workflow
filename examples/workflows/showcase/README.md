# Complex workflow showcase

这组文件用于导入真实 Agent Workflow 实例并创建可见任务，展示的不只是静态节点图：

- `complex-delivery-pipeline.yaml`：规格分析、Git 包装器、实现、并行审计/测试、文档汇总和人工评审。
- `parallel-file-audit.yaml`：按文件 fanout、广播审计策略、分片 join、单次 aggregator 聚合。
- `nested-loop-git-fix.yaml`：Loop → Git 嵌套包装器，以工作树差异作为循环退出条件，再做回归验证。
- `cross-agent-clarification.yaml`：设计者与质疑者协作，问题进入跨 Agent clarify 通道，回答后只重跑约定路径。
- `loop-human-review.yaml`：文档 Agent 产出显式 Markdown，Loop 包装器在人工评审处挂起，批准后退出。

先导入 [`../../agents/showcase-audit-aggregator.md`](../../agents/showcase-audit-aggregator.md)
并创建 Agent，再导入这五个 YAML。其余引用的 Agent 是默认展示资源：
`spec-analyst`、`impl-engineer`、`code-auditor`、`fix-engineer`、
`test-writer`、`doc-writer`。

这些定义使用生产 `$schema_version: 4` 格式；任务应通过工作流启动器创建，输入和仓库
由启动器校验。人工评审与反问工作流预期分别停在 `awaiting_review` 和
`awaiting_human`，用于继续演示拒绝/批准、回答与恢复。

## 端到端验证要点

- `promptTemplate` 中的变量名必须与目标节点的入边端口名一致；YAML 导入成功不代表任务启动校验一定通过。
- 文件输入的 `accept: '*.md'` 是启动器选择限制，不会把端口静态类型自动收窄成 `path<md>`；Review 应接 Agent 明确声明的 Markdown 输出。
- 包装器能力必须从实际任务验证：检查 fanout 分片数量与 join、Loop 轮次与退出条件、Git diff 边界，以及 `awaiting_review` / `awaiting_human` 的冒泡和恢复。
