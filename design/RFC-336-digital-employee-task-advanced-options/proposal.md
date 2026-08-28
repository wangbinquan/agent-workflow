# RFC-336：数字员工任务高级选项补齐

> 状态：Done（2026-08-28；D1～D10 已落地并发布）
>
> current source pin：`main == origin/main == 234cfb2307602ced40bfb3279843843d6818997a`（本轮调研时）。
> 以下源码锚以该 committed pin 为准；生产实施前必须重新 fetch 并对拍正在实施的 RFC-334 与并行共享树。
>
> 审查边界：只补产品功能与职责闭环，不新增或调整安全/权限策略。

## 1. 摘要裁决

统一任务创建已经让 Workflow、Agent、工作组和数字员工共用“执行方式 → 执行空间 → 任务内容 → 确认”四步骨架，
但“任务内容”页中的高级设置只在编排来源实现。当前编排高级区实际有五项：

1. 协作者；
2. 工作分支；
3. 完成后自动提交并推送；
4. 最大运行时长；
5. Token 总量上限。

数字员工本来就由平台固定执行提交、推送和创建/更新 MR；用户已明确要求**不要提供自动提交并推送开关**。因此 RFC-336 不机械复制
编排的全部五项，而只补数字员工适用的四项：协作者、工作分支、最大运行时长和 Token 总量上限。只复制 JSX 仍会造成“界面可填、
后端 strict schema 拒绝”或“成功创建但配置被忽略”，所以四项都必须送到真正 owner：通用 Case 协作与限额归
`digital-employee`，工作分支由员工类型声明并由类型包的仓库交付 participant 消费，内部 Task 只接收本轮剩余额度，不能反过来成为
EmployeeCase 的配置真相；自动发布链保持 current 固定行为。

## 2. current-source 对账

### 2.1 编排来源已经有完整的五项 UI 与 wire

- `packages/frontend/src/routes/tasks.new.tsx:1492-1501` 的 `collectAdvanced()` 组装
  `collaboratorUserIds/workingBranch/autoCommitPush/maxDurationMs/maxTotalTokens`；
- 同文件 `2560-2644` 在内容步渲染高级折叠区，`2728-2759` 在确认步展示已选值；
- 工作分支只在远端空间出现，分支名、正整数时长和正整数 Token 在进入下一步前校验。

本 RFC 以 live 五项作为来源对账，但按用户裁决从数字员工中排除“自动提交并推送”开关，只实现其余四项。Git 提交身份当前是确认页
独立事实，Agent 的“允许反问”也已移出高级折叠；两者同样不在本 RFC 范围内。

### 2.2 数字员工只提交业务材料与类型执行选项

- `TaskCreationSubjectDescriptorContract.tsx:63-70` 只有员工、名称、材料、目标与 `executionOptions` 状态；
- `359-397` 的 Case POST 只发送 `name/kind/target/body/externalId/uploads/executionOptions/idempotencyKey`；
- `618-901` 的内容步没有高级区，`904-988` 的确认步只有员工、空间、名称、材料和执行策略。

因此缺口不是样式或文案漏挂，而是数字员工创建合同本身尚未声明高级选项。

### 2.3 后端 strict intake、Case row 与原子创建都没有限额/高级事实

- `modules/digital-employee/domain/runtimeModel.ts:39-81` 的 `employeeWorkIntakeSchema` 是 strict object，未知高级字段会被拒绝；
- 同文件 `157-176` 的 `EmployeeCaseRecord` 没有用户限额；
- `runtimeService.ts:574-587,669-711` 只把 owner/origin/uploads 带入 `launchCase/createCase`；
- `db/schema.ts:6049-6076` 的 `employee_cases` 没有高级列。

好消息是 RFC-330 已有 `employee_case_members`（`schema.ts:6100-6121`）和成员读写合同；协作者不需要再造第二套关系表，只需让
Case admission 在同一事务种下初始 collaborator rows。

### 2.4 现有限额和发布语义不能直接照搬字段

- 数字员工全局执行策略已有 `roundBudgetMs/caseBudgetMs`；`runtimeService.ts:2289-2301` 仍按 Case 创建时间执行策略级
  case budget，`2584-2586` 给每轮冻结 `roundBudgetMs`；
- `task-execution/composition/digitalEmployeeExecution.ts:354-367` 只把每轮预算映射成内部 Task 的 `maxDurationMs`，没有
  Case 级 Token 汇总；
- 研发类型工作区当前在 `digitalEmployeeWorkspace.ts:732-744` 固定生成
  `agent-workflow/employee/<caseId>` source branch；
- `digitalEmployeePlatformWorkItems.ts:1608-1767` 的 `publish-mr` 平台工作项总会验证、commit、CAS push 并创建/复用 MR。

这也证明自动提交不是数字员工的 launch option：内部 Task 不拥有平台发布，类型包的 `publish-mr` 平台工作项才是唯一发布 owner。
RFC-336 只允许用户指定 source branch，后续验证、commit、CAS push 与 MR ensure 仍固定执行。

### 2.5 既有架构边界必须保持

RFC-294 把 EmployeeCase/Context/Reaction 归 `digital-employee`，把代码员工业务 schema 与发布规则归
`development-automation`，把 Git 操作归 `source-control`；通用数字员工不得按 `type === development` 分支，也不得读取 Task row。
RFC-310 §21.8/§21.9 又要求唯一四步 Host、来源合同驱动内容、来源各自提交最终 command。

因此本 RFC 采用“共享 UI + 通用 Case 控制 + 类型声明的仓库交付扩展”，而不是在公共创建页或 DigitalEmployee runtime 写开发类型特判。

## 3. 目标

### G1：数字员工内容步拥有与编排同形的高级设置

同一个可复用组件按来源 capability 渲染控件、字段校验、错误提示与确认摘要。数字员工只显示四项：协作者与限额对所有手工 Case
可用；工作分支只在所选员工类型声明仓库交付能力且本次执行空间解析到仓库时出现。自动提交并推送开关永不出现在数字员工分支。

### G2：每项输入都有可观察的运行时效果

创建响应、Case 详情与确认摘要展示冻结值；协作者立即进入共享任务可见/协作模型；限额覆盖多轮 Reaction；工作分支成为实际 source
branch，平台随后固定完成验证、commit、CAS push 与 MR 创建/复用。

### G3：默认行为兼容

所有字段留空时，手工和事件启动 Case 的行为与 current source 一致：无新增协作者，仍受已 pin 执行策略约束，研发类型继续生成默认
source branch 并由平台自动 commit/push/MR。存量 Case 不被追填虚构的用户选择。

### G4：数字员工仍是 Case owner，Task 仍是执行 participant

Case 保存用户上限和累计计量；每轮只把“本轮可用剩余额度”冻结进 Reaction execution request。TaskExecution 返回目的明确的计量回执，
DigitalEmployee 不查询 Task/NodeRun 表，TaskExecution 也不更新 EmployeeCase。

## 4. 非目标

- 不给数字员工增加定时创建、重跑旧编排或复用编排 payload。
- 不把 Git 提交身份、“允许反问”、多仓第 2..8 行或类型自己的执行策略开关塞进本高级区。
- 不让所有员工类型假装支持工作分支；未声明仓库交付能力时不显示、也不接收该值。
- 不让 Agent 执行 Git commit/push/MR；平台发布 owner 保持不变。
- 不给数字员工增加自动提交并推送开关、关闭模式、未发布终态或事后手动发布命令。
- 不改变全局 `roundBudgetMs/caseBudgetMs`、retry/handoff 策略；用户限额只增加更窄的 Case 级上限。
- 不借机重写统一创建 Host、数字员工职责图、Case 列表/详情 IA 或仓库交付内核。
- 不新增或调整安全、权限、凭据和授权策略。

## 5. 已批准决策

### D1 — 数字员工精确补四项，明确排除自动提交开关

数字员工高级区固定补：协作者、工作分支、最大运行时长、Token 总量上限。自动提交并推送、Git 身份、允许反问、多仓不随本 RFC
进入数字员工。共享组件仍须保持编排现有五项能力，但由 capability 隐藏数字员工不适用的自动提交开关；以后新增通用高级项必须再更新
共享 capability contract 和两来源测试，不能只在一个页面临时加 JSX。

### D2 — 抽取同一个高级设置组件与摘要投影

把编排现有五项 UI 抽为 `TaskCreationAdvancedSettings`（命名可在实现期微调），输入是受控值、逐项 capability、空间可用性和 disabled
状态；它不读取 source id、不提交请求、不拥有四步状态机。编排继续启用五项，数字员工只启用四项；两者使用同一个 summary item
builder，原编排行为逐项保持。

### D3 — wire 分成通用 Case 控制与类型扩展

手工 Case intake 新增 strict `advanced`：

```ts
interface EmployeeCaseAdvancedInputV1 {
  collaboratorUserIds?: string[]
  maxDurationMs?: number
  maxTotalTokens?: number
  typeOptions?: Record<string, string>
}
```

前三项由 DigitalEmployee exact codec 校验并拥有；`typeOptions` 的 key/type/默认值必须来自所选 published type descriptor，通用 runtime
只做 closed declaration 对拍并原样交给该类型 codec，不能理解 `workingBranch`，不能接受未声明键或开放 JSON。内置研发类型声明
`repository-branch@1` 字符串扩展，只把工作分支映射成冻结 Context/工作区事实；wire 中没有 `autoCommitPush`。

### D4 — 协作者随 Case 原子创建

创建者仍只写 `employee_cases.owner_user_id`；所选用户以 `role='collaborator'` 写既有 `employee_case_members`。Case row、primary Context、
upload claims、external subject、event origin 与初始成员必须同一事务成功或全部失败。owner 不重复写成员行，重复 id 规范化；创建成功后目录
`scope=shared`、Case 详情成员卡和协作动作立即看到同一成员真相。

### D5 — 时长是 Case 自身“实际执行时间”的累计上限

`maxDurationMs` 跨本 Case 的所有本地 Reaction 轮次累计：内部 Agent/Workflow/Program Task 使用 Task owner 返回的
`effectiveRunningMs`（与编排一致扣除人工等待），直接平台工作项按 durable attempt 的实际执行区间计量；等待事件、人工评审、员工协同子
Case 或 block 的时间不计。子 Case 不继承也不反向计入父 Case。

每轮可用时长为 `min(policy.roundBudgetMs, userRemainingDuration)`；原有 policy `caseBudgetMs` 仍独立生效，谁先耗尽谁先结算。
用户上限耗尽固定以 `case-duration-limit-exceeded` 终结，不改写 policy 的 handoff 规则。

### D6 — Token 是本 Case 所启动 Reaction execution 的累计上限

每个内部 Task 的全部 attempt/token usage 由 TaskExecution 以 exact metering receipt 返回，DigitalEmployee 按 execution/attempt 幂等累计；
平台工作项与员工协同子 Case 对父 Case 计 0。启动下一轮前把剩余 Token 作为内部 Task 的 `maxTotalTokens`，运行中超限沿用 Task limit
取消，再把 Case 结算为 `case-token-limit-exceeded`。失败、重试、crash replay 都不能漏计或重复计。

### D7 — 工作分支由类型 capability 驱动，并真的成为发布 source branch

只有 type descriptor 声明 `repository-branch@1` 时，共享组件才显示工作分支。留空保持 current 自动名
`agent-workflow/employee/<caseId>`；指定分支使用与编排相同的分支名校验，并由 source-control participant 解析：

- 远端不存在：从本次已解析 target baseline 创建；
- 远端已存在：冻结其 exact head 作为工作 baseline，后续只做 CAS fast-forward；
- 已有 MR 的 source/target 与本次不一致：明确阻断，绝不 force/rebase 或静默改目标。

公共前端、DigitalEmployee runtime 与 bootstrap 都不得出现开发类型字面量分支。

### D8 — 自动提交发布是数字员工固定职责，不是高级选项（用户已确认）

数字员工创建 UI、wire、Case row、type options 与 localStorage 均不得出现 `autoCommitPush`。只要员工类型的职责链产生可发布修改，平台就继续
按 current 规则执行验证 → commit → CAS push → create/reuse MR；用户指定工作分支只改变 source branch，不改变发布必经性。
编排来源原有开关与偏好完全保留，两种来源不能互相污染。

### D9 — nullable expand-only migration 与默认兼容

`employee_cases` 新增 nullable `max_duration_ms/max_total_tokens` 与 nonnegative 累计计量列；存量行 `NULL/0` 即旧行为。
类型专属工作分支只进入该类型的 strict primary Context/工作区投影，不污染通用 Case row。事件启动与员工协同启动没有 UI 选择，使用
空协作者、空用户限额和类型生成的默认分支；发布链固定保持 current 行为。

### D10 — 确认页、详情与错误必须解释最终事实

确认页以与编排相同的“高级设置”摘要展示四项已选值；Case 详情展示冻结上限、已消耗/剩余值和实际 source branch。正整数、分支名、
未知类型 option 或不支持 capability 的输入在创建前/创建命令处明确失败，不允许静默丢弃；数字员工摘要与详情都不显示自动提交开关。

## 6. 能力影响

| 功能面         | current                                                | RFC-336 目标                             |
| -------------- | ------------------------------------------------------ | ---------------------------------------- |
| 数字员工内容步 | 只有材料、目标和类型执行策略                           | 增加共享高级折叠区与完整确认摘要         |
| Case 协作      | 创建后才能另行维护成员                                 | 创建时原子种下 collaborator              |
| Case 时长      | 只有 policy wall-clock case budget 与 per-round budget | 增加用户可选的累计实际执行时长上限       |
| Case Token     | 无 Case 级上限                                         | 多轮 exact metering + remaining cap      |
| source branch  | 固定按 Case id 自动生成                                | 留空兼容；可指定/续用远端分支且 CAS      |
| 平台发布       | 研发类型总会 commit/push/MR                            | 固定保持，不增加开关或关闭分支           |
| 其他员工类型   | 没有工作分支字段                                       | 只有声明 capability 才出现，不写类型特判 |
| 存量/事件 Case | current defaults                                       | 不追填用户值，行为不变                   |

## 7. 验收标准

- **AC-1**：数字员工内容步在同一四步 Host 内出现 `wizard-advanced`；协作者/两项限额总可用，工作分支只由 type capability 决定，自动提交开关不存在。
- **AC-2**：编排与数字员工共用一个高级设置组件/summary builder；编排五项、数字员工四项由 capability 投影，公共组件无 source id/type id 分支。
- **AC-3**：数字员工 POST 精确携带所选 advanced 值；未知键、错类型、不支持 capability、非正整数和非法分支均在副作用前失败。
- **AC-4**：Case、primary Context、uploads、external subject 与初始 collaborators 原子创建；失败不留半个 Case/成员/claim。
- **AC-5**：创建后 owner/collaborator/observer 投影、目录 `mine/shared/all` 与成员编辑都读取既有单一成员表。
- **AC-6**：至少三轮 Reaction 覆盖时长/Token 逐轮递减；重试与 crash replay exact-once 计量，超限不启动下一轮并给出固定 terminal kind。
- **AC-7**：人工评审、事件等待、block 与子员工等待不消耗用户时长；直接平台工作实际执行会消耗，子 Case token 不计父 Case。
- **AC-8**：blank/显式 source branch、远端缺失/存在、existing MR target mismatch、CAS 冲突均有真实 source-control fixture；无 force/rebase。
- **AC-9**：blank/显式工作分支都完整跑过 current candidate→validation→commit→CAS push→MR 旅程；源码、DOM、wire、Case/type options 均无数字员工 `autoCommitPush`。
- **AC-10**：存量 Case、事件启动、员工协同 child 使用旧默认；migration forward/rolling/rollback 兼容，旧 binary 不读取新列也不误改 Context。
- **AC-11**：确认页和 Case 详情展示冻结值与实际结果；回到内容步修改后摘要、payload、运行结果一致。
- **AC-12**：桌面、窄屏、键盘/focus、展开/收起、非法输入与真实点击 E2E 通过；切换来源/员工不会把上一来源或不支持类型的高级值泄漏进提交。
- **AC-13**：架构守卫锁住：DigitalEmployee 不读 Task/NodeRun 表，TaskExecution 不写 EmployeeCase，公共 UI/runtime/bootstrap 无开发类型分支，Git effect 仍只经 source-control participant。
- **AC-14**：功能回归覆盖编排五项现有 payload/默认/localStorage 行为，抽组件不造成任何既有能力变化。

## 8. 批准记录

用户先明确确认 D8，随后于 2026-08-28 批准 D1～D7、D9～D10 全部实施，并授权完成后提交、推送到远端。已批准的三项关键产品语义是：

1. 时长按本 Case 的累计实际执行时间，等待不计、子 Case 不继承；
2. Token 只累计本 Case 启动的 Reaction executions；
3. 工作分支留空继续自动生成；显式分支不存在时创建，已存在时从 exact remote head 继续并只做 CAS fast-forward。

生产代码、DB migration、前后端测试与真实发布旅程已完成并发布：

- 主实现 `07c7d37b4`，归一化/来源锁定 `1c296f3a4` / `287ea50fe`，测试/架构修复
  `e2bee56ae` / `f5e7833fd` / `aa32b65ad`；全部已进入 `origin/main` 并为 `8e58eb05f` 祖先。
- containing SHA `8e58eb05f` 的 GitHub Actions CI run `33142147682` 35/35 成功；visual run
  `33139682210` 和 Windows run `33139296772` 均 1/1 成功。
