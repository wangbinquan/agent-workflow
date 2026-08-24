# RFC-318 设计：节点即说明书

## 1. 实际落点

RFC-318 不建立新的执行器或通用节点 DSL，只在现有边界增加 v2 合同：

- `development-automation/domain/digitalEmployeeToolContractsV2.ts`：九份 strict input schema、八份 direct JSON output schema；
- `development-automation/composition/digitalEmployeeToolContractsV2.ts`：九份 work contract 与节点 guide；
- `development-automation/application/digitalEmployeeToolContractProjectionV2.ts`：host envelope 到最小输入、direct result 到既有 runtime settlement 的投影；
- `development-automation/public/participants.ts`：八个单职责 Agent 定义；
- 现有 execution-contract service：按 `inputMode/outputMode` 路由 direct JSON 或既有 envelope/path；
- 现有 task-execution composition：把投影后的内容交给原有 Agent、Workflow、Program 入口；
- 前端：业务工具把 exact contract guide 作为输入输出说明并折叠协议细节；平台、系统和协作节点只展示自身 WorkItem contract，不读取或渲染业务工具 guide。

`development@9` 使用 v2；v1 registration、Agent 和历史 Case 保留。

## 2. 两层边界

```text
现有 frozen ReactionExecutionPlan / host envelope
                 |
                 v
      contract-specific input projector
                 |
                 v
         direct business JSON
                 |
                 v
     existing Agent / Workflow / Program
                 |
                 v
 direct business result or analysis-plan path
                 |
                 v
 exact contract validator + internal identity wrap
                 |
                 v
 existing workspace / Context / scheduler owners
```

对工具可见的边界是 direct JSON 或单一路径。round、nonce、Context revision、route、retry 等只留在平台内部。平台验证 direct result 后使用内部 `directResult` 包装复用既有 settlement；它不是工具输出 envelope。

## 3. 九个合同

| Contract                       | 输入顶层字段                                                               | 输出顶层字段                                                                        |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `prepare-materials@2`          | `connection, externalItemId, outputDirectory`                              | `outcome` 或 `outcome, explanation`                                                 |
| `plan-implementation@2`        | `requirementsDirectory, outputFile`                                        | 原始 `path<md>`                                                                     |
| `implement-change@2`           | `requirementsDirectory, approvedPlanFile?`                                 | `outcome, commitMessage, mergeRequestTitle, mergeRequestDescription` 或 blocked     |
| `resolve-review-feedback@2`    | `requirementsDirectory, threads`                                           | `outcome, replies, commitMessage?` 或 blocked                                       |
| `collect-pipeline-status@2`    | `connection, mergeRequest, evidenceDirectory`                              | `outcome, observedSourceVersion, observedTargetVersion?, status, checks` 或 blocked |
| `classify-pipeline-failures@2` | `failedChecks, categories, fallbackType`                                   | `outcome, groups` 或 blocked                                                        |
| `repair-pipeline-failures@2`   | `failureType, problems`                                                    | `outcome, commitMessage` 或 blocked                                                 |
| `resolve-merge-conflicts@2`    | `sourceVersion, targetVersion, conflictFiles, requirementsDirectory`       | `outcome, commitMessage` 或 blocked                                                 |
| `draft-approval@2`             | `mergeRequest, currentVersion, approvalType, gateConclusions, formatGuide` | `outcome, draft` 或 blocked                                                         |

所有对象拒绝未知字段。可选字段缺省时省略，不填 `null` 或占位值。

语义校验继续对拍平台事实：

- prepare 必须在已知材料目录形成文件；
- plan 输出必须等于指定方案路径；
- code 节点的 completed 必须与真实 workspace delta 一致；
- review 必须覆盖每个选中线程，只有改代码时带提交信息；
- collect 必须对应当前 MR 版本，证据必须位于给定目录；
- classifier 必须把每个失败检查恰好分到一个已配置类型；
- conflict 只能解决列出的冲突文件；
- approval 必须基于终态门禁，草稿非空。

## 4. 节点说明与配置

节点默认卡片只展示：

1. 动作名称和一句说明；
2. 本次输入；
3. 完成输出；
4. 可用实现；
5. 真正存在时才显示配置。

guide 的字段表与 schema 由测试对拍。高级折叠区只用于 contract ID、端口和 JSON 示例。

详细 guide 只属于 `business-tool`。`system`、平台适配和 `collaboration` 节点没有可配置的业务工具实现，只展示各自 `materialSummary/completionStandard`；不得把 v1 execution-contract 的通用 fallback 当成这些节点的“关键业务参数”。如果没有该节点自己的可见参数，就不额外渲染参数区。

分类节点沿用现有 `dispatchRouteDefinitions` 发布结构；UI 将它表达为“类型标识、名称、说明、兜底分类”。输入 projector 转换为 `categories + fallbackType`。岗位流程拥有处理者、去向和执行顺序，分类工具不拥有顺序。

## 5. Agent 定义

八个 v2 Agent 各声明一个 exact contract。三个实现 Agent 只通过 `implementationIntent` 区分 `unspecified | feature | defect`；其他 Agent 不带 intent。Agent 默认字段仍为现有 `permission={}`、空 skills/dependsOn/MCP/plugins 和 host-default runtime。

persona 说明：

- 动作怎么完成；
- 可用现有网络、仓库、Git 和代码托管读取；
- 哪些外部发布动作属于平台；
- 需要做的适量验证。

persona 不复制 schema、字段表、round、nonce、Context 或 envelope。

## 6. 不变边界

RFC-318 没有新增或修改：

- runner 和 `startTask` 的执行分支；
- 网络模式、凭据、Program env；
- Git、retry、attempt、权限；
- 沙箱或安全防护；
- workspace policy 机制与 enforcement 算法。

仅上层 prompt/input composition 使用 direct JSON；检视 v2 contract 选择既有 `businessChangeOnOk=optional`，用于支持“只回复、不改代码”。

## 7. 设计门

本次以七个角度迭代，问题必须收敛后才发布：

1. **合同门**：逐字段核对消费者、strict schema、direct output 和平台 owner；
2. **职责门**：逐个审视九个节点与八个 Agent 是否重叠、是否复制协议；
3. **配置门**：只保留分类类型与兜底，处理顺序回到岗位流程；
4. **可理解性门**：在真实 UI 逐张查看节点卡片、配置弹窗和协议折叠区。
5. **范围门**：反向确认网络、沙箱、执行器、调度和外部发布 owner 没有越界。
6. **架构门**：用全仓 ratchet 检查 public 入口、participant 大小和跨层面是否保持最小。
7. **展示归属门**：逐类核对业务工具、平台、系统和协作节点，只展示该节点真实拥有的参数与结果。

已收敛的问题包括：方案卡片名称与说明错位、分类顺序 owner 错位、Program fixture 对 direct output 的假绿、审批空结论、旧 envelope 被 v2 接受、prompt 暴露 round/nonce/contract 元数据、检视提交信息和目标版本的可选条件不准确、内置 Agent 展示名过于泛化，以及平台节点误渲染同一份通用业务参数模板。

最终证据记录在同目录 `design-gate-2026-08-24.md`；共享 dirty tree 上的完整本地门结果按
失败路径逐项归因，不把并发 RFC-319/321 的红项记成 RFC-318 通过或失败。
