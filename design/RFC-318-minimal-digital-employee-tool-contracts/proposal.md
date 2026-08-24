# RFC-318：直观、原子的数字员工研发节点

- 状态：已批准，实施候选验证中（2026-08-24）
- 开工基线：`main@9a6961727b8dd5a946310f34d0f378ab0b57ab13`
- 范围：研发数字员工九个业务节点、八个 v2 内置 Agent、节点卡片与合同说明
- 不在范围：runner、`startTask` 及其下层、网络、凭据、Program env、retry、Git 执行、权限、安全或沙箱机制

## 目标

使用者看到节点时，不需要理解平台内部 envelope，也能立即回答：

1. 这个节点做什么；
2. 本次要输入什么；
3. 完成后会留下什么；
4. 哪些内容才需要配置。

原则只有三条：

- 一个节点只做一个业务动作；
- tool 只收到自己会消费的业务字段，只返回自己负责的业务结果；
- 平台身份、调度、Context、workspace 量测和外部发布状态继续由现有平台机制负责。

## 九个节点

| 节点           | Contract                                   | 输入                                       | 可观察输出                               |
| -------------- | ------------------------------------------ | ------------------------------------------ | ---------------------------------------- |
| 准备外部材料   | `development.prepare-materials@2`          | 连接、外部事项编号、材料输出目录           | 指定目录内的材料文件                     |
| 编写实现方案   | `development.plan-implementation@2`        | 需求材料目录、方案文件路径                 | 指定 Markdown 方案文件                   |
| 实现变更       | `development.implement-change@2`           | 需求材料目录、已批准方案（可选）           | 代码修改、提交信息、MR 标题、MR 描述     |
| 处理检视意见   | `development.resolve-review-feedback@2`    | 需求材料目录、完整检视线程                 | 逐线程回复；需要时包含代码修改和提交信息 |
| 采集流水线状态 | `development.collect-pipeline-status@2`    | 连接、MR、证据目录                         | 已观察版本、总状态、检查项、证据文件     |
| 分类流水线失败 | `development.classify-pipeline-failures@2` | 失败检查、问题类型、兜底分类               | 每个失败检查所属的问题分组               |
| 修复流水线失败 | `development.repair-pipeline-failures@2`   | 一个失败类型、该类型的全部问题             | 代码修改、提交信息                       |
| 解决合并冲突   | `development.resolve-merge-conflicts@2`    | 源版本、目标版本、冲突文件、需求材料目录   | 已解决的冲突文件、提交信息               |
| 编写审批草稿   | `development.draft-approval@2`             | MR、当前版本、审批类型、门禁结论、格式说明 | 审批草稿                                 |

内部 work item 拓扑保持不变；`development@9` 把现有九个业务位置绑定到以上九个 v2 contract。

## Tool 边界上的 wire

八个 JSON 节点直接接收业务对象，不再接收通用 envelope。例如：

```json
{
  "requirementsDirectory": ".agent-workflow/inputs/requirements/CASE",
  "approvedPlanFile": ".agent-workflow/inputs/requirements/CASE/review/implementation-plan.md"
}
```

成功结果直接返回本节点结果：

```json
{
  "outcome": "completed",
  "commitMessage": "...",
  "mergeRequestTitle": "...",
  "mergeRequestDescription": "..."
}
```

无法完成时只有：

```json
{ "outcome": "blocked", "explanation": "..." }
```

准备材料成功只需 `{"outcome":"completed"}`。编写实现方案沿用现有 `analysis-plan: path<md>`，直接返回输入给定的同一路径。

tool I/O 中没有 `schemaVersion`、`roundRef`、`executionNonce`、Context patch、effect、artifact receipt、route、handler、next step 或外部写入状态。未知字段由各 contract 的 strict schema 拒绝。

平台内部仍保留现有 frozen host envelope。启动前 projector 从中取出本节点需要的业务字段；直接结果通过 exact contract 校验后，平台在内部补回 round identity，以复用既有 settlement。这个内部包装不发送给 tool，也不出现在节点卡片。

## 职责边界

- 工具可以使用现有网络、仓库、Git 和代码托管读取能力完成动作；没有零网络模式。
- 节点不替平台发布 commit、push、merge、评论或审批。
- “不负责外部发布”是职责说明，不是新沙箱、安全规则或执行拦截器。
- Program、Workflow、Agent 和 script 的现有入口、环境、网络及 retry 保持不变。
- 检视意见可以只回复、不改代码；只有真实改代码时才返回 `commitMessage`。
- 采集流水线的目标版本只有提供方确认时才返回。
- 分类工具只定义问题类型和兜底分类；处理者、去向与顺序由岗位流程配置。

## 配置

只有“分类流水线失败”增加业务配置界面：

- 类型标识；
- 名称；
- 说明；
- 兜底分类。

存储继续使用现有工具发布结构；启动时投影成直观的 `categories + fallbackType`。分类项的排列不代表修复优先级。其余八个节点不显示空配置区。

合同详情和 JSON 示例放在“协议与示例”折叠区；默认卡片只展示动作、输入、输出和可用实现。

详细合同字段只在 `business-tool` 节点展示。平台、系统与协作节点只展示自身 WorkItem contract 的真实输入和输出；没有节点自有参数时不渲染参数区，不得用通用 execution-contract fallback 填充“关键业务参数”。

## 八个 v2 内置 Agent

| 展示名         | 单一 Contract                              | 说明                                  |
| -------------- | ------------------------------------------ | ------------------------------------- |
| 通用代码实现   | `development.implement-change@2`           | 未分类实现，intent=`unspecified`      |
| 流水线失败分类 | `development.classify-pipeline-failures@2` | 只分类，不选择处理者或顺序            |
| 流水线失败修复 | `development.repair-pipeline-failures@2`   | 只修复本次分配的失败类型              |
| 检视意见处理   | `development.resolve-review-feedback@2`    | 逐线程回复，需要时改代码              |
| 合并冲突处理   | `development.resolve-merge-conflicts@2`    | 只解决列出的冲突文件                  |
| 业务需求实现   | `development.implement-change@2`           | 业务需求实现，intent=`feature`        |
| 缺陷修复       | `development.implement-change@2`           | 根因明确后的最小修复，intent=`defect` |
| 编写实现方案   | `development.plan-implementation@2`        | 只写指定方案文件                      |

v2 使用新稳定 ID，平台内置定义 create-or-converge；非平台资源占用稳定 ID 时仍拒绝。v1 Agent 和既有 Case 不原地改写。persona 只描述动作和业务边界，不复制 wire、round、nonce、Context 或分类表。

## 验收

- 九张节点卡片的名称、动作、输入和输出与本 RFC 一致。
- 平台、系统和协作节点不渲染业务工具 guide；其可见输入输出逐节点唯一并与自身 WorkItem contract 一致。
- 八个 JSON contract 只接受自己的 direct completed/blocked 结果；plan 只接受指定路径。
- 每个输入字段有明确 consumer；平台字段不回流 tool I/O。
- 八个 v2 built-in 都只有一个 contract；三个实现 intent 互斥。
- 所有节点保留现有网络；没有新增沙箱或安全防护。
- runner、`startTask` 及其下层没有 RFC-318 变更。
- 定向合同、UI、全链测试和唯一一次 `bun run gate:local` 通过后发布；发布后按 exact SHA 核验 hosted CI。
