# RFC-365 T1 输入兼容性对拍

2026-09-20；源码起点 `2220057676037f3e6fa0a71bf56dc2a9a05fd6a8`。只做功能兼容分析；未读取用户业务数据库，不能据此统计现存规则受影响数量。生产合同/校验/启动路径未修改。

结论：RFC-294 §3.5 草案的 V1 不能直接替换现输入。存在集合数量、UTF-8/UTF-16、字段语法、trim 和物化后大小的差异；T2 应先修订合同，再接线。不能把 HTTP 直启 schema 的限制误当成 Event Center 程序入口的限制。

## 全链字段矩阵

下表路径相对 `packages/backend/src`；shared 表示 `packages/shared/src`。

| 字段              | rule source → render                                                                                                                     | 当前 admission / writer                                                                                                                                                  | 草案 V1 与结论                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Task name         | 三 target 的 nameTemplate 1–255 UTF-16 units；renderTemplate 替换后不 trim、不再次限长                                                   | `taskRouteLaunchOperations.ts` 三臂最终 `StartTaskSchema` / `TaskNameSchema` trim 后 1–255 UTF-16 units                                                                  | code points 会扩大非 BMP 名字能力，不是等价；保留当前单位及 downstream trim                                           |
| Workflow inputs   | record 键 1–160 UTF-16 units；每个模板 ≤65536 units；无 256 项上限；展开可大于模板                                                       | `assertWorkflowLaunchInputs` 校验已声明 key、required 与各字段自带 maxLength/count/enum/git；`StartTaskSchema.inputs` 无统一长度/集合上限                                | ≤256、每值 ≤64 KiB UTF-8 都是新增收缩；key trim 可能改变字段身份                                                      |
| Agent inputs      | 与 Workflow source 同限额；空 map 在 render 时省略，非空保留所有 key                                                                     | `validateAgentLaunchShape` 匹配已声明 ports，拒绝 unknown、missing、multipart-only、description/inputs 错配；`AgentInputPortsSchema` 无集合 max；最终合成 Task candidate | 257 个合法声明 port 当前可表达。V1 256 上限有收缩；不能把空数组一律投影成 `inputs:{}`                                 |
| Agent description | nullable；null 在 render 中省略；非 null 模板 ≤65536 UTF-16 units，展开值保持原样                                                        | EC 不经过 HTTP `StartAgentTaskSchema`；零端口 Agent 的 description 进入 host input；有端口时按旧 shape 拒绝 description                                                  | ≤64 KiB UTF-8 不是当前 EC 限额。不要把 HTTP 的 trim/max 迁入此程序入口                                                |
| Workgroup goal    | 非空模板 ≤65536 UTF-16 units；展开值直接进入 `buildWorkgroupRuntimeConfig`                                                               | EC 不经过 HTTP `StartWorkgroupTaskSchema`，最终 Task candidate 的 inputs 为空；goal 保存在 workgroup config                                                              | 新 UTF-8 限额和额外 trim 会改变当前行为；保持旧 renderer/config 输入                                                  |
| DE target keys    | `targetFieldRefSchema` 接受 `repositoryId` 等 camelCase，非 EC machine id                                                                | `assertDigitalEmployeeIntake` 只允许当前 manifest 已声明字段；authoring `targetFields.max(20)`                                                                           | 改为全小写 machine-id 会拒绝现字段；256 项对合法 DE manifest **不是新增收缩**，不能拿 record 无 max 误报可启动257字段 |
| DE target values  | 每模板 ≤65536 UTF-16 units，展开后再入 intake                                                                                            | `employeeWorkIntakeSchema` 每值 1–1000 UTF-16 units，不 trim；required 字段另判 trim 非空                                                                                | 1000 code points 会扩大非 BMP 能力；空值/1001 units 当前已经被拒，不计为新增限制                                      |
| DE body           | valueTemplate 1–2097152 UTF-16 units；可引用 trigger                                                                                     | intake body 1–2097152 UTF-16 units；非 body arm 为 null；uploads=[]                                                                                                      | 草案2 MiB UTF-8收缩：2097152 个中文字符当前约6 MiB仍符合字符串限额                                                    |
| DE external-id    | valueTemplate 同上，render 不 trim                                                                                                       | intake 1–500 UTF-16 units；非该 arm 为 null                                                                                                                              | 501 units 当前已被拒；新 trim 改变合法的首尾空格，code points 改变非BMP边界                                           |
| TriggerContext    | canonical exact codec，单声明 namespace，每值 ≤65536 UTF-16 units，availableFields≤256                                                   | 同一 `shared/triggerContext.ts` 进入 Task snapshot；重复插值能放大 rendered text                                                                                         | 不能将 trigger 字段数量上限误用为 target inputs 数量上限；继续复用 exact codec                                        |
| defaults          | Workflow/Agent/Workgroup scratch=true；Agent allowClarify=true；Workflow inputs={}，Agent 空 inputs/description null 省略；DE uploads=[] | DE 补 `executionOptions={}`、`advanced={collaboratorUserIds:[],typeOptions:{}}`，再按 type defaults 解析                                                                 | required providers 必须保留这些差异，不可统一补零值                                                                   |
| refs / revision   | rule refId 是资源 ID，不是 exact revision                                                                                                | Task 当前资源在 launch admission 读取；DE runtime 先查 event-delivery 旧 Case，再读 currentRevision 并加载 exact revision                                                | 新 ref 应冻结首次实际 admission revision；不得在规则保存时提前冻结，也不得重放时换新版                                |
| origin / receipts | `eventSubscriptionId`、`eventDeliveryId`、canonical trigger 进入既有 invoker                                                             | Task.event_delivery_id 唯一；DE idempotencyKey=`event-delivery:<id>` + Case event origin                                                                                 | 新 origin 必须映射旧 receipt；不能仅换 key 后再建 Task/Case                                                           |

源文件：`modules/event-center/domain/responseRule.ts`、`services/webhook/webhookDispatch.ts#renderEventResponseTarget/dispatchEventTarget`、`services/scheduledTasks.ts#assertIntegrationTriggerSnapshotUsable/assertDigitalEmployeeIntake`、`services/agentLaunch.ts#validateAgentLaunchShape`、`modules/resource-catalog/infrastructure/legacy/workflowLaunchInputs.ts`、`modules/task-execution/infrastructure/taskRouteLaunchOperations.ts`、`modules/integration/infrastructure/webhookExecutionRuntime.ts`、`modules/digital-employee/domain/{model,runtimeModel}.ts`、`modules/digital-employee/application/runtimeService.ts#launchWork`，以及 shared 的 `schemas/{task,workflow,agent,workgroup}.ts` 和 `triggerContext.ts`。

## 可复验反例与证据范围

新增 `packages/backend/tests/rfc365-automation-compatibility.test.ts` 从生产源码编译唯一 renderer 函数，并调用真实 rule、TriggerContext、Task、Agent shape、Workflow inputs 与 Employee intake codecs。覆盖四臂默认值、257个已声明输入、重复模板展开131072字符、中文64K/2M、emoji名字、camelCase、首尾空格和DE下游既有拒绝。

这是 codec/render/admission 组件的特征测试，**不**冒充真实 Task/Case 写入、current revision 并发冻结或跨进程去重验收。T2+ 仍需原四 target 双库 suites 和新增 crash/claim/replay 测试。未运行本地 Bun 测试；随本批提交，由托管 CI 验证。

## 推荐合同修订（待独立批准）

1. 保留当前 UTF-16 单位与各 target 的真实 admission 规则；Task name 继续由原 trim+255 判据投影。不要在此次 owner 迁移中引入新文本字节上限。
2. Task input list 保持唯一 key、原 key 身份与全部可表达项，不增加256上限；排序只用于 canonical encoding，不改变还原后的键值。用精确字段合同描述每个 target，避免伪造通用 bounded-text 等价性。
3. DE field ref 使用现 form-field exact grammar；保留 target 1000/body2097152/external-id500 UTF-16 units和不trim的原语义。DE target 继续受当前manifest≤20与required/unknown判据约束。
4. 将首次 source→render→admission 的 payload 和 revision 持久化，重放同一origin读取原receipt；旧receipt优先映射。默认scratch、allowClarify、省略字段按矩阵逐项保留。
5. 若产品以后确需更严格预算，另立可见行为变更：先给出用户规则受影响清单和迁移办法，再批准限制；本次不截断、不静默拒绝、不改存量规则。

RFC-365保持Draft，T1候选完成并待CI；T2合同修订/生产切换尚未批准。RFC-363/364已批准的实施继续，不受此定稿决策阻塞。
