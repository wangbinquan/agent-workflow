# RFC-336 设计：数字员工任务高级选项补齐

> 状态：Done（2026-08-28；proposal D1～D10 已落地、发布并通过远端 CI）
>
> 本文描述已批准并发布的最终实现。

## 1. 设计原则

1. “显示了”不是完成；每个高级值必须冻结、持久、执行、查询和测试闭环。
2. 统一创建只共享 UI/值对象，不共享编排 Task 与 EmployeeCase 的最终 command。
3. 通用 Case 控制归 DigitalEmployee；类型专属工作分支由 published type descriptor 声明、type codec 解释。
4. DigitalEmployee 不读 Task/NodeRun 表；TaskExecution 用 purpose-specific receipt 返回计量。
5. 分支/commit/push/MR 仍由类型包 + source-control/integration participant 完成；Agent 永远不执行 Git 发布。
6. 留空保持 current 行为；存量和事件 Case 不猜测用户选择。
7. 公共前端、通用 runtime 与 bootstrap 不出现 `development` 类型分支。
8. 所有门只审功能正确性与 owner 边界，不增加安全策略。

## 2. 前端结构

### 2.1 共享值对象

建议在 task-creation 公共目录建立唯一值对象；命名可按现有风格微调：

```ts
interface TaskCreationAdvancedValues {
  readonly collaborators: readonly UserSummary[]
  readonly workingBranch: string
  readonly autoCommitPush?: boolean // orchestration only; digital employee omits the key
  readonly maxDurationMin: number | undefined
  readonly maxTotalTokens: number | undefined
}

interface TaskCreationAdvancedCapabilities {
  readonly collaborators: boolean
  readonly workingBranch: boolean
  readonly autoCommitPush?: boolean // orchestration only
  readonly limits: boolean
}
```

`TaskCreationAdvancedSettings` 只接受 values/onChange/capabilities/disabled/actor facts；它拥有现有字段结构、test id、字段错误和
展开区 DOM，不拥有 fetch、source selection、submit 或 Stepper。`buildTaskCreationAdvancedSummary` 从同一 values/capabilities 生成确认项，
禁止两来源各手写一套过滤规则。

### 2.2 编排接入

`tasks.new.tsx` 把现有高级 JSX 移入共享组件，仍由编排 wizard 持有：

- `loadAutoCommitPushPref/saveAutoCommitPushPref` 的 current key 与默认保持；
- scratch/remote 可用性、UserPicker inventory、分支校验和 payload builder 逐项保持；
- 原有 `wizard-*` test id 与确认页语义保持，避免抽组件变成行为改写。

### 2.3 数字员工接入

`TaskCreationSubjectDescriptorContract` 增加同一 values state：

- collaborators 初始空；
- limits 初始 `undefined`；
- working-branch capability 来自所选 type descriptor；
- auto-commit-push capability 与值键均省略；数字员工不读取/写入编排偏好，也不提交该字段；
- employee/type/capability 切换后，已经不受支持的 branch 值立即从受控 state 与提交 projection 清掉，不静默带到别的员工；
- 高级折叠放在现有类型执行策略之后、内容步末尾；确认步增加同形“高级设置”行。

分支错误、时长/Token 非正整数错误必须在用户进入确认步前直接显示；不能仅依赖 `min`、disabled submit 或后端 422。

### 2.4 descriptor 投影

共享 task-creation contract 定义稳定的 presentation control ids：

```ts
type TaskCreationAdvancedControlId = 'working-branch'

interface EmployeeTypeLaunchOptionDescriptor {
  readonly optionRef: string
  readonly controlId: 'working-branch'
  readonly valueKind: 'string'
  readonly defaultValue: string | null
  readonly availability: 'repository-space'
}
```

`workIntakeAuthoring.launchOptions` 是 closed array，`optionRef`/`controlId` 均唯一；一个类型至多声明一个 string working-branch。
内置研发类型声明该 option；其他 fixture 类型不声明时 UI 不出现工作分支。自动提交发布不进入 descriptor，公共组件只看
`controlId`，不看 type id。

## 3. 创建 wire 与 admission

### 3.1 请求形状

现有 `employeeWorkIntakeSchema` 增加可选 strict advanced envelope：

```ts
const employeeCaseAdvancedInputV1Schema = z
  .object({
    collaboratorUserIds: z.array(z.string().min(1)).max(100).default([]),
    maxDurationMs: z.number().int().positive().nullable().default(null),
    maxTotalTokens: z.number().int().positive().nullable().default(null),
    typeOptions: z.record(z.string().min(1).max(160), z.string()).default({}),
  })
  .strict()
```

wire 可用 record 承载不同类型，但 admission 绝不是 open map：runtime 在任何副作用前读取 exact published descriptor，要求 key set 是其
`launchOptions` 子集、值类型完全一致、缺省项以 descriptor default 规范化；随后把 canonical options 交给 type codec 做语义校验。
未声明 key、多给 control、错类型或同 control 重复均返回稳定 validation code。

空 `advanced` 与显式 `{collaboratorUserIds:[], maxDurationMs:null, maxTotalTokens:null, typeOptions:{}}` 规范化成同一 digest，保证
idempotency replay 不因默认展开方式变化而冲突。

### 3.2 通用/类型拆分

admission 形成两部分：

```text
advanced
  ├─ case controls
  │    ├─ collaboratorUserIds
  │    ├─ maxDurationMs
  │    └─ maxTotalTokens
  └─ canonical type options
       └─ type codec buildInitialCaseJson(...)
            └─ primary Context / type-owned workspace facts
```

`EmployeeCaseRecord` 只增加 limits/meter totals；不增加 `workingBranch` 或 `autoCommitPush`。类型 codec 必须把 canonical working-branch
option 明确写进自己的 strict primary Context，不能靠后续读取请求 body 或 current descriptor default。任何数字员工 wire/context 中出现
`autoCommitPush` 都是合同错误。

### 3.3 协作者 admission

沿用 RFC-330 的成员规则与现有 user projection。runtime 在调用 store 前完成用户规范化，向 `RuntimeCaseStorePort.createCase` 增加：

```ts
readonly initialMembers: readonly {
  readonly userId: string
  readonly role: 'collaborator'
  readonly addedBy: string
  readonly addedAt: number
}[]
```

SQLite store 在现有 transaction 中依次 claim uploads、insert Case、insert members、event origin、lifecycle outbox、primary Context 与 external
subject。任一步冲突则整笔回滚。owner id 从 members 中剔除，重复 collaborator last/first normalization 必须确定且测试锁定；不得在 POST
成功后再补发一次 PUT members。

## 4. Case 限额与计量

### 4.1 持久模型

`employee_cases` expand-only 增加：

```text
max_duration_ms          INTEGER NULL
max_total_tokens         INTEGER NULL
consumed_duration_ms     INTEGER NOT NULL DEFAULT 0
consumed_total_tokens    INTEGER NOT NULL DEFAULT 0
```

为 crash/retry exact-once 计量增加 purpose-specific ledger（最终表名按 migration inventory 决定）：

```text
employee_case_metering_receipts
  case_id
  source_kind            -- reaction-execution | platform-attempt
  source_ref             -- opaque execution/attempt ref
  duration_ms
  total_tokens
  created_at
  PRIMARY KEY(case_id, source_kind, source_ref)
```

store 的 `applyMeteringReceipt` 在一个 DB transaction 中 insert-once receipt 并递增 Case totals；重复 receipt 返回已有结果且不重复累加。
所有数值 nonnegative/safe integer，累计溢出明确失败，不能 wrap 或截断。

### 4.2 TaskExecution 计量合同

扩展 DigitalEmployee-owned required port 的终态 snapshot，而不是 DE 查询 Task table：

```ts
interface ReactionExecutionMeteringV1 {
  readonly execution: ReactionExecutionRef
  readonly effectiveRunningMs: number
  readonly totalTokens: number
}

type ReactionExecutionSnapshotV1 =
  | { readonly kind: 'pending' | 'running' }
  | {
      readonly kind: 'completed'
      readonly output: ReactionOutputArtifactRef
      readonly metering: ReactionExecutionMeteringV1
    }
  | { readonly kind: 'failed'; /* current fields */ readonly metering: ReactionExecutionMeteringV1 }
  | {
      readonly kind: 'stopped'
      /* current fields */ readonly metering: ReactionExecutionMeteringV1
    }
```

TE adapter 从 Task owner 的单一限额/usage 计算读取 `effectiveRunningMs` 与全部 attempt token，返回 exact branded execution 对应的值；不返回
Task id、NodeRun、raw log 或 DB row。completed/failed/stopped 都必须有 receipt，保证失败重试也计量。

### 4.3 planning 与扣减顺序

每次准备新 Reaction round 前：

1. 读取 Case 当前 totals；
2. 若用户 duration/token remaining `<= 0`，不创建 Round/Outbox，直接以对应 terminal kind 结算；
3. 计算 `roundDuration = min(policy.roundBudgetMs, remainingDuration ?? +∞)`；
4. 把 `roundDuration` 与 `remainingTokens` 冻结进 reaction execution policy/ref；
5. TE 启动内部 Task 时映射为 `maxDurationMs/maxTotalTokens`；
6. 每个终态 attempt 先落 metering receipt，再决定 retry/settle/next work item；
7. 若 receipt 后达到/超过上限，Case 终结，不能再 enqueue 下一轮。

Task 的 duration receipt 必须沿用 `services/limits.ts` 的 effective runtime 口径，包含其 durable human-wait deduction；不得用
`finishedAt-startedAt` 重新算一套。

### 4.4 平台工作项与等待

直接 `platform-work-item-execute` 不经 Task，因此 outbox claim 为每个真实 attempt 铸 metering source ref；attempt 完成/失败时以 durable
start/finish receipt 计 duration、Token 固定 0。crash takeover 对未结算 attempt 必须先按 outbox lease/operation ledger 得到唯一结算，再重试，
不能重复或永久漏计。

以下时间明确不计入用户 duration：pending inbox、Event Center 等待、Case `waiting/blocked`、人工 review wait、等待 child Case/channel。
child Case 使用自己的 limits/policy；父 Case不累计 child token/duration，也不把高级值注入 child admission。

### 4.5 policy 交互

- `roundBudgetMs` 仍是每轮上限；用户 remaining 只能收窄它。
- `caseBudgetMs` 仍按 current policy 独立执行，不被用户值扩大或替换。
- 用户 limit exhaustion 固定 terminal，错误为 `case-duration-limit-exceeded` / `case-token-limit-exceeded`。
- policy exhaustion 继续 current `handoffOnExhausted` 分支，不能混用用户 terminal code。

## 5. 仓库交付扩展

### 5.1 类型 codec 冻结

内置研发类型从 canonical `typeOptions` 解析：

```ts
interface RepositoryBranchLaunchOptionsV1 {
  readonly workingBranch: string | null
}
```

它进入 `development.issue-handling` primary Context 的 strict request/delivery section，并随 revision immutable；workspace/platform work item
只能从 Context/由其构造的 typed plan 读取，不能回读 UI payload 或 descriptor current default。

### 5.2 source branch 解析

workspace 首次 materialize 时调用 source-control purpose-specific participant：

```text
workingBranch = null
  → current generated agent-workflow/employee/<stable-case-id>

workingBranch = explicit
  → validate canonical branch
  → inspect exact remote ref
      missing  → baseline = resolved target head, expectedRemoteSha = null
      existing → baseline = remote source head, expectedRemoteSha = that head
```

后续 candidate commit/push 恒定使用 row 中冻结的 `sourceBranch/expectedRemoteSha`；成功后推进 expected head，冲突修复继续 CAS。
MR ensure 若发现同 source branch 指向不同 target，返回 typed mismatch 并 block；绝不自动改目标、force push、rebase 或另起同名分支。

### 5.3 自动提交发布固定执行

数字员工不存在 `autoCommitPush` 输入、状态或条件分支。只要职责链产生可发布 candidate，current `publish-mr` 就固定执行：candidate
validation → platform commit → CAS push → MR ensure → checkpoint/rematerialize。指定工作分支只替换 source branch/baseline/CAS expected
head，不改变这条职责链。回归必须锁住 current terminal/context/effect suggestions、MR care 与反馈/冲突修复后续均不变。

## 6. 查询与页面

Case detail projection 增加 source-neutral `advanced`：

```ts
interface EmployeeCaseAdvancedViewV1 {
  readonly limits: {
    readonly maxDurationMs: number | null
    readonly consumedDurationMs: number
    readonly maxTotalTokens: number | null
    readonly consumedTotalTokens: number
  }
  readonly collaborators: readonly EmployeeCaseMemberView[]
  readonly typeOptions: readonly {
    readonly controlId: TaskCreationAdvancedControlId
    readonly label: string
    readonly value: string
  }[]
}
```

通用 query 只投影 type descriptor 允许公开展示的 control/value，不理解分支业务。研发类型 detail participant 继续提供 candidate/delivery
事实。UI 在任务概览展示 limits remaining、协作者与实际 source branch；发布结果继续使用现有 commit/MR 状态，不新增开关、模式或未发布终态。

## 7. migration 与 rolling compatibility

1. 选择实现时尚未占用的下一 migration 编号；不得与并行 RFC-335 的 journal/SQL 混写。
2. 新 Case 列全部 expand-only；旧 binary 忽略新列，新 binary 将 NULL/0 解释为 legacy defaults。
3. metering ledger 空表示存量 Case 无已知用户计量；由于存量 max 均 NULL，不需要回算历史 token/duration。
4. primary Context schema revision 只对新 Case 写工作分支 option；旧 revision codec 继续生成 current default branch，发布行为不变。
5. rolling test 覆盖 old schema → new binary、new schema/legacy rows → new binary；rollback 不删除列/ledger。

## 8. 关键不变量

- 每个 Case 的 limit totals 等于 ledger 唯一 receipts 的求和。
- 每个 terminal Reaction execution 恰有一个 metering receipt；retry execution 各自有一个，replay 不重复。
- 用户 remaining 不得为负后仍创建新 Round。
- collaborator 创建与 Case admission 同事务。
- typeOptions 提交 key set 必为 pinned descriptor 子集，规范化后 exact type codec 接收。
- source branch 只由 type Context/typed plan 消费；通用 runtime 无开发类型分支。
- 数字员工 UI/wire/Case/type options 不存在 `autoCommitPush`；平台 publish-mr 固定执行。
- 所有字段空或显式工作分支时，current candidate→commit→push→MR journey 均逐项保持。

## 9. 测试矩阵

### 9.1 前端

- shared component：编排五项/数字员工四项 capability 矩阵、visible errors、键盘展开/focus、disabled/pending、summary builder；
- 编排回归：scratch/remote、pref、payload、确认回跳；
- 数字员工：无 capability/有 capability、employee/type 切换、协作者、非法 branch/limits、payload 与摘要；
- RTL narrow viewport + 浏览器 E2E 真实点击，确认唯一 Host/Stepper，切来源无 stale values。

### 9.2 DigitalEmployee domain/store/runtime

- strict advanced/default/digest/unknown/type mismatch；
- Case + members + uploads + Context 原子故障注入；
- metering ledger duplicate/crash/retry/overflow；
- duration/token remaining、多轮、failure retry、human/event/child wait exclusion；
- user limit vs policy round/case limit 的先后矩阵；
- legacy/event/child Case defaults。

### 9.3 TaskExecution participant

- completed/failed/stopped 都返回 exact usage；
- human-wait deduction 与 `services/limits.ts` 对拍；
- remaining duration/token 映射到内部 Task；
- wrong execution/admission/ref 与 duplicate inspect 不制造双计量。

### 9.4 研发类型与真实远端

- blank/generated、explicit missing、explicit existing、existing MR same/different target、CAS conflict；
- blank/显式 branch 都走 current ISSUE→candidate→commit→push→MR；
- feedback/conflict repair 继续使用冻结 branch，并固定发布；
- 数字员工 DOM/wire/Context/Case 无 `autoCommitPush`；
- 通用代码无 `development` literal/source id switch 的 architecture mutation。

### 9.5 migration/架构

- migration journal/schema snapshot/rolling upgrade；
- DE→Task table read=0、TE→employee table write=0、bootstrap type branch=0；
- shared advanced component唯一、来源私有高级 JSX 重复=0；
- RFC-310 unified Host/source registration 与 RFC-294 import/public surface guards 全绿。

## 10. 实施与发布证据

- 主实现 `07c7d37b4`；归一化/来源锁定 `1c296f3a4` / `287ea50fe`；测试/架构修复
  `e2bee56ae` / `f5e7833fd` / `aa32b65ad`。六个提交均已进入 `origin/main`。
- 目标架构/合同诊断 24/24、相关 Prettier/ESLint 和 backend typecheck 通过；数字员工
  `autoCommitPush` 的 DOM/wire/state/source absence 与固定发布链由回归测试锁定。
- 最终 containing SHA `8e58eb05f` 已证明包含上述提交；其 CI run `33142147682` 35/35 成功，
  visual run `33139682210` 和 Windows run `33139296772` 均 1/1 成功。
