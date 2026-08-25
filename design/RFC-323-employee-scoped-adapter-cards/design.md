# RFC-323 数字员工按员工绑定的 Adapter 配置卡 —— design

## 0. 实施状态（2026-08-25）

- 用户已批准完整 RFC 与能力影响，并要求提交上库。
- 生产实现、定向门禁、Chromium/WebKit 旅程、system-mock 全链与 Darwin 视觉基线已闭合；远端发布与
  exact-SHA hosted CI/visual 终态尚待完成。
- 内置研发类型包由 `development@9` 追加为 immutable `development@10`。
- 研发类型包实际声明两张泳道首卡：

```text
care-pipeline / primary / pipeline-gate / requiredWhenLaneEnabled=true
care-approval / primary / approval-gateway / requiredWhenLaneEnabled=true
```

Issue provider 差异由 Integration 归一化为标准 `code-host.issue.*` 事件，Event Center 通过 source-neutral
WorkStart 投递给员工；`delivery-main` 不声明来源 Adapter。流水线与审批泳道一旦启用则必须绑定。

- Adapter 卡仍是 lane 的第一个 DOM/配置卡，但独占一条 32px 紧凑首行，只显示 `Adapter + 绑定状态`；
  WorkItem 从下一行开始并保持原有水平执行轴。完整名称、purpose 与 exact ref 通过 aria/title、状态和 Dialog 可达。

## 1. 现状盘点（`main@8ed77bbf`）

### 1.1 所有权错位

当前四层结构是：

```text
EmployeeTypePackage
  └─ TypeToolRegistration.content.connectionRef   ← Adapter 被固定在这里
EmployeeJobTemplateRevision
  └─ defaultToolBindings                          ← 只选工具
DigitalEmployeeDefinitionDraft
  └─ toolOverrides                                ← 只覆盖工具
DigitalEmployeeDefinitionRevision
  └─ exactToolBindings                            ← 只冻结工具
```

`authoringService.#validateTool` 在工具发布时解析 `requiredConnectionPurpose`，而员工编译阶段只验证工具 digest，
不会形成员工自己的 Adapter closure（`packages/backend/src/modules/digital-employee/application/authoringService.ts:1220-1275,2000-2100`）。
所以“工具弹窗里选连接”只是视觉上像员工配置，数据上仍是共享工具配置。

### 1.2 泳道没有配置资源槽

`responsibilityLaneSchema` 只有 `laneId / label / description / order / kind / optional`
（`packages/backend/src/modules/digital-employee/domain/model.ts:218-227`）。`EmployeeCapabilityPanorama` 只投影
ingress、work item、review/dispatch 与 lane sort handle；没有“配置卡但非 work item”的概念。

### 1.3 Adapter 运行合同不闭合

`DevelopmentAdapterContent` 已声明：

```ts
executableRef
parameterSchemaRef
connectionRef
secretProjection
outputBudget
timeoutMs
```

但 runner 的 `adapterContent` 只取 `executableRef + timeoutMs`。`connectionRef` 与 `secretProjection` 既不校验
部署可用性，也不进入子进程。pipeline runner 的装配注释也写明“真实内网 adapter 的 connectionRef 语义走后续批次”。

### 1.4 旧界面是孤立的第二信息架构

`/code` 已重定向 `/digital-employees`，但 router 仍独立注册：

- `/code/executors`；
- `/code/config/$kind`（其中 `kind=adapters`）；
- `/code/config/$kind/$id`。

Adapter 因而同时存在于“分类工具弹窗的连接下拉”和“隐藏的全局资源页”两处，且两处都没有表达“岗位默认、员工覆盖”。

## 2. 目标领域合同

### 2.1 类型包声明 LaneAdapterSlot

Adapter slot 是泳道的配置依赖，不是执行节点：

```ts
const laneAdapterSlotSchema = z
  .object({
    slotRef: machineIdSchema,
    label: localizedTextSchema,
    description: localizedTextSchema,
    purpose: z.enum(['pipeline-gate', 'pipeline-classifier', 'approval-gateway']),
    requiredWhenLaneEnabled: z.boolean(),
  })
  .strict()

const responsibilityLaneSchema = z
  .object({
    // existing fields...
    adapterSlots: z.array(laneAdapterSlotSchema).max(10).default([]),
  })
  .strict()
```

不把 `adapterSlots` 写在 WorkContract 上：一个 Adapter 被泳道内多个动作共享，WorkContract 只描述动作输入输出；若每个动作
分别声明，就会重新出现 submit/observe 各配一遍的问题。

类型包校验新增：

- 同一 lane 内 `slotRef` 与 `purpose` 分别唯一，避免运行时按 purpose 解析时出现二义性；
- spine/branch 均可声明；消费关系由 WorkContract 的 `requiredConnectionPurpose` 精确选择。允许先声明可选 slot
  再分阶段接入 consumer，不用反向“必须已有消费者”的静态假设阻断迁移；
- purpose 必须是 Integration 公共 closed union；
- `requiredWhenLaneEnabled=true` 的 slot 必须进入员工发布闭包门禁；
- Adapter slot 不得出现在 `nextWorkItemRefs`、ReactionRule 或 WorkContract 节点集合。

研发分类本次声明：

```text
care-pipeline / primary / pipeline-gate
care-approval / primary / approval-gateway
```

`pipeline-classifier` 的历史 Adapter purpose 保持 API/runtime 兼容，但本 RFC 不把业务问题分类重新外包给 Adapter。
Integration 中旧 Development Mission 的 `requirement-source` purpose 同样保留兼容；它不属于数字员工 lane
purpose，也不从标准 Issue 入口生成员工 binding。

### 2.1.1 标准 Issue 入口边界

```text
GitHub/GitLab webhook
  → Integration provider mapping
  → code-host.issue.labeled / code-host.issue.comment-received
  → standard code-host.issue subject + issue_iid/title/body/url/labels
  → Event Center response rule
  → source-neutral DigitalEmployeeWorkStartPort
  → EmployeeCase
```

因此 UI 输入 Issue、Webhook Issue 与后续评论唤醒都不需要员工侧 Adapter。“手工输入 Issue ID”作为 v3
标准 WorkRequest 交给材料准备工具；工具只得到标准 ID 与材料目录，不得到 provider Adapter/connection。若需反查正文，
只能消费平台标准 Issue 服务，禁止借员工 `connectionRef` 恢复一条隐藏 provider 抓取链路。

### 2.2 AdapterBinding

```ts
export const laneAdapterBindingSchema = z
  .object({
    laneId: machineIdSchema,
    slotRef: machineIdSchema,
    adapterRef: exactResourceRefSchema,
  })
  .strict()
```

键是 `(laneId, slotRef)`，而不是 workItemRef；同一泳道后续动作由 type package 决定消费哪个 slot。

三层内容增加：

```ts
EmployeeJobTemplateContentV1 {
  defaultAdapterBindings: LaneAdapterBinding[] // default [] for old JSON
}

DigitalEmployeeDefinitionDraftV1 {
  adapterOverrides: LaneAdapterBinding[]       // default []
}

DigitalEmployeeDefinitionContentV1 {
  exactAdapterBindings: LaneAdapterBinding[]   // compiled/frozen
}
```

无需新增数据库列：三者现存均为 canonical JSON revision；新增字段以 schema default 读取旧 JSON，新发布 revision 必须显式写出。

### 2.3 合并与发布算法

新增纯函数：

```ts
mergeExactAdapterBindings({
  manifest,
  jobDefaults,
  employeeOverrides,
  enabledWorkItemRefs,
}): { bindings: LaneAdapterBinding[]; violations: BindingViolation[] }
```

规则：

1. 收集 manifest 的 `(laneId, slotRef)` 闭集；未知键拒绝。
2. 岗位 default 先写，员工 override 按同 key 覆盖；每层重复键拒绝。
3. 由 `enabledWorkItemRefs` 推导启用泳道。必填 slot 只在对应泳道启用时要求存在。
4. 每个 exact ref 通过 Digital Employee consumer-owned `ToolConnectionCatalogPort` 解析；检查存在、purpose、available、
   actor visibility 与 published revision。
5. 读取 Adapter content digest，但不把 executable/connection/secret 内容带回 Digital Employee。
6. canonical 按 `laneId\0slotRef` 排序。
7. `compiledClosureDigest` 加入 `adapterBindings + adapterContentDigests`。

员工 revision 保存 exact refs；Case admission 只读取员工 revision，不回看岗位草稿或 Adapter current revision。

### 2.4 TypeToolRegistration 的收缩

新工具 authoring body 删除 `connectionRef`；`ToolRegistrationContent` 对历史 revision 暂保可选 legacy 字段：

```ts
legacyConnectionRef?: ExactResourceRef | null
```

实现时不重命名已发布 JSON 字段，不改历史 digest；读 projection 把旧 `connectionRef` 解释为 legacy。所有新 create/revise：

- body 出现 `connectionRef` ⇒ `tool-connection-moved-to-employee-binding`；
- tool validation 不再解析 Adapter；
- 只有流水线与审批 WorkContract 的 `requiredConnectionPurpose` 迁为对应 lane Adapter slot；标准 Issue
  材料合同不要求连接；
- tool contract fixture 验证只验证工具本身。

这使工具真正成为可跨岗位/员工复用的实现。

## 3. 历史兼容与迁移

### 3.1 不改写 immutable revision

禁止 migration 原地改 `employee_tool_registration_revisions.content_json`、job/employee revision JSON 或 digest。

### 3.2 Legacy binding projection

旧岗位/员工没有 Adapter binding 时，编译新员工 revision可做一次确定性投影：

1. 解析最终 exact tool bindings；
2. 对每个启用且仍声明的 lane slot 找匹配 purpose 的历史工具 `connectionRef`；标准 Issue 来源不参与投影；
3. 只有候选集合恰好为一个 exact ref 才投影；
4. 零候选 ⇒ `adapter-binding-missing`；多候选 ⇒ `legacy-adapter-binding-ambiguous`，要求用户在卡片中选择，禁止按数组首项猜；
5. 新 revision 显式写入 `exactAdapterBindings`，以后不再走 legacy projection。

历史已发布员工 revision与在途 Case继续按其工具 revision 的 connectionRef 回放；只在创建新 Case、且员工 revision 已包含
`exactAdapterBindings` 时走新路径。完成受支持的自动升级后，增加退役棘轮：新 type/job/employee revision 不得再产生 legacy 字段。

### 3.3 类型包升级

研发类型包已发布候选 immutable revision `development@10`：

- lane 增 `adapterSlots`；
- `prepare-materials` 升为 v3 标准工作请求合同，输入不再包含来源 connection；
- approval `prepare` WorkContract 不再自己要求工具连接；
- pipeline `collect` 改由平台 system participant 执行；
- auto-upgrade 仅在旧绑定能唯一投影时完成；歧义员工保持旧 revision 并显示人工迁移原因。

## 4. 运行数据流

### 4.1 计划装配

`DigitalEmployeeRuntimeService` 在构造 round plan 时：

1. 用 work item 的 `responsibilityLaneId` 找 lane；
2. 根据 WorkContract 的 `requiredConnectionPurpose` 在该 lane 找唯一 Adapter slot，再从员工
   `exactAdapterBindings` 读取同一 `(laneId, slotRef)`；
3. 把 secret-free exact ref 写入 `ReactionExecutionPlan.connectionRef`；
4. 对不消费 Adapter 的 work item 固定为 null；
5. exact ref 进入 execution nonce/digest，避免同一 round 偷换连接。

`connectionRef` 不再取 `tool.content.connectionRef`。Digital Employee 仍只看到 exact identity，不得到 executable/endpoint/secret。

### 4.2 Standard Issue ingress

Issue 取得与 provider 归一化不是员工职责，也不经过员工 Adapter binding。生产序列是：

```text
provider webhook / platform Issue query
  → Integration standard Issue envelope
  → Event Center response rule
  → WorkStart body + repository target + event origin
  → EmployeeCase prepare-materials
```

标准 envelope 承载 `issue_iid/title/body/url/labels`；Event Center 模板只消费这些 provider-neutral 字段。
数字员工计划中的 `connectionRef` 对交付 WorkItem 固定为 null。旧 Development Mission 的 requirement-source
runner 可继续回放历史任务，但不得投影成 `development@10` 的 lane slot、默认 binding 或员工 override。

### 4.3 Pipeline

目标序列：

```text
lane binding (pipeline-gate exact ref)
  → platform collect-pipeline system work item
  → Integration PipelineEvidenceParticipant.collect
  → typed adapter runner + one-shot sink
  → safe-walk/import + exact head evidence context
  → classify-pipeline business tool
```

`collect-pipeline` 不再运行用户 ToolRegistration。自定义企业采集逻辑迁到 typed Adapter executable；分类和修复仍是工具。
平台拒绝 Adapter 输出的 business decision、next action、agent/tool selector。pending/running 事实返回后由 Attention/wake 机制下一轮再采，
不在一个 Agent/Program 里睡 20 分钟。

平台还把“暂时无法证明当前性”与“已证明门禁失败”严格分开：MR 缺 repository/provider ref、目标 SHA 尚未冻结、
前后两次 MR facts 无法通过 exact head/target fence，或 Adapter 返回 stale-input 时，都只写 pending 并等待下一次 wake，
不得伪造零 SHA、调用 provider 后误判失败，或把员工永久阻塞。只有 fence 成功后的当前证据才进入门禁判断。
`requiredGates=[]` 在导入任何 provider 文件前直接 blocked；脱敏失败同样在 EvidenceStore 导入前 fail closed，避免失败结果
残留未脱敏字节。每次成功导入都落到包含 `bundleId` 的独立 namespace，后续轮次即使返回同名日志也不能覆盖早先
round 已引用的不可变证据。

### 4.4 Approval

```text
lane binding (approval-gateway exact ref)
  → prepare-approval tool receives ref + MR facts, emits draft only
  → platform submit: lookup-by-idempotency-key → submit if absent
  → durable saga stores adapter id/revision + correlation/deadline
  → platform observe on webhook/timer/manual wake
```

草稿 Context 的 `adapterRef` 必须逐字等于员工冻结 binding；submit/observe 继续校验 intent digest、correlation 与 observed revision。
审批只在 `collect-pipeline` 泳道启用时等待 terminal current pipeline evidence；审批泳道独立启用而流水线泳道关闭时，
不会制造一个永远等不到的前置条件。GitLab EE 优先使用 approvals API 的 `approvals_left`；GitLab CE 的聚合
`approved=false` 只有在存在显式 reviewer 时才表示 hold，没有 reviewer 的项目返回 unknown，使企业审批 Adapter 可以接管，
而不是由平台凭一个 CE 缺省布尔值臆造审批阻塞。

## 5. Adapter runner 的连接与 secret 投影

### 5.1 AdapterContent 真正进入 runner

`AdapterRunInput.adapterContent` 扩为：

```ts
{
  executableRef: string
  connectionRef: string | null
  secretProjection: readonly string[]
  timeoutMs: number
}
```

schema 将 secret key 收紧为 portable env identifier：`^[A-Z_][A-Z0-9_]{0,255}$`。已发布历史 revision 若含不合法 key，
仍可读取但 readiness blocked，不能把任意字符串写进 env。

### 5.2 最小环境

runner 仍从空对象构造 env：

```ts
PATH, HOME, TMPDIR
AW_ADAPTER_SINK
operation-specific AW_* inputs
AW_ADAPTER_CONNECTION_REF // only when non-null
...projectedSecrets       // exact declared keys only
```

对每个 `secretProjection` key：

- 从 daemon boot environment snapshot 读取；
- 缺失 ⇒ `adapter-secret-projection-missing`，`after-configuration`，spawn 前返回；
- 值不写 DB、receipt、stdout、stderr、audit 或 log；
- 未声明的 daemon env 永不继承；
- `extraEnv` 仅测试装配使用，生产 composition 不接受用户输入。

本 RFC 不新增数据库 secret store。`connectionRef` 是 adapter 自己解释的非秘密连接标识；实际 token 仍由部署环境给出。

## 6. 前端投影

### 6.1 `LaneAdapterCard`

`EmployeeCapabilityPanorama` 新增显式 props，而不是伪造 WorkItem：

```ts
interface LaneAdapterCardProjection {
  laneId: string
  slotRef: string
  label: LocalizedText
  purpose: string
  state: 'configured' | 'inherited' | 'missing' | 'unavailable'
  detail: string
  exactRef: ExactRef | null
}

laneAdapterCards?: readonly LaneAdapterCardProjection[]
onSelectLaneAdapter?: (card: LaneAdapterCardProjection) => void
```

布局把卡片放在本 lane `primaryEntries` 之前，但使用独立 kind `configuration`：

- 固定 100px 宽、32px 高，独占紧凑首行并左对齐；WorkItem 下一行仍沿原执行轴，配置卡不画 sequence arrow；
- 可见信息只保留 `Adapter` 与紧凑绑定状态；业务用途由泳道标题表达，完整名称/精确引用进入 aria/title/Dialog；
- `data-lane-adapter-slot="<lane>/<slot>"` 供测试；
- 不计入 WorkItem 数、next step、dispatch、review branch、running state；
- runtime 只读显示本 Case 冻结 ref；authoring 视图按权限可点击。

### 6.2 三个 authoring 语境

| 语境             | 卡片行为                                                     |
| ---------------- | ------------------------------------------------------------ |
| 分类工具箱       | 点击管理当前 purpose 的 Adapter 资源，不选择或绑定员工/岗位  |
| 岗位模板职责图   | 点击设置 `defaultAdapterBindings`，显示“岗位默认”            |
| 具体员工职责配置 | 点击设置/清除 `adapterOverrides`，显示“继承岗位”或“员工覆盖” |

分类工具箱与工具卡采用同一层次：点击后列出当前 slot purpose 下未归档的 Adapter 资源，并提供权限受控的新建、编辑、
发布、归档与 ACL 入口；这里没有员工/岗位选择，不产生跳转，也不保存 Adapter binding。实际写路径、校验与发布闭包仍
只有岗位默认和员工覆盖两条；这两个编辑器已经携带明确对象上下文，点击卡片直接进入同一个
`LaneAdapterBindingDialog`。

员工列表每张员工卡新增“配置职责”次要动作；打开复用的紧凑职责 Dialog，work item 只读，只有 Adapter 卡与既有允许的员工 override
可编辑。创建员工仍保持名称/岗位/范围的短链；创建成功后若岗位必需 Adapter 缺失，则引导进入职责 Dialog，而不是把 20 张卡塞进首个表单。

### 6.3 最小 Dialog 与资源管理

主 Dialog：

- 标题使用 lane 业务名，如“企业审批连接”；
- `Select` 只列匹配 purpose 的已发布 Adapter；
- 显示 `继承岗位 / 员工覆盖` chip、资源名、vN、available；
- 员工语境提供“恢复岗位默认”；岗位语境提供“不启用此可选能力”（仍受 lane closure 验证）；
- 保存 binding 不修改 Adapter resource。

次级“新建/管理连接”仅授权用户可见：

- 默认：名称、标为“可执行文件 / 脚本路径”的 executableRef；控件明确说明不填写代码、不接受带参数的
  Shell 命令，purpose 与 required operations 由 slot 固定；
- 高级：connectionRef、secret key chips、timeout/output budget；
- 版本发布、归档、ACL 继续调用现有 Integration API；
- 无 raw JSON 编辑器；所有 domain 支持字段必须有 guided 控件；
- 输入 Dialog `closeOnOverlayClick={false}`，保存后刷新 picker 并选中 exact published revision。

## 7. 旧界面退役

### 7.1 路由

保留三个无 UI redirect route，避免书签白屏：

```text
/code/executors                 → /digital-employees
/code/config/adapters           → /digital-employees
/code/config/adapters/$id       → /digital-employees
```

删除：

- `code.executors.tsx` 的页面实现；
- generic code config 的 Adapter kind 分支、Adapter summary/editor/raw JSON；
- Adapter 专属 CSS/i18n/test/visual fixture；
- router 中旧页面 import，替换为轻量 redirect routes；
- capability/route ledger 中“页面仍可用”的声明，改登记 redirect 与新卡片能力。

`/code/config/{employees,action-templates,verification-profiles}` 是否仍保留由各自现行消费决定，本 RFC 不顺带删除；动态 route 收到
`kind=adapters` 必须在 data fetch 前 redirect，不能短暂渲染旧壳。

### 7.2 退役棘轮

新增源代码守卫：

- router 不得把三个 URL 指向旧 page component；
- frontend production 不得出现 `CONFIG_KIND_SPECS.adapters`、Adapter raw JSON editor 或 `/code/executors` 页面 DOM testid；
- AddToolDialog 不得渲染 Adapter picker；
- Lane Adapter Card 必须是唯一业务 UI 管理入口。

## 8. API 与权限

### 8.1 既有 Adapter API 保持

`/api/integrations/development-adapters` 的 list/get/create/revise/publish/archive/ACL 保持 Integration owner，不搬到
`/api/digital-employees`。新 Dialog 只是该 API 的 in-context adapter。

### 8.2 Job/Employee wire 扩展

现有 body 增字段：

```ts
create/update job:      defaultAdapterBindings?: LaneAdapterBinding[]
create/update employee: adapterOverrides?: LaneAdapterBinding[]
```

旧客户端省略时等于 `[]`。响应投影同时返回 default/override/exact binding 与来源摘要，但不返回 Adapter content、executable 或 secrets。

### 8.3 权限

- 选择现有 Adapter：必须能看见该资源；员工/岗位保存仍需各自 update 权限。
- 新建：`adapter-definitions:create + scripts:author`。
- 修改/发布：resource ownership/grant + `adapter-definitions:update + scripts:author`。
- 归档：既有 archive 权限；若仍被任何 current published job/employee revision 引用，允许 archive 但 readiness/新发布 blocked，历史回放仍取 revision。
- ACL：沿用 `development_adapter` resource ACL，不新增泳道私有授权旁路。

## 9. RFC-294 对齐

- `digital-employee` domain 只新增中性 `LaneAdapterSlot/Binding` 值对象与合并纯函数；不 import Integration 内部。
- Digital Employee application 继续只依赖 consumer-owned connection catalog/participant port；Adapter exact identity/purpose/availability/digest
  通过公开合同返回，executable/connection/secret 不跨界。
- `integration` domain/application/infrastructure 继续唯一拥有 AdapterDefinition、运行 codec、secret projection 与子进程。
- `development-automation` 类型包只声明 lane slot 和 work-item→slot 消费映射，不读 Adapter 表或执行文件。
- HTTP routes 只解析 body/authority 并调用 application command，不新增 route→DB。
- bootstrap 只装配 Digital Employee required port 到 Integration public participant；不在 `server.ts` 写 purpose/业务判断。
- 承担的架构演进：把当前 ToolRegistration→Integration 的错误所有权边移到 Employee compiled closure；补齐 Integration runner 已声明未消费的
  connection/secret 合同。
- 留下的债：通用 sealed Integration credential store 不在本 RFC；部署环境 secret projection 仍是第一版供给方式。

## 10. 失败模式

| 场景                                               | 行为                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 岗位启用 pipeline/approval lane 但未配必需 Adapter | 岗位可存草稿，发布/员工编译 fail closed，并定位到 lane card                                         |
| 员工覆盖指向未发布/不可见/归档 Adapter             | 保存/发布拒绝，不回退岗位默认，避免界面显示覆盖但运行偷用默认                                       |
| Adapter 发布新 revision                            | 旧岗位/员工 exact ref 不变；UI提示有新版本但不自动升级                                              |
| 历史工具给同一 lane 推导出两个不同 connectionRef   | 自动升级拒绝 `legacy-adapter-binding-ambiguous`，要求人工选择                                       |
| daemon 缺声明 secret key                           | spawn 前 typed configuration failure，值不入日志                                                    |
| pipeline 返回 pending/running                      | 写权威 pending facts并 arm wake；不长时间占用 Adapter/Agent 进程                                    |
| Adapter outage                                     | pending Context 保持，按 failure retryability 与 Attention 再观察；不把 outage 当 approved/rejected |
| 旧 URL                                             | server-side/router redirect 到 `/digital-employees`，不请求旧 Adapter 页面数据                      |
| inline create 第一步成功、publish 失败             | Dialog 留在 draft 管理态，显示错误并允许修复/发布；不跳隐藏详情页                                   |

## 11. 测试策略

### 11.1 Domain/application

- lane slot schema：重复/未知/purpose/consumer closure；
- adapter merge：default、override、inherit、duplicate、missing、purpose mismatch、visibility、archive；
- compiled closure digest 对 Adapter ref/content digest 敏感；
- legacy projection：0/1/N 候选与 immutable JSON/digest 不变；
- job/employee wire omitted fields 兼容；
- new tool connectionRef 拒绝。

### 11.2 Runtime/integration

- 两员工同工具、不同 Adapter，round plan 精确选择各自 ref；
- 标准 Issue ingress 不创建 Adapter binding，交付 round 的 connectionRef 为 null；
- pipeline adapter collect 绑定 exact head，大 evidence safe-walk/budget 保持；
- approval prepare/submit/lookup/observe 全链同 ref；
- env allowlist：只投影点名 keys，connectionRef 正确，未声明 env 不泄漏，缺 key spawn 前红；
- pending pipeline/approval 不长阻塞、timer/webhook wake 后重入；
- daemon restart 保留 saga/deadline/ref。

### 11.3 Frontend

- Adapter card 是 lane 第一张配置卡但不计入 work item；
- job default、employee inherit/override/restore；
- default Dialog 字段最小；权限矩阵；二级 create/edit/publish/archive/ACL；
- overlay click 不关闭有输入弹窗；
- old URLs redirect before fetch；
- AddToolDialog 无 connection field；
- 1280×900、720×800、窄屏无横向溢出/文字裁切；
- axe、键盘、焦点返回。

### 11.4 E2E/守卫

- system mock 两员工同一工具分别调用两个 adapter endpoint；
- pipeline 20 分钟语义用可控 pending→passed observation，不真实 sleep；
- approval pending→approved 与 rejected；
- route/capability ledger 更新；
- deleted UI/source/testid 负 fixture 防复活；
- hosted CI 作为全仓权威门禁，视觉差异按现行审图流程处理。
