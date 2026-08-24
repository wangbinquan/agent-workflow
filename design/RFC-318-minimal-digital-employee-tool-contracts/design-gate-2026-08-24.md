# RFC-318 设计门记录（2026-08-24）

- 审查对象：`development@9` 的九个业务节点、九份 v2 contract、八个 v2 内置 Agent、节点卡片与分类配置
- 开工基线：`main@9a6961727b8dd5a946310f34d0f378ab0b57ab13`
- 当前结论：七轮设计问题已收敛，无遗留 P1/P2；共享 dirty tree 的完整本地门已执行并按路径归因，提交后 hosted CI 待 exact SHA 执行

## 不变量

每一轮都同时检查以下边界：

1. tool 输入只包含本动作实际消费的业务字段；
2. tool 输出只表达本动作的业务结果；
3. 一个节点只做一个动作，一个内置 Agent 只声明一个 contract；
4. 配置只表达使用者真正需要决定的内容；
5. 保留现有网络、Agent、Workflow、Program 和 script 能力；
6. 不增加零网络、沙箱、安全拦截或新执行分支；
7. runner、`startTask` 及其下层不改。

## 第一轮：合同与 wire

### 发现

- v1 通用 envelope 把 round、nonce、Context patch、effect 和 artifact receipt 暴露给了业务工具。
- 多个节点的输入输出需要结合平台内部状态才能理解，节点名称无法直接推导 wire。
- JSON 节点可返回并不属于本动作的调度字段，职责边界不闭合。

### 修正

- 新增九份 v2 contract；八份 JSON contract 使用 strict direct input/output，方案节点只输出 `analysis-plan: path<md>`。
- host identity 仅保留在平台内部，projector 在工具调用前后完成业务对象与既有 settlement 的转换。
- v2 明确拒绝旧 `agent-result` envelope、未知字段、route、handler 和 next-step 元数据。

### 复核

- 九份输入的每个顶层字段均能定位到唯一 consumer。
- 八份 JSON 输出只有 `completed` 或 `blocked` 两种直观结果；成功字段均由本节点产生。
- 方案输入直接给出 `requirementsDirectory/outputFile`，输出必须是同一路径。

结论：通过。

## 第二轮：节点职责与内置 Agent

### 发现

- 旧内置 Agent 名称过于泛化，无法从名称区分实现、分类、修复、检视和冲突动作。
- 分类 Agent 容易同时承担“问题分类、处理者选择、执行顺序”三个职责。
- persona 复制 wire、round、nonce 和分类表会产生第二份协议来源。

### 修正

- 八个 v2 内置 Agent 改为动作型名称：通用代码实现、流水线失败分类、流水线失败修复、检视意见处理、合并冲突处理、业务需求实现、缺陷修复、编写实现方案。
- 每个 Agent 只声明一个 exact contract；三个实现 Agent 仅用 `unspecified/feature/defect` intent 区分。
- 分类 Agent 只分组；岗位流程继续拥有处理者、去向和执行顺序。
- persona 只写动作、业务边界、可用读取能力和必要验证，不复制 schema 或 host 元数据。

### 复核

- 八个 Agent 的名称都能直接推出其输入 contract 和唯一动作。
- 无 Agent 同时声明两个 v2 contract；无 persona 自建 envelope。

结论：通过。

## 第三轮：配置与真实 UI

### 发现

- 分类配置曾把列表顺序暗示成修复优先级，与岗位流程的真实 owner 冲突。
- 方案辅助卡片名称和说明仍沿用“分析”，没有表达“编写方案”。
- 检视提交信息、流水线目标版本的说明与可选条件重复，阅读成本高。
- 实现节点的三个内置 Agent 展示名不足以直接区分通用、需求与缺陷。

### 修正

- 分类配置只保留类型标识、名称、说明和一个兜底分类；明确列表不决定处理顺序。
- 方案卡片统一为“编写实现方案”，输出明确为指定 Markdown 文件路径。
- 可选字段拆成“字段含义 + 返回条件”：只有改代码时返回提交信息，只有提供方确认时返回目标版本。
- 节点默认区只展示动作、输入、输出和可用实现；contract ID、端口与示例进入“协议与示例”。

### 复核

在真实页面逐张查看完整职责图、分类节点、分类配置弹窗、方案节点、实现节点和协议折叠区；名称、输入、输出及唯一配置均可直接理解。

结论：通过。

## 第四轮：执行接缝与反例

### 发现

- Program authoring fixture 仍按旧 envelope 校验，可能让 direct output 假通过。
- 空门禁结论可生成没有事实依据的审批草稿。
- 人工评审 system mock 仍从旧路径标记读取方案输出，未真实验证 v2 direct input。
- v2 direct prompt 曾携带 contract、schema、round、nonce 等工具不需要的信息。

### 修正

- Agent、Workflow、Program 都通过同一 exact contract 校验 direct result。
- 审批输入要求至少一个终态门禁结论，草稿必须非空。
- 人工评审链改用 `plan-implementation@2` 的 `outputFile`，并验证驳回只重跑规划、批准后才运行实现。
- v2 Agent prompt 只保留动作说明、业务输入、业务结果和职责边界；旧冻结 contract 单独兼容，不污染 v2 wire。

### 复核

- RFC-318 与 execution-contract 定向测试：25 通过，0 失败。
- 人工评审真实 TaskEngine/system-mock：1 通过，0 失败，28 个断言。
- 主链 system-mock、直接输出 journey、前端节点与职责图定向套件均已通过。

结论：通过。

## 第五轮：范围与内耗审计

### 检查

- 搜索 v2 guide、Agent persona、prompt 和设计文档中的零网络、沙箱与新安全限制。
- 对照改动路径检查 runner、`startTask`、executor、Git 执行、retry、凭据和 Program env。
- 逐项检查九个节点是否存在重复字段、占位 `null`、工具决定下一步或平台状态回写。
- 复查分类配置 owner、内置 Agent exact contract 和历史 v1 保留方式。
- 反向追踪分类结果的 `remainingTypes` 消费链；即使工具反序返回类型，运行时仍按岗位冻结的 `failureTypeDefinitions` 选择下一处理项。

### 结论

- 所有节点继续使用现有网络；“平台负责外部发布”仅是职责边界，不是执行限制。
- 没有新增沙箱、安全防护或执行器分支；RFC-318 改动止于现有 execution-contract 与 task-execution 的上层输入/prompt 组合。
- 九个节点信息量已收敛到完成动作所需的最小集合；没有工具拥有调度或外部发布结果。
- 分类结果只表达“哪些检查属于哪类”，不会通过数组顺序取得修复优先级。
- v1 registration、Agent 和历史 Case 保留；`development@9` 只使用 v2。

结论：通过，无遗留 P1/P2。

## 第六轮：架构公共面与完整门归因

### 发现

- v2 内置 Agent 定义最初放在 `public/digitalEmployeeAgentTemplatesV2.ts`，名称不属于 exact public 入口。
- `ExecutionContractRegistration` 使用函数属性类型，公共面扫描将其识别为开放 `FunctionType`。
- 为 direct wire 增加的 `projectInput` 让原 `ExecutionContractParticipant` 达到六个方法；runtime view 同时暴露重复的 `outputMode`，超过 god-surface 阈值。
- 共享 dirty tree 的完整门同时包含 RFC-319 新 E2E 与 RFC-321 凭据/传输 WIP；冲突链路在 RFC-318 工具完成后被 `publication-transport-unavailable` 阻断。

### 修正

- Agent 定义改走 exact `development-automation/public/participants.ts`。
- registration 改用具名方法签名；业务输入投影拆成单一职责 `ExecutionContractProjectionParticipant`。
- runtime view 删除重复 `outputMode`；prompt 从已解析的完整 `guideJson` 读取输出模式。
- 不修改并发 RFC-319/321 的实现或账本，不重跑等价完整门；只对 RFC-318 自身红项做定向复验。

### 复核

- RFC-318、execution-contract 与 development-automation 架构锁：36 通过，0 失败。
- RFC-294 god-surface ratchet：1 通过，0 失败。
- 完整本地门的其余红项均落在 RFC-319 新 E2E、RFC-321 route/transport/credential/architecture 账本或其已知冲突发布前置条件；不据此宣称完整门通过。

结论：RFC-318 自身架构问题收敛，无遗留 P1/P2；完整仓库终态由干净 exact-SHA hosted CI 判定。

## 第七轮：节点可见信息归属

### 发现

- 平台节点虽然各自声明了不同的 `materialSummary/completionStandard`，节点详情仍无条件查询 execution-contract guide。
- v1 registration 对没有专用字段的合同使用通用 fallback，导致多个平台节点的“关键业务参数”看起来完全相同；真实节点合同与可见参数产生冲突。

### 修正

- `business-tool` 才查询并渲染详细 execution-contract guide。
- 平台、系统与协作节点只展示自己的 WorkItem contract 输入和输出；不存在自有参数时不渲染参数区。
- 增加 12 个平台节点输入/输出逐项唯一且对拍自身合同的后端锁，以及真实页面点击平台节点后没有 `execution-contract-guide` 的 hosted visual 断言。

### 复核

- 12 个非业务节点拥有 12 组不同输入和 12 组不同输出，均与所引用 WorkContract 一致。
- 前端查询与渲染同时受 `nodeKind === 'business-tool'` 约束，平台节点不会再因 fallback 显示模板参数。
- 没有修改网络、沙箱、runner、`startTask`、executor 或平台节点执行语义。

结论：通过，无遗留 P1/P2。

## 最终验证状态

| 证据                                     | 状态                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| contract/schema/projector/Agent 定向测试 | 通过                                                                                 |
| 节点卡片、配置、职责图定向测试           | 通过                                                                                 |
| 人工评审 TaskEngine/system-mock          | 通过                                                                                 |
| 冲突 system-mock                         | RFC-318 动作已完成；当前 shared dirty tree 随后被并发 RFC-321 的发布凭据前置条件阻断 |
| 唯一一次 `bun run gate:local`            | 已执行；共享 dirty tree 因并发 RFC-319/321 红，RFC-318 自身发现已修复并定向复验      |
| exact-SHA hosted CI/visual               | 待提交推送                                                                           |
