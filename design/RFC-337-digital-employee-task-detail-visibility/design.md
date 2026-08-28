# RFC-337 设计 — 数字员工任务详情的信息架构与交付可见性

配套 `proposal.md`。当前状态：Done；用户已于 2026-08-28 批准 D1–D7，实现已发布并通过远端 CI。

## 1. 不变量

| ID  | 不变量                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------ |
| I1  | authoring 入口表示“可以怎样启动”；runtime 入口表示“这个 Case 已经怎样启动”，两者不可混用。                         |
| I2  | 一个 Case 只有一个已冻结的 work intake；运行态职责图因此恰好只有一张输入卡。                                       |
| I3  | 页面展示的输入来自 durable Context，不从当前创建表单、路由参数或类型默认值重建。                                   |
| I4  | workspace row 是 baseline/target/source branch 的运行时事实；MR Context 是 code-host 交付事实，两者不得互相覆盖。  |
| I5  | MR 链接只使用已保存的 `webUrl`；编号或 provider ref 不被拼成猜测 URL。                                             |
| I6  | 共享数字员工 UI 只消费规范化 projection；不按类型 ID、region ID 或研发 work item ID 分支。                         |
| I7  | 类型拥有的详情 presenter 是只读 participant，不成为第二个 Case/Context writer，也不是 runtime codec 的 DB 逃生门。 |
| I8  | 页签只改变呈现，不改变 Case、Context、Attention、Round、Workspace 或 MR 生命周期。                                 |
| I9  | 大正文、JSON 和路径列表在有高度上限的内部滚动区完整呈现；页面自身不再靠无限纵向展开承载信息。                      |

## 2. source pin 上的事实链

### 2.1 HTTP 与通用 Case 投影

```text
GET /api/employee-cases/:id
  -> DigitalEmployeeRuntimeService.project(caseId)
       -> get Case
       -> list Context / Attention / Inbox / Reaction Round / Channel
       -> project capabilityActivation / reviewGates / nextAction
  -> employee-cases.$caseId.tsx
```

当前 `project()` 已经集中取得 Case、全部 Context 和 Round，却没有类型拥有的详情投影，也没有工作区只读
participant。前端接口没有 `launchOrigin/detail`，只能逐张 Context 卡渲染。

### 2.2 输入事实

`employeeWorkIntakeSchema` 定义 `kind/target/body/externalId/uploads/executionOptions`。研发 runtime codec 在
`buildInitialCaseJson()` 中把这些值写入 `development.issue-handling` Context：

```text
repositoryRef
request.kind
request.body
request.externalId
request.executionOptions
request.uploads[].{artifactRef,placement,targetPath,originalName}
```

Case row 同时保存 `launchOrigin = manual | scheduled | event | webhook | api`。详情不需要新增输入存储。

### 2.3 工作区事实

`employee_case_workspaces` 已保存：

```text
caseId / repositoryId / cachedRepoId / baselineSha
targetBranch / sourceBranch / remoteHeadSha / state / timestamps
```

工作区第一次物化时，repository preparation 返回仓库默认分支，source-control 解析 baseline，研发 adapter
将精确结果写入该 row。该事实不属于 Context，通用 Case route 当前看不到它。

### 2.4 修改候选与 MR 事实

`development.change-candidate` Context 已保存 `status/candidateRef/baselineSha/treeOid/summarySource/
changedPaths/commitSha`。

`development.merge-request` Context 已保存：

```text
status / mergeRequestRef / providerMrRef / webUrl
repositoryRef / sourceBranch / targetBranch
headSha / targetSha / mergedCommitSha
draft / mergeableState / readyToMerge / approvalHold / unresolvedReviewCount
```

现有 `projectionFields` 只暴露 MR ref/head/ready，页面因此丢掉链接和分支，而非运行时没有这些数据。

### 2.5 当前前端误接线

运行态 route 仍向 `EmployeeCapabilityPanorama.onConfigureIngress` 传入：

```text
task-creation        -> /tasks/new?kind=digital-employee
event-response-rules -> /events?tab=subscriptions
```

`ResponsibilityIngressCard` 的动作文案也固定为“去新建任务 / 去 Webhook 配置”。这条接线在 authoring 合理，
在已创建 Case 上不成立。

## 3. ownership 与模块边界

### 3.1 `digital-employee`

继续拥有：

- Case/Context/Round/Attention/Inbox/Channel 通用查询；
- `GET /api/employee-cases/:id` 的组合投影；
- 新的规范化 `EmployeeCaseDetailProjectionV1` schema；
- consumer-owned `EmployeeCaseDetailProjectionParticipant` required SPI 与 presenter registry；
- generic artifact ref 来源合并、participant 输出校验和 fallback。

`digital-employee` 不读取 `employee_case_workspaces`，也不解析 `development.*` Context 私有字段。

### 3.2 `development-automation`

提供 `development` 类型的只读 presenter adapter：

- 按 schema version 解析 issue/change-candidate/merge-request Context；
- 读取当前已有 `employee_case_workspaces` read model；
- 输出规范化 input/workspace/changeCandidate/delivery 与相关 region/work item refs；
- 对旧类型修订使用显式兼容分支，未知 schema version 返回稳定 partial projection。

该 presenter 与 `developmentEmployeeRuntimeCodec` 分离。runtime codec 仍是纯函数且没有 DB access；presenter 只读，
不得写 Case/Context/workspace/MR，也不得调用执行器或代码平台。

### 3.3 `source-control` 与 repository catalog

仓库显示名继续复用现有 `/api/cached-repos` projection：前端以 `repositoryRef` 查 `urlRedacted/defaultBranch`。
详情 participant 不复制 repo catalog，不读取凭据，也不返回本地路径。

工作区 row 的最终 owner 迁移仍留给 RFC-294 W5；本 RFC 只经 development-owned presenter 暴露当前 read model，
不宣称完成 workspace owner cutover。

### 3.4 frontend

`employee-cases.$caseId.tsx` 负责页签编排和 Case 特有组合；`EmployeeCapabilityPanorama` 与
`ResponsibilityFlowDisplay` 只增加通用 presentation props：runtime ingress 和外部资源动作。共享组件不认识 MR。

## 4. 规范化详情合同

`GET /api/employee-cases/:id` 维持原端点，additive 增加 `case.launchOrigin` 与 `detail`。不建立第二个“详情”
endpoint，避免两个轮询快照互相错位。

示意合同如下；实现以 strict schema 为准：

```ts
type EmployeeCaseDetailProjectionV1 = {
  schemaVersion: 1
  input: {
    source: 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'
    ingressRef: string | null
    kind: 'body' | 'files' | 'body-and-files' | 'external-id' | 'event' | 'unknown'
    subjectRef: string | null
    repositoryRef: string | null
    body: string | null
    externalId: string | null
    uploads: Array<{
      artifactRef: string
      originalName: string
      placement: 'repository' | 'temporary'
      targetPath: string | null
    }>
    executionOptions: Record<string, boolean>
  }
  workspace: null | {
    repositoryRef: string
    cachedRepositoryRef: string
    baselineSha: string
    targetBranch: string
    sourceBranch: string
    remoteHeadSha: string | null
    state: 'active' | 'published' | 'released'
  }
  changeCandidate: null | {
    status: 'prepared' | 'committed' | 'published' | 'obsolete'
    candidateRef: string
    baselineSha: string
    treeOid: string
    summary: string
    changedPaths: string[]
    commitSha: string | null
  }
  delivery: null | {
    kind: 'merge-request'
    status: 'active' | 'merged' | 'closed'
    ref: string
    providerRef: string | null
    webUrl: string | null
    repositoryRef: string | null
    sourceBranch: string | null
    targetBranch: string | null
    headSha: string
    targetSha: string | null
    mergedCommitSha: string | null
    draft: boolean
    mergeableState: 'mergeable' | 'conflict' | 'unknown'
    readyToMerge: boolean
    approvalHold: boolean | null
    unresolvedReviewCount: number
    relatedRegionRefs: string[]
    relatedWorkItemRefs: string[]
  }
  artifacts: Array<{
    ref: string
    sources: Array<
      | { kind: 'input' }
      | { kind: 'context'; contextId: string }
      | { kind: 'round'; roundId: string; executionRef: string | null }
    >
  }>
}
```

### 4.1 participant 输入与输出

required SPI 只收到 immutable query snapshot：

```ts
interface EmployeeCaseDetailProjectionParticipant {
  readonly typeId: string
  projectJson(inputJson: string): string
}

type ParticipantInputV1 = {
  schemaVersion: 1
  case: {
    id: string
    typeRef: { typeId: string; revision: number }
    launchOrigin: 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'
    primaryContextId: string
  }
  contexts: Array<{
    id: string
    typeId: string
    schemaVersion: number
    stateJson: string
    artifactRefs: string[]
  }>
  rounds: Array<{
    id: string
    executionRef: string | null
    outputJson: string | null
  }>
}
```

participant closure 可通过自己的 read query 取得 workspace；不能取得通用 runtime store 或 writer。输出回到
`digital-employee` 后必须经过 exact strict schema；非法输出让请求返回明确 projection error，不把任意 JSON 透传前端。

### 4.2 generic fallback

未注册 participant、旧 schema 不可解释或部分 Context 缺失时：

- `detail.input` 仍构造一张 `kind='unknown'`、source 来自 Case 的 completed 卡；
- generic artifact refs 仍从 Context/Round envelope 合并；
- workspace/changeCandidate/delivery 为 `null`；
- 页面展示“此历史任务没有结构化详情”，并保留原始 Context 技术记录；
- 绝不退回 authoring 的三张入口卡。

## 5. 输入投影与运行态职责图

### 5.1 ingress 选择

development presenter 按以下优先级映射：

| 冻结事实                                 | runtime card                                |
| ---------------------------------------- | ------------------------------------------- |
| `launchOrigin=event`                     | 类型声明的 event ingress；kind 显示 `event` |
| `request.kind=external-id`               | 外部编号 ingress                            |
| `request.kind=body/files/body-and-files` | direct task-creation ingress                |
| 无法映射                                 | 单一 generic ingress                        |

`ingressRef` 只用于把卡放回职责图正确位置；正文、ID、文件等实际值来自 `detail.input`，不来自入口描述符。

### 5.2 共享组件 props

新增通用 runtime presentation：

```ts
type ResponsibilityRuntimeIngress = {
  ingressRef: string | null
  label: string
  valueLabel: string
  description: string
  state: 'completed'
  detail: string
}

type ResponsibilityExternalAction = {
  href: string
  label: string
  title?: string
}

EmployeeCapabilityPanoramaProps += {
  runtimeIngress?: ResponsibilityRuntimeIngress
  onSelectRuntimeIngress?: () => void
  externalActionForRegion?: (regionRef: string) => ResponsibilityExternalAction | null
  externalActionForWorkItem?: (workItemRef: string) => ResponsibilityExternalAction | null
}
```

存在 `runtimeIngress` 时：

- 不调用 `projectWorkIngresses()` 生成所有 authoring choices；
- 恰好投影一张 source card；
- `ResponsibilityIngressCard` 使用 completed class/StatusChip，动作语义为“查看已接收输入”；
- 点击只调用 `onSelectRuntimeIngress`；`onConfigureIngress` 在 Case route 不再传入。

authoring/job template 调用方不传 `runtimeIngress`，原有多入口与配置动作完全保持。

### 5.3 不嵌套交互控件

现有责任卡本体是 `<button>`。MR 外链不能嵌入 button。`ResponsibilityFlowDisplay` 使用卡片 wrapper，把
`<a>` 作为 button 的 sibling，并给两者独立可访问名称、focus ring 和点击区域。region action 同样放在 region
header 的 sibling action slot。点击外链不触发工作项 selection；点击卡片本体仍打开工作项合同。

## 6. 仓库与分支投影

页面组合三个互不混淆的来源：

1. `detail.input` / primary Context：用户选中的 `repositoryRef`；
2. `/api/cached-repos`：`urlRedacted/defaultBranch` 显示信息；
3. `detail.workspace`：实际物化后的 baseline/target/source branch。

概览 target branch 规则：

```text
workspace.targetBranch 存在 -> 精确值，authority = frozen
否则 cachedRepo.defaultBranch 存在 -> 当前计划值，authority = repository-default
否则 -> null，authority = pending
```

MR 创建后，`delivery.targetBranch` 作为 MR 自己的目标分支单独显示。若 workspace 与 MR 两个非空 target
不同，页面同时显示两项并给出“工作区目标与当前 MR 目标不一致”的功能性提示，不静默挑一项覆盖另一项。

repository catalog 查询失败不让整个 Case 详情失败：显示 repositoryRef，分支仍使用 workspace exact facts。

## 7. MR 投影与链接位置

development presenter 从最新 active/terminal MR Context 投影 `delivery`，并声明当前类型的关联：

```text
relatedRegionRefs   = ['care']
relatedWorkItemRefs = ['publish-mr', 'observe-mr', 'evaluate-ready']
```

这些值只存在于类型 presenter 输出；通用 route 只按数组匹配。旧 `development@10` Case 因 presenter 按
Context schema 解释而立即获益，不修改冻结 descriptor，也不伪造新的 type revision。

链接的唯一 href 是 `detail.delivery.webUrl`。显示位置：

| 表面                      | 呈现                          |
| ------------------------- | ----------------------------- |
| PageHeader                | primary button “查看 MR”      |
| 概览事实卡                | MR ref/status/branch + button |
| 产物 MR 卡                | 完整交付 facts + button       |
| related region header     | sibling link “当前 MR”        |
| related work item card    | sibling external-link action  |
| selected work item detail | primary button “查看当前 MR”  |

所有 anchor 使用 `target="_blank"`；href 缺失时只呈现 MR ref 与稳定空态。Case 的 3 秒轮询继续作为详情更新
时钟；projection 出现 MR 后所有位置在同一 render 使用同一 snapshot 更新。

## 8. 页签信息架构

复用 `PageSectionNav/PageSectionLink`，route 增 strict search parser：

```ts
type EmployeeCaseDetailTab = 'overview' | 'details' | 'artifacts' | 'execution' | 'activity'
```

### 8.1 Overview

- PageHeader 与 Case 状态；
- nextAction NoticeBanner；
- input/repository/target branch/MR 四事实卡；
- runtime capability panorama；
- 单一 selected inspector：输入检查器、工作项合同、review/dispatch detail 互斥显示。

### 8.2 Details

- 输入完整字段；
- repository/workspace/MR branch facts；
- Case id/state/revision/timestamps/launchOrigin；
- employee/type/jobTemplate/executionPolicy exact refs；
- executionOptions、exactAdapterBindings、exactOrderedDispatchConfigurations；
- Context 业务 facts 与折叠的完整技术记录。

### 8.3 Artifacts

- change candidate：status/candidate/tree/baseline/commit/summary/changedPaths；
- current MR：全部交付 facts 与链接；
- artifact refs 去重列表；每项显示 input/context/round 来源；
- round source 有 `executionRef` 时链接到 `/tasks/$id`；
- 没有 resolver 的 artifact ref 只复制/展示稳定 ref，不冒充下载链接。

### 8.4 Execution

搬入现有时间轴及 selected round detail，不改变排序、attempt、input/output 或 Task Session 链接语义。

### 8.5 Activity

搬入 Attention、event inbox 和 employee channels；原数据与空态不变。

每个 pane 有稳定 heading/aria label。使用 `hidden` 或条件渲染保证 inactive pane 不参与布局、焦点和可访问树；
自动化查询必须限定 active pane，避免重复 test id 造成假绿。

## 9. 视觉与交互

- 关键事实使用现有 `Card/StatusChip/NoticeBanner/PageHeader/PageSectionNav`，不造第二套卡片/页签原语。
- success green 复用职责卡已有 completed runtime state；不以仅颜色表达，卡片同时有“已接收”文本/图标。
- 输入检查器、changedPaths 和 JSON 使用 bounded scroll region；正文不截断，长 token/path 可换行或横向内部滚动。
- 390px 下四事实卡单列；PageSectionNav 使用既有 compact selector；region/work-item 外链保持至少现有按钮点击面积。
- runtime ingress 选择后把 focus 移到检查器 heading；Escape 不离开页面，不把 selection 误当 Dialog。
- 外链与卡片是两个 Tab stop；Enter/Space 选择卡片，Enter 打开 MR anchor，事件互不串扰。

## 10. 失败与兼容矩阵

| 场景                                   | 页面行为                                                          |
| -------------------------------------- | ----------------------------------------------------------------- |
| participant 未注册/旧 Context 不可解析 | 单一 generic completed input；结构化详情 partial；原 Context 可读 |
| repository catalog loading/error       | 先/继续显示 repositoryRef；workspace exact facts 不受影响         |
| workspace 尚未创建                     | default branch 标“计划值”；未知则“工作区准备后确定”               |
| workspace 与 MR target 不同            | 两项都显示并提示不一致                                            |
| MR Context 不存在                      | “尚未创建 MR”，所有外链 surface 不渲染                            |
| MR ref 存在、webUrl 为空               | 显示 ref + “链接尚不可用”，不猜 URL                               |
| change candidate 不存在                | 产物页明确“尚未生成修改候选”                                      |
| artifact ref 重复                      | 一条 artifact，合并全部来源与 Session                             |
| Case terminal                          | 停止轮询，但首次/刷新 projection 仍含最终 detail                  |
| 未知 `tab`                             | canonical 回退 overview，不出现空白页                             |

## 11. 测试策略

### 11.1 backend

1. presenter 纯投影：body/files/body-and-files/external-id/event/API；exact input fields。
2. workspace read：不存在/active/published/released，repository/baseline/target/source/remoteHead exact。
3. change candidate 与 MR：全部字段、href、related region/work item refs；无 href 不伪造。
4. generic artifacts：Context/Round 重复 ref 去重、合并来源、executionRef 保留。
5. runtime service：additive `launchOrigin/detail`，participant 输出 strict validation、未注册 fallback。
6. source boundary test：route 不 import development schema/workspace table；runtime codec 仍没有 DB dependency。

### 11.2 frontend unit/component

1. tab parser、canonical fallback、`PageSectionNav` link search 与 active pane。
2. runtime panorama 恰好一张 completed ingress；authoring panorama 仍三入口；Case route 无 configure navigation。
3. 输入点击保持 pathname/search，focus 到 inspector，完整字段可见。
4. repository ID/url fallback 和 frozen/planned/pending branch copy。
5. MR href 在 PageHeader/overview/artifacts/region/work-item/selected detail 六类 surface 精确一致。
6. sibling anchor 不触发 card selection；键盘和 accessible name 测试。
7. artifact dedup/source/session 与 change path 长列表。
8. 中英文和 390px DOM/class contract。

### 11.3 E2E 与视觉

扩 `rfc310-digital-employee-journey.spec.ts` 的确定性 fixture：

- 创建 body/files 与 external-id Case，进入详情后只有一个绿色输入，点击不离页且实际值逐字段一致；
- details 读到 repo、target/source branch、execution options 和 exact revisions；
- MR 创建前为明确空态，MR Context 出现后无需刷新即在所有 surface 取得 exact URL；
- tabs 支持 deep link/back/forward，切换后 document scroll height 不再叠加所有 section；
- execution Session 既有导航与 authoring 三入口配置回归不变；
- desktop + 390px 稳定视觉场景覆盖 overview/details/artifacts 中的关键状态。

视觉测试不以手工截图代替 DOM/点击测试；DOM 测试也不代替 MR href 与实际导航断言。

## 12. 交付与验证

不需要 migration 或 type descriptor revision。实现按“projection participant → HTTP contract → shared panorama props →
Case tabs → tests”纵向完成，避免先提交一个会让主干 route/type 失配的半截。

遵循当前仓库规则：最终以包含实现的完整 SHA 查询 GitHub Actions。若结果来自 superseding SHA，先证明实现
commit 是其祖先，再报告相关 CI/visual/E2E 终态；并发无关失败与本 RFC 的目标证据分开说明。

实际发布结果：主实现 `07c7d37b4` 与后续归一化/架构修复均已进入 `origin/main`；已用
`git merge-base --is-ancestor` 证明它们都是 `8e58eb05f` 祖先。该 containing SHA 的 CI run
`33142147682` 35/35 成功，visual run `33139682210` 1/1 成功。
