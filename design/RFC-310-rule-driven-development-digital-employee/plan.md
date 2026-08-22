# RFC-310 · 规则驱动的研发数字员工任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。
>
> 状态：**In Progress（2026-08-19 按用户补充重新打开；2026-08-20 PR-11/12/13 的功能面收口）**。
> PR-0..PR-10 的原范围已落地；本轮新增 PR-11（业务化员工说明书、问题生产/处理与统一 UI）、
> PR-12（跨仓 child Mission / 外部审批 saga）和 PR-13（服务端 Journey 与无指导操作链）。
> 2026-08-20：T131/T132/T140 三项以两条真跑绿的浏览器旅程收口（首跑账见 §13d 末）；
> 同日 T71（retention GC + GB 级 soak）与 T121（`/code` 逐页视觉基线）收口——T121 的
> darwin 基线本机已产并连跑绿，linux 基线按 README 的 Option A 由 nightly 收割。
> **原首版不含（如实登记，见 plan.md §13a）**：cutover preflight 的 per-repo dry probe、
> review 结果升 catalog fact（卡在 findings 尚未落库）、evidence blob 的物理清扫（缺引用索引）；
> mission 列表分页与 `/code` work-items 翻页已移交 RFC-311。evidence retention GC 与 GB 级
> nightly（T71）、`/code` 逐页像素基线（T121）、verification 结果升 catalog fact 已于 2026-08-20 补齐。
> 2026-08-20 补齐：out-of-order webhook 矩阵（T82）、conflict repair 的 Agent 执行面（T78）。
>
> **2026-08-21 数字员工 OS 实现（已通过 hosted 验证）**：proposal/design §0A 的 Context、
> Attention、Event Center、Observer、Employee Event Queue、Reaction、Employee Channel 与现有 Envelope/Script/
> code-host/Token 底座复用设计，并确定“数字员工 → 数字员工分类 → 工作项 → 工具”、工作项 WorkContract、分类工具箱、
> 共享限额快照和通用确定性职责图均已实现；PR-14..PR-18 的功能与 system-mock E2E 已收口。完整 `gate:local`
> 于 2026-08-21 全绿（后端四个随机化分片；frontend 6660；shared 2219；system-mock 35）；最终发布证据见本节 PR-20
> 的 exact-SHA hosted 终态。
>
> **2026-08-21 PR-19/20（已通过 hosted 验证）**：平台执行契约、职责泳道、可选能力、岗位级动态处理路由、检视整树闭环与
> 事件权威刷新均已进入生产实现。增强后的新 OS system-mock 全旅程已通过 45 个断言；公共能力聚焦矩阵和旧 Mission
> code-host system-mock 也已独立复跑。当前工作树完整 `gate:local` 8m30s 全绿（backend 11,624 pass / 36 skip / 0 fail；
> frontend 6,674；shared 2,219；system-mocks 35），浏览器功能 4/4、目标视觉 3/3；功能/视觉冻结提交 `96df8c49` 的 hosted CI
> 31/31 与 visual 55/55 均为 success，不沿用更早 SHA 的绿灯。
> 最终冻结研发类型为 `development@5`，升级库保留 `@1/@2/@3/@4` 并只追加 `@5`，避免 descriptor drift 阻断启动。
> Agent 端口联动已追加进入本批：契约选择移入“输入/输出”，`agent-result` 由 UI 与所有保存入口共同按契约生命周期托管。
>
> **2026-08-22 PR-21/22（本地完成，待 hosted 终态）**：继续收口平台内置工具、材料/评审精确路径、Agent 显式交付输出、职责小卡片、
> 岗位页面内编辑、已发布负责范围继承与统一新建任务入口。旧 `global` 仅保留 runtime 解码兼容，不回到新建界面；最终证据必须来自本轮新提交。

## 0. 交付原则

本 RFC 不是一次“大重写后切流”。实现分成可独立证明的纵向批次，但最终只有一套 writer：

1. 先锁 RFC-294 架构边界和 no-Git/adapter 可行性；任一硬边界不可证明就停止，不用 prompt 补洞。
2. 先交 deterministic policy + Mission core，再接真实 Agent；不能让 Agent 暂时代替规则选择。
3. requirement/pipeline 都以真实 runnable system mock 验证 streaming bundle，不用 in-test object fake 冒充集成。
4. 首个用户价值切片是“一条 requirement → 一个被平台维护的 MR”，不是先做完所有后台表和页面。
5. 所有外部副作用先有 intent/outbox/reconcile/crash test，之后才接 UI 开关。
6. 迁移前先把 legacy 配置变成**草稿+报告**；无法机械映射的 arbitrate/select/hook 不让 AI 猜。
7. cutover 按 writer generation 一次完成，旧模型随后只读；不以长期 feature flag 维持双写。

状态说明：`⏳` 未开始、`🚧` 实施中、`✅` 完成、`⛔` 被设计门阻断。PR-0（T0–T8）已完成，其余为 `⏳`。

## 1. 批次总览

| PR/批次 | 名称                        | 用户可验证结果                                                                                                                                | 依赖        |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| PR-0    | 合同与安全 go/no-go         | RFC-294 import ratchet、no-Git 真实 runtime probe、bundle streaming/provider probe 可行                                                       | RFC 批准    |
| PR-1    | 规则与配置内核              | Java/C++/polyglot 员工和 policy 可发布、模拟、确定性选中，无 Agent 决策                                                                       | PR-0        |
| PR-2    | Mission 聚合与 worker       | Mission 可 launch/reconcile/block/cancel；lease/OCC/outbox/crash 恢复成立                                                                     | PR-1        |
| PR-3    | Requirement 与上传 seed     | 正文/带目标路径上传/外部 ID 统一成 bundle；上传由平台形成可重建仓库 seed                                                                      | PR-2        |
| PR-4    | AgentAttempt no-Git         | Agent 按 envelope 工作；错误同现场新 host task 重试，耗尽 whole-workspace fresh rerun                                                         | PR-0,PR-2   |
| PR-5    | 第一价值链                  | requirement → Java 实现 → program verify → platform commit/push/MR → watching                                                                 | PR-3,PR-4   |
| PR-6    | PipelineEvidence            | 自建门禁程序与大日志 bundle、exact-head 多 gate、rerun/repair                                                                                 | PR-5        |
| PR-7    | MR care                     | feedback/CI/conflict/readiness 回退与持续看护到外部 terminal；永不 merge                                                                      | PR-6        |
| PR-8    | 完整配置与活动 UI           | 数字员工/动作/策略/适配器/仓库 assignment 和 Mission trace 全部可配置可解释                                                                   | PR-5,PR-7   |
| PR-9    | RFC-304/309 迁移 cutover    | 配置迁移报告、active MR 单 writer 接管、legacy 只读、无双 writer                                                                              | PR-8        |
| PR-10   | 收口与发布                  | 删除 legacy writer/决策脚本/unsafe runtime 路径，真实 E2E、完整 gate、文档账目                                                                | PR-9        |
| PR-11   | 业务员工说明书与问题处理    | 只配置“哪一步由谁做”；问题类型/生产者/处理者可定义，技术资源退到高级配置，页面统一 operations 风格                                            | PR-10       |
| PR-12   | 跨员工与外部审批 saga       | 可幂等调用另一仓数字员工，Agent 准备+程序提交/等待审批，durable join/recovery 全链成立                                                        | PR-11       |
| PR-13   | 无指导 User Case 操作链     | 零配置到 MR merged 每页都有服务端下一步、同页主动作和连续导航；浏览器只按高亮动作走通                                                         | PR-11,PR-12 |
| PR-14   | OS 合同、Context 与分类 SDK | 建通用 employee type/job template/definition/Case/Context、WorkItem/WorkContract 和分类工具注册，RFC-294 owner 与 exact public contracts 闭合 | 新 §0A 获批 |
| PR-15   | Event Center 与 Attention   | Event/Source/Subscription、按订阅激活 Observer、Delivery 与 Case 队列完整可恢复                                                               | PR-14       |
| PR-16   | Reaction 与执行底座接线     | ReactionPlan 只复用已有 Workflow/Agent/Script、source-control 与平台注册 code-host/Token 能力                                                 | PR-14,PR-15 |
| PR-17   | Employee Channel            | 跨仓员工调用、typed return、milestone、all/any/quorum、deadline/cancel/recovery 成为 OS 公共能力                                              | PR-14-PR-16 |
| PR-18   | 类型包迁移与通用配置界面    | 现有 Mission/MR care 迁入研发类型包并切单 writer；分类/工作项工具箱/最小员工配置/设置页与完整旅程验收                                         | PR-14-PR-17 |
| PR-19   | 平台执行契约与职责泳道      | Agent/Workflow/Program 的确定性输入输出由平台统一校验；职责图按主干、并行职责和回路显示，不再顺序平铺                                         | PR-18       |
| PR-20   | 可选职责与开发员工闭环      | 可选泳道不阻断、动态失败类型分派、MR 权威刷新、检视整树协议、通用审批边界和分层 system-mock/浏览器覆盖                                        | PR-19       |
| PR-21   | 内置工具、材料与方案评审    | 内置 Agent 工具可见不可改；正文/文件/ID 分派、仓库/临时落点、方案评审和显式 Agent 交付内容均由平台合同锁定                                    | PR-20       |
| PR-22   | 最小化配置与统一任务入口    | 工具箱小卡片、岗位页内编辑、单一仓库范围选择、固定仓库继承和统一“新建任务”卡片入口可无指导使用                                                | PR-21       |

PR 编号表示逻辑批次，不预设最终 GitHub/GitLab MR 数；若某批超出可审查范围，可以按同一验收边界拆成
`A/B`，但不能把安全反向测试挪到以后。

## 2. PR-0：合同与安全 go/no-go

### 目标

用最小、不可进入生产的 probe 证明三个高风险前提：RFC-294 的依赖方向能落地；所有正式 runtime 上「Agent 写
Git/受保护路径必被前后快照对拍检出、violation 现场可 byte-identical 回退、凭据与 Git identity 零注入」成立
（2026-08-18 裁决：不引入 OS 沙箱/网络管控，机制为提示词+事后校验+回退）；adapter 能以受限 sink 流式写大
evidence。未通过不进入 PR-1。

| 编号 | 任务                                                                                                                                                      | 验收                                                                        | 状态 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---- |
| T0   | 重新取 exact baseline，生成 code-capability 调用面、stage/hook/script、code-host action、runtime env/Git mount、旧 writer、cross-context import inventory | manifest 有 owner/remove wave，和源码计数对拍                               | ✅   |
| T1   | 建 `development-automation` 七层骨架、exact `public/*`/`composition/required-ports` 空白入口和 dependency ledger                                          | 未授权 symbol 为 0；bootstrap only composition scan                         | ✅   |
| T2   | 建 consumer-owned required-port contract fixture：integration/task provider adapters 只做 DTO translation                                                 | 禁止 provider import Mission domain/application；禁止 bootstrap 业务分支    | ✅   |
| T3   | 定义 strict opaque refs、Fact/Policy/Decision/Agent/Bundle codecs 与 unknown-key mutation harness                                                         | every codec round-trip；新增 unknown field 全红                             | ✅   |
| T4   | 为 OpenCode、Claude Code 实作**测试专用**检测/回退 probe：真实子进程写 Git/evidence/受保护路径后快照对拍检出并回退                                        | 业务路径正向写成功；违规写全部检出且分类正确；workspace byte-identical 重建 | ✅   |
| T5   | Git metadata/protected roots/evidence 的前后快照与对拍机制：`status/diff/log` 只读语义可用，写入必被检出                                                  | file API/绝对路径 Git binary/`GIT_DIR` 等同形改动零漏报                     | ✅   |
| T6   | 建 one-shot EvidenceSink + runnable requirement/pipeline provider mock probe，流式生成大文件                                                              | peak memory/DB/prompt 不随日志总大小线性增长；safe-walk 拒绝恶意输出        | ✅   |
| T7   | 源码/AST ratchet：禁止 generic code-host action 消费与 Git identity 注入进入新 digital-employee 路径（env 继承按裁决保留）                                | 负 fixture 能让每条 ratchet 打红                                            | ✅   |
| T8   | 写 go/no-go 报告：runtime/provider/architecture 每项明确 pass 或 blocker                                                                                  | 任一 blocker ⇒ 后续任务标 `⛔`，不以 TODO 接受                              | ✅   |

PR-0 只允许测试/probe/architecture scaffolding，不能启动 Mission worker、改 production route 或切 writer。

## 3. PR-1：规则与配置内核

### 目标

用户可以定义多套数字员工、动作实现和规则，并在 fixtures/repository facts 上得到唯一、可解释、可重放的结果；
此时仍不执行 Agent 或外部副作用。**按同一验收边界拆为 1A/1B**：1A = T9–T12 确定性内核（纯 domain/engine，含
T18 的规则语义 fixtures，已交付）；1B = T13–T20 配置资源 CRUD/ACL/permission/API（含 T18 的 DB 侧接线）。

| 编号 | 任务                                                                                                | 依赖     | 状态 |
| ---- | --------------------------------------------------------------------------------------------------- | -------- | ---- |
| T9   | `CapabilityDefinition` closed catalog + contract versions + fixed stage/workspace/effect metadata   | T3       | ✅   |
| T10  | `FactCatalog`、known/not-applicable/unknown/stale、typed predicate AST、canonical codec/hash        | T3       | ✅   |
| T11  | fixed guards + indeterminate stop/collect + first-match + deterministic WorkSelectionReceipt        | T9,T10   | ✅   |
| T12  | DecisionTrace/Receipt canonical bytes 与 replay oracle                                              | T11      | ✅   |
| T13  | `ActionTemplate` immutable revision/ACL/visibility CRUD，锁住不可配置字段                           | T9       | ✅   |
| T13a | `VerificationProfile` revision/probe：disposable workspace、程序化结果、可执行字段 `scripts:author` | T9       | ✅   |
| T14  | DigitalEmployee 唯一 route selector、template compatibility、readiness/transitive closure           | T13,T13a | ✅   |
| T15  | 完整 immutable AutomationPolicy、requirement/delivery groups、有效预算、publish validator           | T10,T11  | ✅   |
| T16  | integration-owned `IntegrationAdapterDefinition` typed lifecycle + `scripts:author` 字段门          | T2,T3    | ✅   |
| T17  | repository/repo-group employee assignment，显式 > repo > group > facts > fallback 的唯一选择        | T14,T15  | ✅   |
| T18  | Java Spring、C++ CMake、polyglot 三套 test fixtures；双义、无 fallback、跨模块阻断                  | T17      | ✅   |
| T19  | employee/policy preview/simulate + configuration-upgrade pure diff planner                          | T12,T17  | ✅   |
| T20  | 配置 package 导入/导出 immutable revision/upstream provenance；未知 version 拒绝                    | T13-T16  | ✅   |

验收重点：相同 fixture + policy revision 重放 100 次 canonical result 完全相同；测试中不存在 mock Agent selector。

## 4. PR-2：Mission 聚合、lease 与 worker

### 目标

在没有真实 Agent/adapter 的情况下，Mission 能从 typed fake receipts 走完 admission、decision、wait/block/terminal；
并发、崩溃和外部 effect intent 有持久化语义。

| 编号 | 任务                                                                                                                    | 依赖            | 状态 |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | --------------- | ---- |
| T21  | schema expand：Mission/source/upload-plan/MR claim/wake/fact/decision/action/attempt/effect/feedback/bundle/link tables | T12             | ✅   |
| T22  | Mission aggregate + terminal states + orthogonal active/tracking-only mode + exhaustive transitions                     | T21             | ✅   |
| T23  | durable mission lease/epoch、OCC、single writable ActionRun、active MR unique claim                                     | T22             | ✅   |
| T24  | admission：submission+delivery、idempotency、optional assignment、explicit/rule selection pin                           | T17,T23         | ✅   |
| T24a | repository.inspect facts → employee selection receipt → full execution policy/closure pin                               | T24             | ✅   |
| T25  | wake dedupe + durable resumeAt/wake conditions/attempt ordinal；restart 不重置 backoff                                  | T23             | ✅   |
| T26  | MissionReconciler：terminal → collect → integrity/freshness → guards → policy → intent                                  | T11,T22,T25     | ✅   |
| T27  | Decision/Action/effect intent + audit/outbox 同事务，外部执行不进 tx                                                    | T26             | ✅   |
| T28  | closed failure taxonomy + effect idempotency/reconcile + cancel/handoff transition fence                                | T27             | ✅   |
| T29  | readiness truth table：automation/machine/human/host mergeable 与 regression                                            | T22,T26         | ✅   |
| T30  | daemon recovery：悬挂 lease/action/attempt/effect 分类收束                                                              | T23,T28         | ✅   |
| T31  | Mission list/detail/trace read models + revision-only WS invalidation                                                   | T24-T30         | ✅   |
| T31a | Mission configuration-upgrade preview/apply：settle action、原子 repin closure、bump epoch 与失效 receipts              | T19,T24,T28,T30 | ✅   |

并发测试至少同时争抢同一 Mission、同一 MR、同一 effect；内存 Map 不能作为唯一互斥证据。

交付注记：T31a 的 preview/apply command 已落（HTTP 面与 `development-missions:upgrade` 点随 PR-8 挂载）；permission 先入 launch/read/interact/cancel/retry 五点（RFC-247 反向自检要求点必须被 route 引用，其余四点随对应路由批次）。

## 5. PR-3：RequirementBundle 与仓库上传 seed

### 目标

正文、指定仓库目标路径的上传文件和“只有外部需求/问题 ID”都进入同一 immutable multi-file contract；上传文件还形成
平台拥有的 RepositoryUploadPlan/SeedChangeRef。Agent 尚未接入，但平台可查看 manifest、落点预览、refresh/失效和失败诊断。

| 编号 | 任务                                                                                                          | 依赖         | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------ | ---- |
| T32  | shared workspace convention 增加 `pipeline` 与 `inputs/requirements` safe helpers                             | T6           | ✅   |
| T33  | selected employee 后解析 source；唯一 auto-pin / 多结果交互选择；acquire + Q&A adapter                        | T16,T24a     | ✅   |
| T34  | one-shot staged sink、safe walk、redaction、budget、atomic EvidenceStore import                               | T6,T33       | ✅   |
| T35  | RequirementBundleManifestV1 平台生成、canonical digest、opaque bundle ref                                     | T34          | ✅   |
| T36  | actor-scoped upload session/TTL/atomic claim；direct 三形态 → bundle；external ID → runnable mock bundle      | T35          | ✅   |
| T36a | UploadPlan：目标/mode/ignore/filter、create/replace/already-present、CAS、placement → immutable SeedChangeRef | T21,T36      | ✅   |
| T37  | action workspace read-only bundle + `baseline + SeedChangeRef` materialization 与 fresh 重建                  | T32,T35,T36a | ✅   |
| T38  | source revision manual/auto refresh + downstream invalidation preview/command                                 | T26,T35      | ✅   |
| T38a | question/answer closed decision/effect：平台/原渠道 correlation、exact revision、重放/超时/多轮               | T33,T38      | ✅   |
| T39  | traversal/symlink/device/hardlink/archive bomb/normalization collision/oversize/redaction fail                | T34          | ✅   |
| T40  | upload/目标路径 preview + direct 表单 + bundle manifest/list/ranged-read UI/API（无 host path）               | T31,T35,T36a | ✅   |

交付注记（2026-08-18，PR-3 完工）：

- **接线**：`composeDevelopmentAutomation`（composition.ts，纯装配）在 routes/developmentMissions.ts 与 cli/start.ts 两个装配点消费（架构锁账本同步）；direct 正文在 launch 成功后由路由层 `stashDirectSubmission`（失败补偿 cancel + 失败码透传）；mutation 成功后 fire-and-forget 一轮 reconcile，进度保证由 daemon 30s `sweepWakes`（fireWake CAS 认领 + wake hint 消费，application/missionWakeSweep.ts）+ hourly 上传 TTL 回收 + 启动 recover 兜底（DAEMON_CADENCE +2 项，数值锁同步）。外部取件 runner 由 integration 侧装配（modules/integration/composition/requirementSource.ts，`AW_REQUIREMENT_MOCK_URL` 为 system-mocks E2E 座席透传），两模块互不 import 内部（rfc294 preflight 债务零增长）。
- **HTTP 面新增 5 端点**：requirement-manifest 读、requirement-files/:sha256 ranged 流式读（Range/206/416；mission 归属检查防全局 blob 池探测）、answers（平台渠道）、source-refresh preview/apply；契约注册表同步。
- **实红修复（journey 揪出的生产 bug）**：决策去重键此前只含 cells+policy/employee，guard 面变化（placement 翻 uploadSeed、effect/fence/action）不改 cells ⇒ 新决策被误吞、mission 永久卡 working；修复把 `FixedGuardInput` 纳入 `decision_input_digest`（missionReconciler.ts，rfc310-pr3-journey body+file 用例锁定）。
- **fork 交付判断（已采纳）与 PR-5 债**：direct manifest 现只含正文文件（`repositoryPlacement` 恒 null），上传文件走 UploadPlan/SeedChangeRef 链入 workspace、不进 requirement bundle files——manifest placement 对齐留 PR-5；claim 失败的 blocked retry 不重生成 plan（PR-5）；preview 无 delivery head 语义（PR-5/PR-7）。
- **T40 范围裁定**：API + 测试锚完工；bundle 浏览 UI 与 direct 表单随 PR-8 T61/T92（T40 行内 "UI" 指可经 API 无 host path 取数的读面，本批已具备）。

正向 E2E 同时覆盖：正文-only；文件-only/正文+文件逐项指定目标路径并得到 seed receipt；只提交
`sourceKey + externalId` 时 mock provider 返回正文+设计+附件三文件。三类 Mission 都 pin 唯一 digest；上传计划可从同一
baseline byte-identical 重建，尚不 commit/push。

## 6. PR-4：AgentAttempt no-Git 与 envelope

### 目标

把 PR-0 probe 变成 task-execution 的正式 digital-employee profile；Mission 可运行一项受限 Agent capability，验证
输出与真实 workspace，并完成两级恢复，但仍不 commit/push。

| 编号 | 任务                                                                                                                       | 依赖      | 状态 |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| T41  | `AgentActionExecutionPort` + task-execution provider adapter；保持唯一四级 execution chain                                 | T1,T22    | ✅   |
| T42  | path-free baseline/input/seed/workspace/protocol refs 与 task composition binder                                           | T37,T41   | ✅   |
| T43  | 正式 digital-employee runtime profile：separate writer、快照检测/违规快退接线（无 OS 沙箱，按裁决）                        | T4,T5,T42 | ✅   |
| T44  | 移除 digital-employee 路径 Git identity 注入；connection/code-host/pipeline secret 不入 Agent env/文件（env 继承现状保留） | T43       | ✅   |
| T45  | capability-specific AgentInputManifest + prompt assembler/untrusted delimiter/protocol block                               | T9,T42    | ✅   |
| T46  | nonce/named-port/strict closed outcome parser；禁止 fake platform facts                                                    | T3,T45    | ✅   |
| T47  | semantic/workspace validator + preserve/editable、mode 与 commit-checkout round-trip consistency                           | T46       | ✅   |
| T48  | source-control 从 baseline+seed+overlay 派生 candidate；上传 entry/发布后 lineage 不得漏失                                 | T47       | ✅   |
| T49  | same-scene 新 host task structured feedback N 次 + persistent attempt ledger                                               | T46,T47   | ✅   |
| T50  | whole-workspace discard/rematerialize + fresh session/new nonce M 次                                                       | T42,T49   | ✅   |
| T51  | boundary violation 快退、capability revoke、悬挂进程/attempt recovery                                                      | T43,T50   | ✅   |
| T52  | 所有 runtime 的检测/回退/credential/rollback 真实子进程测试进入常规 gate                                                   | T43-T51   | ✅   |

交付注记（2026-08-18，PR-4 完工；T49 后续于 2026-08-19 补齐）：

- **执行链（T41/T43/T44，fork J）**：digital-employee host task（codeRoundLaunch 同款 anchor+synthesized snapshot+StartTaskSchema funnel；`internalSource`+`preCreatedWorktree{cleanup:'borrowed'}`）；`modules/task-execution/composition/agentActionExecution.ts` 组装 `{launch,fetchOutcome,cancel}` runner，executionRef=taskId（durable）；终态 `onTerminal` 回调由装配点反查（`missionIdOfExecutionRef`）落 wake hint。零 Git identity/零凭据：StartTask 不带 gitUserName/Email（spawn either-empty-skip 分支即不注入；RFC-067 普通任务注入面不动，对照组测试锁双向）。真 mock-opencode 子进程 9 测（done/协议缺失/四类 launch 校验/cancel 幂等/interrupted 经普通 reapOrphanRuns 收敛）。
- **域内合同（T45/T46/T47 + T42/T49 域半，fork K）**：AgentInputManifestV1（content-addressed，digest 排除 nonce）、prompt assembler（固定顺序+untrusted delimiter 哨兵转义+英文不可覆盖 protocol block）、`<agent-result nonce>` 信封 exactly-one parser（**nonce 对拍 digest 化**——collect 轮平台只有 attempt.nonceDigest，明文由 Agent 回显）、capability semantic validator（coverage 双射/feedback 恰一 disposition/闭集/read-only 禁 changed）、workspace validator（protectedSnapshot 生产化+escape/预算/outcome↔现场一致性）、attempt 状态机+`ab1:` baseline codec+structured feedback。
- **T48 candidate（source-control）**：临时 clone 独立 diff（`write-tree` oid 即内容寻址身份；gitignore 尊重 + 上传目标 `add -f` 保全；`.agent-workflow/` 按 RFC-308 exclude 语义从 overlay 排除——journey 实红修正：evidence mount 是平台放的，不是业务变更；baseline 里 tracked 平台路径进 diff 仍固定阻断）、上传 lineage 四规则、同输入 byte-identical。`bindChangeCandidateParticipant` 组装、DA 以结构同形端口消费。
- **编排（orchestrator，主 session）**：launch 半（baseline→workspace(+seed planDigest 换算——mission 行存 seedTreeDigest 而 seeds 目录名是 planDigest，fork 缝合 bug 已修)→manifest/nonce/prompt→launcher→台账+pre-state evidence blob〔migration 0179 `pre_snapshot_ref`〕）；collect 半（reconcile 顶部插桩，guards 之前）：§7.5 全流水线→§7.7 `planNextAttempt` 分类（boundary=discarded+整树废弃+fresh；协议/语义→fresh；耗尽=blocked(agent-contract-exhausted)）；fresh rerun 同输入合同（missionRevision 冻结在 action 创建时、nonce 不入 digest）；validated 结算=candidate cell+run settled+currentActionRunId 清+**诚实 `action-stage-complete:<outcome>` block**（verification/发布链属 PR-5/PR-6，不静默重复启动作）；needs-information→agent 问题集入台账→既有澄清闭环（publish→awaiting-information→answers）。coverage 闭集从 requirement manifest 冻结进 pre-state。
- **后续收口（2026-08-19）**：T49 不要求 runtime session continuation。每次 same-scene retry 都针对同一 disposable
  workspace 启动新 host task，重建 exact frozen input，注入上一次拒绝 receipt，使用新 nonce 并保留独立 attempt ordinal；
  耗尽后才 whole-workspace fresh-scene 重建。requirement/pipeline platform input 以受限 `.agent-workflow/inputs` /
  `.agent-workflow/pipeline` mount 明确带入 host task，不再只有 prompt index。内部 launch 仍在 composition 边界传短命 workspacePath，
  但不入 DB/prompt/event/public DTO；这是已批准的 provider-adapter 实现细节，不是业务合同。

这里的关键完成定义不是“git 命令返回失败”（首版无 OS 阻断），而是任意 Git/protected/evidence 写入攻击都被前后
快照对拍检出为 boundary violation，旧 session/workspace capability 已不可达、现场从 exact baseline byte-identical
重建，并且没有任何 ChangeCandidate/commit/push 产生。

## 7. PR-5：第一价值链——requirement 到 MR

### 目标

先用一套 Java 员工交付完整产品价值：直接输入或外部 requirement → 分析/澄清 → 实现 → 程序验证/自审 → 平台 Git →
MR → watching。此批不含自建 pipeline repair 和完整 feedback 自动化。

| 编号 | 任务                                                                                                | 依赖         | 状态 |
| ---- | --------------------------------------------------------------------------------------------------- | ------------ | ---- |
| T53  | repository facts refresh/失效 + module catalog/contributor-instruction context projection           | T24a,T26     | ✅   |
| T54  | `requirement.analyze` + coverage/affectedModuleRefs；polyglot 两阶段路由无循环                      | T45-T47,T53  | ✅   |
| T55  | platform/requirement-source answers 回流，answer revision 与 action invalidation                    | T24,T38a,T54 | ✅   |
| T55a | no-change verification/human confirmation receipt + `completed-no-change`                           | T29,T54      | ✅   |
| T56  | `change.implement` Java/route-selected path；文件-only direct 与 seed+Agent candidate               | T48,T53-T55a | ✅   |
| T57  | `verification.run` program profile、evidence receipt、`verification.repair` loop/budget             | T56          | ✅   |
| T58  | `change.review` immutable candidate snapshot + findings/coverage validator                          | T56,T57      | ✅   |
| T59  | DeliveryPolicy：branch/human push、upload precondition、seed 吸收 receipt + exact-head CAS publish  | T48,T57,T58  | ✅   |
| T60  | mr.ensure new/adopt/attach、terminal observe、source pushability、idempotent effect/claim           | T28,T59      | ✅   |
| T61  | minimal Mission UI：正文/上传目标/外部 ID launch、source/answers、upload/candidate/effect/readiness | T31,T40,T60  | ✅   |
| T62  | Java E2E：direct 与 provider 输入 → seed/real Agent → real Git remote → code-host mock MR           | T53-T61      | ✅   |

PR-5 必须证明 Agent 无 Git：commit/push receipt 的调用栈只能来自 source-control participant，Agent runtime trace 中
没有成功的 Git metadata mutation。

### PR-5 交付注记（2026-08-18）

- **发布链落位**：`application/missionDeliveryChain.ts`——`redispatchDelivery` 只接管「candidate derived +
  规则无话可说（block）」静止态，进度 cells（`__delivery.*`）全部绑定 treeOid（repair/重跑换树自动重启链）；
  commit/push/mr-ensure 三类外发副作用逐个走 effects 台账（prepare→dispatch→执行→confirm，intent 载荷不落表、
  canonicalDigest 对拍 `intent_digest`，drift 即 fail+block），单轮一 effect；dispatched 悬挂行按 idempotencyKey
  撞回重放（三执行体天然幂等），发布链 kinds 不进 effect-unsettled guard（`DELIVERY_EFFECT_KINDS` 过滤）。
  push 永远普通 push + exact-head CAS（new-branch=expectedRemoteSha null；无任何 force 形态）。MR 建立
  （claimMr，撞唯一经 `findMrClaim` 消歧自我重放）后链使命完成：block 改写为诚实 `wait(mr-care-not-wired)`
  （MR care 属 PR-7），mission `publishing→watching`。
- **T58 范围**：review 的 envelope/validator 契约完整（read-only completed union 成员、reviewedCandidateRef
  必须命中 launch 冻结的当前 candidateRef、findingId 唯一、findings 是素材不是裁决）。
  **verification 的 fact 升级已于 2026-08-20 补齐**（见下方「verification fact 收口注记」）；
  review 结果的 fact 化仍欠——原因不是没做，而是**没有可投影的数据**：`mr.review.external`
  的 findings 目前不落库（collect 侧的 `structuredResultRef` 只覆盖 `problem.classify` /
  `approval.prepare`），要先决定 findings 的持久化形态才谈得上升 fact。如实登记，不假装。
- **verification**：policy `verification.requiredProfileRefs` 逐个派发（treeOid 绑定进度表）；执行器
  `infrastructure/verificationRunner.ts`（exit code ∈ successExitCodes 唯一判据、stdout/stderr 直连文件、
  TERM→KILL、file-glob evidence 进内容寻址 blob）；profile 解析 `repo:<相对路径>` 形态（受管 scripts 资源表
  随 PR-8）。
- **upload publication receipt**：orchestrator 结算时把 candidate lineage 冻结进 `__delivery.uploadLineage`
  cells，push 成功即 `recordUploadPublicationReceipt`（不 re-derive）。
- **装配**：composition 内绑定 repositoryFacts/verificationProfiles/verificationExecution/uploadPublication；
  candidateDelivery（source-control `bindCandidateDeliveryParticipant`）、repoRemote 与 mrEffects
  （integration `composeDevelopmentMrEffects` + RFC-269 connections）由装配点注入
  （`services/developmentDeliveryDeps.ts`，routes 与 cli 共用；repo 凭据 URL 解封只在装配点）。
- **T62 E2E**（`rfc310-pr5-e2e-java.test.ts`）：除 Agent 进程外全真件（真 collector Java 启发式、真
  workspace/validator、真 git candidate、真 verification 子进程、真 durable commit + CAS push、真 mrEnsure
  打 system-mock GitLab API），mock 侧断言 MR/分支真实存在。git 面用 mock 服务端磁盘 bare 仓路径
  （部分开发机拦「子进程→回环 HTTP」，见 dev-gotchas）。
- **当时本批遗留（已被 2026-08-19 后续收口取代）**：same-scene 重试、evidence-in-host-task 和内部 launch path 边界；
  最终语义见 PR-4 “后续收口”，不再要求 runtime session continuation。`change.implement` 的 route-selected 多模板
  路由已具备（L 交付 analyze route 先例），文件-only direct candidate 走 uploadPlan+seed 链已在 T48/T59
  覆盖。

## 8. PR-6：PipelineEvidence 与自建门禁

### 目标

程序化取得自建门禁详情和大日志，规则基于 exact typed facts 选择安全 rerun、Agent repair 或 block。

| 编号 | 任务                                                                                                               | 依赖        | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------- | ---- |
| T63  | PipelineEvidence required port + integration adapter/connection/secret projection                                  | T16,T32     | ✅   |
| T64  | head/target pre/post fence + required-gate completeness                                                            | T26,T63     | ✅   |
| T65  | PipelineEvidenceManifestV1、safe streaming import、`.agent-workflow/pipeline/<bundleId>` read-only materialization | T34,T63,T64 | ✅   |
| T66  | multi-gate status/retryability/failure-category codecs；unknown/partial/unavailable 不通过                         | T10,T65     | ✅   |
| T67  | bounded/ranged Agent evidence read，prompt/DB/event size guard                                                     | T65         | ✅   |
| T68  | pipeline observe/trigger-if-missing/rerun effects、idempotency、head/独立预算                                      | T28,T66     | ✅   |
| T69  | `pipeline.repair` Agent capability + issue-ref validator + new-head evidence invalidation                          | T47,T59,T66 | ✅   |
| T70  | runnable provider mock：大流、partial/outage/head race/retry response lost                                         | T63-T69     | ✅   |
| T71  | memory/backpressure/retention tests + GB-scale nightly/soak fixture                                                | T65,T67,T70 | ✅   |

### PR-6 交付注记（2026-08-18）

- **编排链落位**：`application/pipelineEvidenceChain.ts`——`redispatchPipeline` 在「MR 已建 + policy 配 gates +
  静止态（block / wait(mr-care-not-wired)）」时接管：evidence 缺/head 漂移/超龄 → `collect-pipeline-evidence`
  （两次 head fence：mrEffects.observe 前后各一读 + `judgePipelineFence` 判定，漂移丢弃快照 + 30s backoff
  cells（`__pipeline.fenceRetryAt`）重采，不 block 不打 provider 风暴）；missing required gate 且
  trigger-if-missing → `trigger-pipeline`；failing 且 retryability safe + 类别 ⊆ rerunnableCategories + 预算内 →
  `rerun-pipeline`（exact runRef）；在跑 → 诚实 wait；全过 → 放行（readiness/PR-7 输入）；不可重跑失败 → 规则
  可路由 `pipeline.repair`（catalog facts 可见），无规则 block(`pipeline-gates-failing:<keys>`)。trigger/rerun 走
  effects 台账（`PIPELINE_EFFECT_KINDS` 同发布链 guard 豁免；响应丢失由 adapter adopt 语义兜底）；触发/重跑后
  `__pipeline.collectedAt=0` 强制 recollect。
- **T63**：integration `developmentAdapterRunner` 扩 pipeline 三 op（`--collect-pipeline/--trigger-pipeline/
--rerun-pipeline` + `AW_PIPELINE_*` env）+ `developmentPipelineAdapter`（purpose/operations 运行时对拍，
  `operation-not-declared` typed 拒）+ `composition/pipelineEvidence.ts`；DA 端口胶水在装配点
  （`services/developmentDeliveryDeps.ts` buildDevelopmentPipelineDeps：sink 生命周期归平台、receipt 压平）。
- **T64/T66 判定语义**（fork Q 裁决，测试锁定）：fence 优先级按可达性 `head-moved > target-moved >
expected-head-mismatch > provider-head-mismatch`（指令原排序会让 head-moved 数学不可达）；skipped 归
  failing（非 pass 非进行中的 required gate 一律 failing）；queued/running 两 set 都不进（由 anyRunning+wait
  兜）；policy required 集是权威（manifest.required 只是 adapter 转述）。provider 无 head 绑定 ⇒ envelope
  providerHeadSha=null ⇒ completeness 强制 partial（fence 跳过 providerHead 对拍，facts 面恒不 pass）。
- **T65**：`infrastructure/pipelineEvidenceImport.ts`——文件全集以 `importStagedTree` safe-walk 为准（digest
  平台重算、envelope 未提及文件照收、引用缺失/ fileId 冲突整体拒）；manifest schema 自检 + canonical digest +
  本体内容寻址入池（cells `__pipeline.manifestRef`）。target sha 读面属 T72：manifest.targetSha 缺真值时
  全零哨兵占位（fence 以分支名对拍「引用未变」），T72 后升级。
- **T67**：`readEvidenceFileRange`（4MiB clamp、截断 receipt totalBytes/nextOffset 不伪装完整）+
  `GET /:id/pipeline-evidence/:sha256`（manifest 白名单外 404、`x-evidence-*` 三响应头即续读协议）。
- **T69**：repair 的 launch 注入（pinned bundle 只读挂载 `.agent-workflow/pipeline/<bundleId>` + issue 闭集
  `<gateKey>#<runRef>` 冻结进 pre-state → collect 侧 validator `issue-ref-outside-bundle` 对拍）；新 head
  失效走机制自洽（repair→新 candidate→新 push→MR head 变→redispatch 强制 recollect）。
- **T70**：system-mocks pipeline provider 补全（trigger 幂等/response-lost adopt/rerun 递增/running 409/
  outage/partial/head-race/64MB 大流）+ `pipeline-adapter-cli`（`AW_PIPELINE_FIXTURE_JSON` 测试后门防
  「子进程→回环 HTTP」坑）+ suite gateway 集成（`AW_PIPELINE_MOCK_URL`）。
- **T71（✅，2026-08-20 收口）**：memory/backpressure 早已覆盖（64MB 流式断言 + importer budget 拒收）；
  本轮补齐 retention GC 的**消费者**与 GB 级 soak：
  - `infrastructure/retentionSweeper.ts` + 模块面 `sweepRetention()`，挂
    `DAEMON_CADENCE.developmentRetentionSweep`（hourly，与既有上传 GC 同节拍）。逐条**终态**
    Mission 按其**钉住的 policy** 取 TTL：已结算 `development_agent_attempts` 超 `attemptLedgerTtlDays` 真删（本模块增长
    最快的表，每次重试一行）；`development_bundle_refs` 超 `requirementBundleTerminalTtlDays` 标
    `retention_state='expired'`（**标记不是删除**：可逆、可见）。单轮 200 条 Mission 上限。
  - 四条边界锁在 `tests/rfc310-retention-sweep.test.ts`：终态+过期被处理 / 终态未到期一字节不动 /
    非终态多老都不动 / 终态上的**未结算** attempt 不删（那是需要有人看的异常，不该被保留期抹掉）。
  - GB 级 soak：`tests/rfc310-evidence-soak.test.ts`（`RUN_EVIDENCE_SOAK=1` 打开，默认 2GiB）复用
    PR-0 那根子进程探针，断言换成**绝对常数**上限（峰值增幅 < 128MB，与总量无关）；
    `.github/workflows/evidence-soak-nightly.yml` 每日 08:30 UTC 跑。本机 2GiB 实跑 187s 绿。
    立它的理由写在文件头：64MB 那条**证不了它想证的东西**——全缓冲实现在 64MB 下也只多吃 64MB，
    仍落在阈值噪音里；2GiB 配 128MB 上限才有 16 倍分辨力。
- **T71 未做、且本轮有意不做的一半：evidence blob / manifest 的物理清扫。** 这不是工程量问题，是
  **判据缺失**：blob 内容寻址、跨 bundle 共享，而本仓没有覆盖全部生产者的引用索引——①pipeline
  evidence bundle 直接写 EvidenceStore，**没有任何 DB 指针行**；②attempt 的 `pre_snapshot_ref` 只被
  attempt 行引用；③`development_bundle_refs` 只覆盖 requirement 一族。在这个前提下写删 blob 的
  sweeper 等于**按猜测删证据**，而这些证据正是 blocked 诊断与审计要用的。正解：先建一张覆盖全部
  生产者的引用表（`owner_kind`/`owner_id` → `evidence_ref`），零引用才可清，存量无法回填的标 legacy
  永不清扫。独立一波，未立 RFC。`sweepRetention()` 的返回值里 `expiredBundleRefsPending` 就是这笔债的
  数字，让它可见而不是沉默地涨。
- **多 provider 路由**：员工 `pipelineProviders` 首版取第一个绑定（providerKey→gate 映射属 PR-7+ 配置面）。

## 9. PR-7：完整 MR care 与 terminal tracking

### 目标

让 Mission 从 MR 建立后持续处理 review、pipeline、conflict 和 readiness 回退，直到外部 merged/closed；系统
始终没有 merge/approve/resolve 能力。

| 编号 | 任务                                                                                               | 依赖            | 状态 |
| ---- | -------------------------------------------------------------------------------------------------- | --------------- | ---- |
| T72  | MR facts collector：head/target/draft/terminal/mergeability/approvals/thread revisions 同 snapshot | T60,T64         | ✅   |
| T73  | feedback ledger/fingerprint/self-marker/dedupe/stale revision invalidation                         | T72             | ✅   |
| T74  | `mr.feedback.apply` capability + exact thread revision semantic validator                          | T47,T73         | ✅   |
| T75  | platform `mr.feedback.reply` idempotent effect；只回复不 resolve                                   | T28,T74         | ✅   |
| T76  | MR care default policy 与可配置 feedback/conflict/CI priority                                      | T15,T66,T73     | ✅   |
| T77  | source-control conflict prepare：只 merge target into source、exact S/T、conflict set              | T59,T72         | ✅   |
| T78  | `conflict.repair` edit-conflicts profile + platform finish merge commit + CAS push                 | T43,T47,T77     | ✅   |
| T79  | report-only 默认、repair budget/blocked handoff；禁止 rebase/force/ours/theirs shortcut            | T76-T78         | ✅   |
| T80  | readiness/handoff/tracking-only + external upload fulfillment/lineage + ready 回退                 | T29,T72,T76     | ✅   |
| T81  | terminal：merged/closed/no-change + upload-unfulfilled；reopen/cancel fence/reconcile              | T30,T72,T80     | ✅   |
| T82  | periodic reconcile + webhook loss/replay/out-of-order，所有入口同一 facts path                     | T25,T72,T81     | ✅   |
| T83  | crash matrix：question/upload placement/Agent/commit/push+seed 吸收/MR/reply/readiness/transition  | T30,T75,T78-T82 | ✅   |
| T84  | source/AST/action-catalog 负扫描证明 merge/approve/resolve/custom/force push 不可达                | T7,T75-T83      | ✅   |

### PR-7 前半交付注记（2026-08-18，T72–T76/T81/T82/T84；T77–T80/T83 待后半）

- **care 编排落位**：`application/mrCareChain.ts`——链序 delivery → care → pipeline（care 先保 MR facts 新鲜，
  `__mr.headSha` 是 pipeline stale 判定的锚）。facts 缺/超龄（5min 常量 + webhook wake 主信号）→
  `collect-mr-facts`；apply 结算的 dispositions（orchestrator 冻结 `__feedback.lastDispositions`）逐 thread →
  `reply-feedback`（effect 台账 `reply:<mission>:<thread>:<revision>`，只回复绝不 resolve，正文含 self marker
  =missionId）+ 台账 addressed/needs-human 推进；selectable feedback 无规则接手 → 诚实 `wait(feedback-awaiting-
policy)`（不代替 policy 决定）；watching + requiredGatesAllPass → `publish-readiness`（既有 arm 推进状态）。
  terminal 由 fixed guard 派 mark-terminal（不在链内）。
- **T72**：integration `mrFacts.ts` 三读 fence collector（head 漂移 `mr-facts-head-race` 整组丢弃；threads 单页
  100 超限 typed 拒不冒充完整；approvals 读不到 = null 不伪造；github REST 无 thread resolve 面 ⇒ resolved 恒
  false 注明）+ DA `projectMrCells`（approvalHold null 不产 cell——indeterminate 老实停）+ 装配点胶水
  `buildDevelopmentMrFactsDeps`（claim 行→binding→采集→投影+threads bodyDigest；headSha 缺席不投影）。
  fork R 顺手修 system-mocks 一个真 bug（gitlab discussions 回复被挂成新 discussion）。
- **T73**：`development_feedback_ledger` store 四方法 + domain 纯判定（fingerprint/authorClass 三分类/
  selectable 折叠先于过滤 + batchLimit）；collect arm 联动（新 head obsolete 旧行、幂等 upsert、selectable 数
  投影 `mr.unhandledFeedbackCount`）。obsolete 只打 observed/selected——已处理事实不逆写。
- **T74**：feedback 闭集走 **manifest.feedbackSnapshot**（PR-4 validator 双射已就位，不加 closedRefs 字段）；
  launch arm 对 `mr.feedback.apply` 调 `prepareFeedbackSelection`（行标 selected + (threadRef,revision) 冻结）。
- **T81 部分（🚧）**：mark-terminal arm 补齐 §10.4 结算——在途 action 撤销（invalidateInFlightAction）+
  `terminalUploadFulfillment` 如实定格（unfulfilled ≠ success）+ releaseMr；reopen→新 generation 链与
  cancel/handoff fence 完整矩阵归后半。
- **T82 部分（🚧）**：webhook ingress → mrClaim 反查 → wake hint（deliveryKey 幂等；facts path 不变——
  reconciler 主动采集才是真相，丢 webhook 只慢不卡：care/pipeline 的 wait 带 sweep 兜底）；loss/replay/
  out-of-order 测试矩阵归后半。
- **T84**：`rfc310-pr7-no-merge-capability-scan`——mission 链路（DA+integration+source-control）源码级禁
  `mr.merge`/`mr.approve`/`thread.resolve` 字面量、push 语境 force 形态、决策/能力目录 merge 类 arm（决策
  kind 全集快照）；fork R 另有 mrFacts/mrEnsure 文件级负锁（写端点字面量禁令 + `/approvals` 只读豁免）。
- **待后半（PR-7b）**：T77–T79 conflict 链（source-control merge-target-into-source prepare + edit-conflicts
  profile + finish commit + CAS push + report-only 默认/budget/禁 rebase-force-ours-theirs）、T80
  handoff/attach/resume/tracking-only + fulfillment 回退、T83 crash matrix。

### PR-7 后半交付注记（2026-08-18，T77/T79/T80/T83；T78 部分）

- **T77**：source-control `conflictMerge.ts`——prepare（临时 clone → merge target into source `--no-commit
--no-ff`；干净合并 = `no-conflict` typed 拒【facts 过期信号，重采而非重试】；冲突态保留 markers+MERGE_HEAD）
  - finish（「已解决」按工作树 marker 内容检测而非索引 unmerged——Agent 无 Git，add 是 finish 的职责；只
    add 冲突集，顺手改动 `conflict-extra-changes` 拒不收编；平台身份 merge commit 双 parent；零 push——发布
    归 deliverCandidate CAS）。`bindConflictMergeParticipant` 已入 composition 与两装配点。
- **T78（✅，2026-08-20 补齐）**：见下方「T78 收口注记」。
- **T79**：conflict shortcut 负锁（source-control 禁 `-X ours/theirs`/`--strategy=ours|theirs`/rebase）+
  T84 主扫描的 force 面 + policy `conflict.mode` 默认 report-only/maxRepairAttempts 既有。
- **T80**：handoff（bumpEpoch+fence → 撤在途 action → prepared invalidate → dispatched 留 settleFence
  【handoff 分支 PR-2 已在】→ tracking-only 保留 claim）/ attach（observe 主动校验不信自述 + claim 消歧 +
  merged/closed 同命令 authoritative terminal + fulfillment 如实）/ resume（MR+pipeline 双面 facts 强制
  过期 + bumpEpoch + active）。permission +3（handoff/attach 成员档、resume elevated 档），HTTP 三端点+
  契约登记。路由 deps 未注 agentLauncher ⇒ handoff 不发进程 cancel（台账权威、孤儿收敛兜底）——要真
  cancel 需 composition 暴露命令，PR-8 一并。
- **T83**：crash matrix 三窗（commit dispatched 中断重放收敛到 MR+watching / mr-ensure confirmed 后
  claim 前中断 adopt 不复制 / reply dispatched 中断单次重放）。**抓出并修复一个真实恢复缺陷**：链自治
  effect 悬挂 dispatched 时 cells/guards 不变 ⇒ 决策去重吞掉 handler ⇒ 永久卡死；修复=去重命中但存在
  悬挂自治 effect 时照常执行 handler（幂等重放）。
- **T81/T82（✅，2026-08-20 补齐）**：**webhook out-of-order 显式矩阵**
  （`rfc310-pr7-webhook-order-matrix.test.ts`）：同一个受控 code host 跑按序 / 乱序迟到 / 重放
  三种投递序，断言收敛终态一致、迟到序不对陈旧评论派 reply、重放只被接受一次；变异实证——把
  采集结果钉死成 `active`（模拟「信 payload」）用例立刻红。**reopen→新 generation 链**见下方
  「T81 reopen 收口注记」。

## 10. PR-8：完整配置与活动 UI

### 目标

用户只在平台配置员工、策略、adapter 与仓库 assignment，即可理解“这名数字员工能做什么、为什么这么做、
当前 MR 还差什么”。不暴露 JSON-only 必填路径。

| 编号 | 任务                                                                                       | 依赖         | 状态 |
| ---- | ------------------------------------------------------------------------------------------ | ------------ | ---- |
| T85  | 数字员工列表/详情：能力闭包、Java/C++ routes、adapter、policy、readiness                   | T14,T18      | ✅   |
| T86  | ActionTemplate/VerificationProfile：阶段图、锁定字段、隔离/程序/证据 refs                  | T13,T13a,T45 | ✅   |
| T87  | policy rule builder：first-match 排序、fixed guards、budgets、shadow/no-match diagnostics  | T15,T19      | ✅   |
| T88  | policy/employee fixture simulator 与 exact DecisionTrace                                   | T19          | ✅   |
| T89  | adapter 页面：purpose/contract/connection/secret projection 名称/probe；字段级权限         | T16,T33,T63  | ✅   |
| T90  | repo/repo-group assignment，替代旧五格矩阵；冲突与缺能力逐条提示                           | T17,T85      | ✅   |
| T91  | Mission timeline + configuration upgrade + pending transition + handoff/attach/resume 控件 | T31a,T61,T80 | ✅   |
| T92  | evidence manifest/browser/ranged-read UX；明确不可信数据与截断                             | T40,T67      | ✅   |
| T93  | i18n、responsive、只读权限、错误恢复、visual regression、真实浏览器 E2E                    | T85-T92      | 🚧   |

### PR-8 交付注记（2026-08-18，T85–T92；T93 部分）

- **T85/T86/T89（fork V）**：参数化配置页 `/code/config/$kind`（四族共用列表+详情：employees /
  action-templates / verification-profiles / adapters）——publish violations 逐条示人、adapter 高危字段按
  `scripts:author` 双向隐藏、secret projection 只显示 key 名、AclPanel/ConfirmDialog 复用零新 CSS。
  JSON-only 余量：员工 routes/模板 refs/profile steps/adapter operations 的**编辑**仍 JSON 兜底（publish
  校验保合法），深度表单随 rule builder 先例演进。「阶段图」降级为 capability 元信息卡——完整流程条需
  capability 目录只读端点（注记）。
- **T87/T88（fork W）**：`/code/policies` rule builder（有序规则=first-match 显式呈现、谓词按 kind 切换
  控件、组合子 JSON 行保真+parse 失败阻止保存）+ simulator（guards 面板+cells 表→preview-decision→
  guard/rule trace 逐条+no-match 显式诊断）。前端 fact/predicate/capability/模板目录为静态镜像，
  **测试直接相对路径 import 后端 domain 逐条对拍**（漂移一步即红；vitest 加精确 `@/util/hash` alias，
  backend canonicalJson 已改纯相对 import 消除 tsc 跨包缝）。十三 policy 段中十二段结构化，仅
  requirement 段 JSON 兜底。
- **T90（主 session）**：`/code/assignments` 三级指派页（scope 分组、未发布引用逐条警示、编辑 Dialog
  只提供已发布资源并 pin revision、scoped DELETE）。
- **T91/T92（fork X）**：mission 详情时间线（decision trace+effects 合并叙事、trace 可展开原样示人）、
  handoff/attach/resume 三控件（可见性=automationMode×权限、attach auto 端点不硬造键）、config
  upgrade 徽标（published>pinned 才现，升级执行属 PR-9）、evidence browser（gate 摘要+文件清单+
  256KB 分段续读按 x-evidence-next-offset、不可信内容警示、绝不渲染 HTML）。后端 detail 投影补
  pipeline 摘要块。handoff 三命令上提 composition（完整 ports——真 agent cancel 接通）。
- **T93 部分（🚧）**：i18n 双语/权限双向/错误恢复/inventory 棘轮全绿；**visual regression 快照与真实
  浏览器 Playwright E2E 未新增**（既有 e2e 家族覆盖旧面；RFC-310 页面的浏览器级 E2E 归 PR-10 T109
  一并）。
- 新增前端测试 21 个全绿（config 4 / policy 8 / assignments 2 / mission-ux 7）+ 双 inventory 棘轮。

## 11. PR-9：迁移与单 writer cutover

### 目标

把 RFC-304/309 资产变成可审阅 drafts，active MR 以外部真相建立 Mission，一次切到唯一 writer；全程保留
可恢复点和逐项账目。

| 编号 | 任务                                                                                | 依赖        | 状态 |
| ---- | ----------------------------------------------------------------------------------- | ----------- | ---- |
| T94  | migration analyzer：模板/矩阵/script/hook/arbitrate/select 逐项分类与 source digest | T0,T13-T16  | ✅   |
| T95  | 生成 ActionTemplate/DigitalEmployee/Policy/Adapter candidates；无法映射显式 blocked | T94         | ✅   |
| T96  | migration report UI/CLI：旧 id/ACL/upstream、差异、缺项、publish gate               | T85-T90,T95 | ✅   |
| T97  | schema expand/backfill verify/backup-restore；legacy rows 尚不 drop                 | T21,T95     | ✅   |
| T98  | cutover preflight：每 repo employee/policy/adapter/no-Git probe/dry decision 全绿   | T52,T96,T97 | ✅   |
| T99  | freeze old admission + delivery backlog + quiesce/cancel old rounds                 | T98         | ✅   |
| T100 | 从 external truth 建 Mission、legacy link、active MR claim；旧未发布 workspace 废弃 | T99         | ✅   |
| T101 | writer generation flip + replay wake backlog + per-MR single-writer verification    | T100        | ✅   |
| T102 | rollback drill：无 side effect 前回退；有 side effect 后 stop/reconcile/handoff     | T101        | ✅   |
| T103 | soak 后 legacy API/UI/worker 只读化；查询仍可追溯                                   | T101,T102   | ✅   |

cutover 的验收样本必须包含：无 MR 的 requirement、已有 MR/绿、已有 MR/红、feedback 待处理、冲突、运行中
Agent、push 已发生但 receipt 丢失、MR 已在外部 merged。

### PR-9 交付注记（2026-08-18）

- **T94/T95/T96**：`application/migrationAnalyzer.ts`（纯分析器：逐项 mappable/partial/blocked +
  typed blockedReasons + 复跑稳定 sourceDigest）+ `infrastructure/migrationAssets.ts`（legacy 两表
  只读采集、materialize 经既有创建命令建 **unpublished draft**、幂等 skipped、报告+结果持久化
  `maintenance_state` key `rfc310-migration-report`）+ CLI `agent-workflow migration-report [--json]`。
  契约要点：legacy 能力/slot 名钉本地常量（PR-10 删 legacy 后报告仍可解释）；adapter/assignment
  targets 只出 proposal 不落库（`manual-authoring-required` / `proposal-only`）；arbitrate/select/hook
  全 blocked 绝不 AI 翻译；矩阵五格闭包（非 blocked 引用）才产 employee draft；legacy `public` 行
  ACL 以 migration-only 直写恢复。
- **T97–T103 机制面**：`domain/cutover.ts`（纯状态机 pre→frozen→live + rollback 判定）+
  `application/cutover.ts`（runCutoverCommand / adoptActiveMr 经 CutoverStore port）+
  `infrastructure/sqliteCutoverStore.ts`（maintenance_state key `rfc310-cutover-state` + legacy link
  台账）。HTTP 面 5 端点（GET cutover 读面=T97 对账：state+现算 preflight+persisted materialize 结果；
  materialize/freeze/flip/rollback/adopt-mr），权限点 `development-missions:cutover`（admin 档，
  目录 108→109 全链计数锁同步）。legacy 双入口 gate：`/api/code/rounds` POST 在 frozen/live 409
  `legacy-admission-frozen`（body 解析前）；webhook code-round fire 在 supersede 之前短路落
  `skipped-legacy-admission-frozen`（shared enum + DB schema enum + zh/en outcome 文案）。adopt：
  observe 外部真相→createMission(adopt)→active claim→legacy link（receipt=观察快照）；merged/closed
  记 authoritative terminal 零 claim 零 action；同 MR 重放幂等（cutover launch key）。
- **测试**：`rfc310-pr9-cutover.test.ts` 19 case（状态机矩阵/持久化重读/双入口 gate 正反/adopt 六
  样本）+ `rfc310-pr9-migration-analyzer.test.ts` 11 case；route error code ratchet 五码点名。
- **诚实边界（不阻塞，T112 出账）**：T98 preflight 为对账读面（per-repo dry decision probe 未做
  独立命令，能力由 GET cutover 的 preflight + policy simulator 覆盖）；T99 的「cancel 运行中旧
  rounds」与 T103 的 soak 只读化是 runbook 人工步骤（机内 gate 已挡新入，存量 round 自然收敛，
  legacy 写面删除在 PR-10 T104/T105）；T101 的 wake backlog replay 依赖既有 30s sweep（无独立
  replay 命令）；writer generation 值当前只入 state/审计，未做 per-effect generation 对拍。

## 12. PR-10：收口、删除与发布

| 编号 | 任务                                                                                         | 依赖      | 状态 |
| ---- | -------------------------------------------------------------------------------------------- | --------- | ---- |
| T104 | 删除 legacy launch/monitor writer、arbitrate/select 决策、任意 hook Mission 路径             | T103      | ✅   |
| T105 | 删除旧 repo × capability 写面、五 capability 产品入口、unsafe generic code-host port 消费    | T103      | ✅   |
| T106 | digital-employee 路径移除 Git identity 注入并锁检测/回退接线；负扫描 0（env 继承按裁决保留） | T104      | ✅   |
| T107 | cross-context internal import 清零；public surface/required ports/field budgets 复核         | T104-T106 | ✅   |
| T108 | schema contract：确认 rollback 窗口/backup restore 后 drop 不再使用的 legacy write schema    | T103-T107 | ✅   |
| T109 | 系统 mock 全旅程、真实 runtime、Git remote、浏览器、crash/large-log/permission E2E           | 全部      | ✅   |
| T110 | focused/typecheck/lint/format/depcheck/migration/architecture + 完整 `bun run gate:local`    | T109      | ✅   |
| T111 | hosted CI exact SHA、发布/升级/rollback runbook、运维 dashboards/alerts                      | T110      | 🚧   |
| T112 | RFC-304/309 转出账与 RFC-310 AC 逐项证据，`STATE.md`/索引/docs/dev-gotchas 收口              | T111      | 🚧   |

- **T110（✅，2026-08-20）**：`bun run gate:local` 本日多轮全绿（最后一轮 9m37s），hosted CI
  exact-SHA `892c1bf3` **31/31 全绿**，`visual-regression-nightly` 53 passed、
  `evidence-soak-nightly` 绿。本行此前 🚧 只是账没销。
- **T111 剩余（🚧，精确范围）**：`hosted CI exact SHA` 已满足（同上）。**未做的是另外两半**——
  ①**发布 / 升级 / rollback runbook**：`design.md:2919` 只有一段 _cutover_ runbook（迁移步骤），
  没有发布回滚的运维文档；②**运维 dashboards / alerts**：一个字都没有。⚠️ dashboards/alerts 的形态
  取决于使用方实际的监控栈，**先与用户确认再动手**，否则产出的是一份没人会用的文档。
- **T112 剩余（🚧）**：AC 证据索引（§13a）与 `docs/dev-gotchas.md` 收口已随各波次滚动更新，
  `design/plan.md` 的 RFC-310 索引条目已于 2026-08-20 更新为当前真值。**剩下的是 T111 完工后的
  最终出账**——它依赖 T111，故不先行置 ✅。

### PR-10 交付注记（2026-08-18）

- **T109（先行交付）**：`rfc310-t109-full-journey-e2e` 两条旅程——A：requirement →
  implement → verify → commit → CAS push → MR → watching → 真三读 fence facts → mock 种 human
  review thread → 台账 selectable → policy 路由 `mr.feedback.apply` → Agent 修复 → 第二轮
  verify/commit/fast-forward push（clone 对拍分支真实前进）→ reply 真回帖（self marker）→ 外部
  merged → guard mark-terminal → claim released + effect 台账零悬挂；B：cutover `adoptActiveMr`
  接管外部已开 MR → watching → 外部 merged → authoritative terminal。**E2E 抓出并修复 4 个生产级
  缺陷**（mr fact 前置引用卡死 / feedback 计数陈旧重复发射 / 修复轮 candidate 永不发布 /
  修复轮基线错导致 push 被拒），全部带回归锁。
- **T104/T105**：`modules/code-capability` 102 → 19 文件（纯读面）。删除面：services writer 家族
  10 文件、composition/ports 全目录、application/domain/infrastructure 的 writer 74 文件、
  scheduler 的 `runCodeRoundNode` 区块（~900 行）+ 6 个辅助函数、`/api/code` 三条写路由
  （PUT matrix / POST matrix/bulk / POST rounds）、webhookDispatch 的 code-round 全链
  （render/launch/wake/close/receipt）、executor 与 execution types 的 `code-round` 臂、
  前端 `/code` 的 matrix + templates 两个写面 tab 与 template 详情路由/编辑器/launch 面板、
  `code-rounds:launch` 权限点（全链计数锁同步）、88 个 writer 测试。**存储层写函数一并清零**
  （upsert/disable/wants/readCell、openDelivery/advanceDelivery）——读面测试改自持种子
  （`tests/helpers/legacyCapabilitySeed.ts`），生产不留无调用者的写入口。历史 trigger 行的
  fire 落 `skipped-trigger-invalid`；新建 code-round trigger 被 `webhook-trigger-kind-retired` 拒。
- **T106**：负扫描通过——`development-automation` 模块内零 Git identity 注入（architecture lock
  T7 持续锁定）；Agent 执行面（`agentActionExecution`）不携带 gitUserName/gitUserEmail；平台
  自身 commit 用 `AW_INTERNAL_GIT_IDENTITY`（平台是 committer，非 Agent 身份），普通任务的
  RFC-067 identity 路径按裁决保持不动。
- **T107**：`code-capability` 与 `development-automation` 双向零 cross-context 内部 import
  （grep 实证 + rfc308 守卫升级为「code-capability 零 source-control/task-execution 依赖 +
  零 git 动词」，比原「经 public/participants 委托」更强）。
- **T108 裁决：不 drop 任何 legacy 表**。6 张 writer 私有表（`code_mr_leases` /
  `code_produced_mrs` / `code_artifacts` / `code_work_observations` / `code_fix_attempts` /
  `code_publish_intents`）已零生产消费者，但其中 artifacts/observations 带审计价值，drop 是
  不可逆信息销毁；其余 8 张仍被读面或 migrationAnalyzer 使用。表无 writer 即不再增长，清理更
  适合随 RFC-311 的保留期治理统一走。新增棘轮锁定「六表零生产消费者」——重新接上任何消费者
  即红（writer 悄悄复活的唯一信号）。
- **退役棘轮**（rfc310-architecture-lock 新增两条）：已删 writer 文件不得复活 + code-capability
  模块零写动词（唯一豁免：capability-templates 资源自身的 upstream 同步写——该资源仍有完整
  CRUD 路由且被迁移分析器读取，其退役是 PR-10 之后的独立决策）+ shared 目录无 `code-rounds:launch`。
- **诚实边界（T112 出账）**：①mission 列表读模型仍是全表无分页（`listMissionSummaries` 的
  `.all()`，PR-2 既有实现）——随 RFC-311 的列表性能治理统一处理，已通报该 session；②legacy
  `/code` 页保留 activity + metrics 两个读面 tab（历史 round/指标可追溯），其最终退役待
  legacy 数据保留期到期；③capability-templates 资源整体退役未做（migrationAnalyzer 依赖）。

## 13. 验收标准到任务映射

| Proposal AC                                             | 主要证据任务                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| AC-1 规则 byte-identical、Agent 不选动作                | T10-T12,T18,T19                                              |
| AC-2 多 Java/C++/polyglot templates                     | T13,T14,T17,T18,T85-T90                                      |
| AC-3 配置缺项/冲突显式阻断                              | T14-T19,T87,T90                                              |
| AC-4 配置 pin 与显式升级失效面                          | T13-T15,T24,T31a,T38,T91                                     |
| AC-5 direct 三形态 + 外部 ID 多文件 bundle              | T24,T33-T36,T36a,T37,T38,T38a,T39,T40                        |
| AC-6 自建 pipeline 大日志本地 bundle                    | T63-T71                                                      |
| AC-7 bundle traversal/symlink/budget/read-only          | T34,T39,T52,T65                                              |
| AC-8 exact-head、partial/unknown 不 pass                | T64,T66,T72,T80                                              |
| AC-9 nonce/port/schema/outcome/validator                | T45-T47                                                      |
| AC-10 同现场新 host task 重试 + whole-workspace fresh   | T49-T51                                                      |
| AC-11 Git/protected/evidence write 阻断                 | T43,T47,T52                                                  |
| AC-12 无 credential，Agent 自报不作事实                 | T44,T46-T48,T52                                              |
| AC-13 outcome 与真实 workspace 对拍                     | T47,T48                                                      |
| AC-14 source-control only commit/push、CAS、no force    | T48,T59,T77-T79                                              |
| AC-15 code-host union 无 merge/approve/resolve/custom   | T7,T60,T75,T84                                               |
| AC-16 feedback/CI/conflict fixed guards + single writer | T23,T26,T69,T73-T79                                          |
| AC-17 ready 可回退、merged terminal                     | T29,T80-T83                                                  |
| AC-18 不自动 resolve thread                             | T73-T75,T84                                                  |
| AC-19 临界区 crash 恢复无重发/漏发                      | T28,T30,T83                                                  |
| AC-20 RFC-294 context/layers                            | T0-T2,T21,T107                                               |
| AC-21 exact public/required DTO 无泄漏                  | T1-T3,T41,T107                                               |
| AC-22 唯一 TaskEngine 四级执行链                        | T41,T52,T107                                                 |
| AC-23 active legacy cutover、历史只读、无双 writer      | T94-T103                                                     |
| AC-24 全能力收缩/migration/真实 E2E/gate                | T104-T112                                                    |
| AC-25 new/adopt MR、branch/human push                   | T24,T59,T60,T72                                              |
| AC-26 平台/原需求系统 closed-decision 澄清闭环          | T26,T33,T38a,T55                                             |
| AC-27 polyglot 两阶段 scope/template 路由               | T18,T53,T54,T56                                              |
| AC-28 no-change/reopen generation                       | T55a,T60,T81,T82                                             |
| AC-29 indeterminate facts + exact work set              | T10-T12,T26,T73,T76                                          |
| AC-30 唯一 selector/full policy/config upgrade          | T13-T19,T24,T31a,T91                                         |
| AC-31 pipeline missing trigger/rerun                    | T63-T70,T83                                                  |
| AC-32 tracking-only handoff/attach/resume               | T22,T25,T28,T60,T80,T83,T91                                  |
| AC-33 durable wait/backoff/remediation                  | T25,T28,T30,T83                                              |
| AC-34 cancel reconcile/adopt pushability                | T24,T28,T59,T60,T81,T83                                      |
| AC-35 上传计划/seed/candidate/fulfillment 完整性        | T21,T36,T36a,T37-T40,T42,T47,T48,T56,T59,T61,T62,T80,T81,T83 |
| AC-36 业务员工说明书与统一 operations UI                | T113,T114,T118-T121                                          |
| AC-37 问题类型/producer closed envelope                 | T113,T115,T116                                               |
| AC-38 Agent/script handler 与确定性处理规则             | T115-T117                                                    |
| AC-39 child Mission/跨仓/幂等/join                      | T122-T124,T128-T129,T131-T132                                |
| AC-40 审批 prepare/submit/observe/durable wait          | T125-T132                                                    |
| AC-41 同页下一步与无指导 Journey                        | T133-T140,T156                                               |
| AC-42 浏览器零配置与跨仓审批旅程                        | T140,T160                                                    |
| AC-43 四层工具箱与节点归属                              | T144,T144a,T161-T163                                         |
| AC-44 WorkContract pin/fixture/semantic validator       | T144,T144a,T151,T165-T166                                    |
| AC-45 Event i18n 与职责文案分层                         | T147,T156                                                    |
| AC-46 复用“设置 → 限额”且无第二策略入口                 | T144b,T164                                                   |
| AC-47 通用类型包/画布/工具实现                          | T159,T161-T163                                               |
| AC-48 岗位模板最小定义                                  | T144,T163                                                    |
| AC-49 revision/retire/upgrade                           | T144a,T151,T163                                              |
| AC-50 type-neutral scope 与 canonical route             | T144,T159,T161                                               |
| AC-51 四模式同 manifest/identity/layout                 | T156,T162-T163                                               |
| AC-52 研发两职责、自动关注与回路                        | T146,T149-T153,T159-T160,T167                                |
| AC-53 平台 ExecutionContract                            | T165-T166,T168                                               |
| AC-54 通用职责泳道与回路布局                            | T167-T168                                                    |
| AC-55 按钮命名/间距与数字员工页面留白                   | T167-T168                                                    |
| AC-56 Agent 契约与托管端口原子生命周期                  | T169                                                         |
| AC-57 Webhook/轮询统一 Event Publisher                  | T170-T176,T183,T186-T188                                     |
| AC-58/59 Subscription 与 durable Delivery 统一          | T174-T177                                                    |
| AC-60/61 中立优先级与多消费者隔离                       | T173,T175,T177                                               |
| AC-62 Trigger 参数合同                                  | T174,T178,T184,T189                                          |
| AC-63 Event Center 统一 IA                              | T170,T176,T185                                               |
| AC-64/65 WorkStart 与 Task/Case lifecycle outbox        | T178-T182                                                    |
| AC-66/67/68/69 Event/Command 边界与公开目录可达性       | T182-T188                                                    |
| AC-70 可选职责与冻结启用闭包                            | T190                                                         |
| AC-71 岗位级动态问题类型分派                            | T191                                                         |
| AC-72 Event wake 后权威事实刷新                         | T192                                                         |
| AC-73 检视整树 ACK/修复/回帖与自回复抑制                | T193                                                         |
| AC-74 通用外部审批 adapter 边界                         | T194                                                         |
| AC-75 业务 contractInput 与平台调度元数据隔离           | T190-T192,T194                                               |
| AC-76 公共能力覆盖矩阵与 stateful system mock           | T195-T196                                                    |
| AC-77 20 节点职责卡片、标签与视觉防护                   | T190,T196                                                    |

## 13a. T112 交付出账（2026-08-18）

### RFC-304/309 转出账

| legacy 资产                                     | 去向                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 五能力 stage sequence 与执行器                  | **删除**（T104）。能力语义由 `development-automation` 的 capability catalog + ActionTemplate 承载 |
| enable/bulk-enable 写面                         | **删除**（T105）。配置面由数字员工 assignment（`/code/assignments`）取代                          |
| `POST /api/code/rounds`                         | **删除**。起跑入口是 `POST /api/code/missions`                                                    |
| code-round webhook 触发                         | **退役**：历史 trigger 行 fire 落 `skipped-trigger-invalid`，新建被 typed 拒                      |
| arbitrate/select/hook 决策脚本                  | **删除**且不迁移（migrationAnalyzer 一律 blocked，绝不 AI 翻译）——由 typed policy 取代            |
| capability 模板资源                             | **保留**（CRUD 路由 + migrationAnalyzer 读它出报告）；退役是 PR-10 之后的独立决策                 |
| matrix / work-items / metrics / deliveries 读面 | **保留**（T103「查询仍可追溯」）；`/code` 收缩为 activity + metrics 两 tab                        |
| 14 张 legacy 表                                 | **全部保留**（T108 裁决）；6 张零消费者表加棘轮锁定，清理随 RFC-311 保留期治理                    |

### AC 证据索引（逐条可复跑）

- **AC-1/2/3/4**（规则确定性、多语言模板、缺项阻断、pin 与升级）：`rfc310-pr1a-policy-kernel`
  （100 次重放 byte-identical）、`rfc310-pr1b-*`（13 种 publish 违规）、PR-8 的 policy
  simulator 前端对拍锁。
- **AC-5/7/26**（三形态输入、bundle 安全面、澄清闭环）：`rfc310-pr3-*` 全家 + `rfc310-pr3-journey`
  （真 HTTP + 真 adapter 子进程 + mock provider）。
- **AC-6/8/31**（pipeline 大日志、exact-head、missing trigger/rerun）：`rfc310-pr6-*`。
- **AC-9/10/11/12/13**（envelope 协议、重试、写边界、零凭据、outcome 对拍）：`rfc310-pr4-*` +
  `rfc310-pr0-detect-rollback-probe`（真子进程攻击全检出、回退 byte-identical）。
- **AC-14/25/35**（平台独占 commit/push/CAS、new/adopt、上传完整性）：`rfc310-pr5-*` +
  **`rfc310-t109-full-journey-e2e`**（真 git remote、CAS push、clone 对拍分支内容）。
- **AC-15/18**（无 merge/approve/resolve 类型面、不自动 resolve）：`rfc310-pr7-no-merge-capability-scan`
  （含源码快照）。
- **AC-16/17/33/34**（feedback/CI/conflict guards、ready 回退、durable wait、cancel/adopt）：
  `rfc310-pr7-*` + `rfc310-pr7b-*` + T109 旅程 A（feedback 修复轮真实推回 MR 分支后才回帖）。
- **AC-19**（临界区 crash 恢复）：`rfc310-pr7b-crash-matrix`（三窗）+ 决策去重吞悬挂 effect 的
  修复锁。
- **AC-20/21/22**（RFC-294 分层、exact public、唯一执行链）：`rfc310-architecture-lock`（8 条，
  含 PR-10 新增两条退役棘轮）。
- **AC-23**（cutover、历史只读、无双 writer）：`rfc310-pr9-cutover`（18 条）+
  `rfc310-pr9-migration-analyzer`（11 条）+ T109 旅程 B（adopt 起点同语义收场）。
- **AC-24**（能力收缩、migration、真实 E2E、gate）：本节转出账 + T109 两旅程 + PR-10 退役棘轮 +
  `gate:local` 全绿 + hosted CI exact SHA。
- **AC-27/28/29/30/32**（polyglot 两阶段、no-change、review、readiness、tracking-only）：
  `rfc310-pr5-analyze` / `rfc310-pr5-no-change` / `rfc310-pr5-review` / `rfc310-pr7b-handover`。
- **AC-36/37/38**（业务职责、问题生产/处理与确定性 handler）：`rfc310-pr11-employee-playbook` +
  `rfc310-playbook-coordinator`。
- **AC-39/40/41/42**（跨员工、审批、同页下一步与完整旅程）：`rfc310-employee-case-runtime` +
  `rfc310-digital-employee-system-mock-e2e` + `rfc310-pr13-journey`。
- **AC-43/44/45/46/47/48/49/50/51/52**（四层工具箱、WorkContract、i18n、限额、通用类型包、岗位/员工与研发职责）：
  `rfc310-digital-employee-authoring` + `rfc310-digital-employee-os-architecture` +
  `rfc310-digital-employee-ui-contract`。
- **AC-53/54/55/56**（平台 ExecutionContract、职责图、页面一致性与托管端口）：
  `execution-contract-platform` + `execution-contract-guide-panel` + `rfc310-digital-employee-ui-contract`。
- **AC-57/58/59/60/61/62/63/64/65/66/67/68/69**（统一 Event Center、Webhook/轮询、订阅多播、Trigger 参数、
  WorkStart/lifecycle outbox 与目录可达性）：`rfc310-event-center` + `rfc310-task-lifecycle-events` +
  `rfc310-event-center-ui-contract`。
- **AC-70/71/72**（可选职责、动态失败类型路由、Event 后权威刷新）：`rfc310-digital-employee-authoring` +
  `digital-employee-type-package-drift` + `rfc310-employee-case-runtime`。
- **AC-73/74/75/76**（检视整树协议、通用审批边界、contractInput 隔离与 stateful system mock）：
  `rfc310-pr7-mr-facts` + `rfc310-digital-employee-system-mock-e2e` + `execution-contract-platform`。
- **AC-77**（20 节点全景、关联高亮、标签与视觉防护）：`rfc310-digital-employee-ui-contract`；浏览器旅程与
  `visual-regression.spec.ts` 由 T196 作为独立 E2E/像素门运行。

### system mock E2E 自证的复跑账（2026-08-19 逐条实跑）

`/goal` 要求"最终使用 system mock 进行完整的 E2E 用例构建进行功能自证和防护"。
本节给出**可复跑的账**，而不是"跑过了"的口头结论。

| 面                                                                        | 用例                                               | mock 面                                                      | 实跑结果                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| MR 全生命周期（create-MR 起点 → 外部 merged 终态）                        | `rfc310-t109-full-journey-e2e` 旅程 A              | `startSystemMockSuite` code-host（真 bare 仓 + GitLab REST） | 2/2 绿 · 5.8s                                |
| adopt 外部已开 MR → 权威终态                                              | 同上 旅程 B                                        | 同上                                                         | ↑ 同批                                       |
| Java polyglot 全链（clone→facts→workspace→candidate→verification 子进程） | `rfc310-pr5-e2e-java`                              | 同上                                                         | 9/9 绿（四文件合计）                         |
| `mr.ensure` 幂等 / 绑定错配 typed 拒                                      | `rfc310-pr5-mr-ensure`                             | 同上                                                         | ↑                                            |
| MR facts 三读 fence / authorClass 三分类 / 回帖                           | `rfc310-pr7-mr-facts`                              | 同上                                                         | ↑                                            |
| 外部需求 ID（真 adapter 子进程 ↔ requirement provider mock）              | `rfc310-pr3-journey` + `rfc310-pr3-adapter-runner` | requirement-provider + requirement-adapter-cli               | 19/19 绿（三文件合计）                       |
| 自建门禁 collect/trigger/rerun（真 CLI 子进程 ↔ pipeline provider mock）  | `rfc310-pr6-pipeline-adapter`                      | pipeline-provider + pipeline-adapter-cli                     | ↑                                            |
| **RFC-310 全量**                                                          | `tests/rfc310-*.test.ts`                           | ——                                                           | **69 文件 / 417 用例 / 2350 断言全绿 · 46s** |

**索引可执行化**：新增 `rfc310-ac-evidence-index` 守卫——上面的 AC 证据索引点名的每个
测试文件必须真实存在、AC-1..35 必须逐条有证据、且失败关闭。变异实测三种形态全部检出
（证据文件改名 / glob 家族消失 / 漏登一条 AC）。此前这份索引没有任何东西守着：PR-10 一波
退役删了 88 个测试文件，索引指向失效不会有任何信号，"自证"会悄悄退化成"曾经自证过"。

**未由 system mock E2E 覆盖的部分（如实登记）**：Agent 进程本身在所有 E2E 里都是桩
（真实 runtime 二进制不参与——这是 T62/T109 harness 的既定边界，"除 Agent 外全真件"）；
浏览器级视觉回归属 T93 余量。

### 未竟项（如实登记，不阻塞 Done）

1. **T93 的像素快照余量**：T121 已把 `/code` 的八个业务页锁进 `visual-regression.spec.ts`
   （见 §T121 收口注记），T93 名下仍未拍快照的是 PR-8 那批**运维视角**页面的更细状态
   （错误恢复态、只读权限态的逐态快照）——功能面 E2E 由 T109 覆盖。
   〔T71 / T78 / T81 / T82 / T121 已于 2026-08-20 补齐，见对应收口注记；T71 只余 evidence blob
   的物理清扫，卡在缺一张覆盖全部生产者的引用索引——理由与正解见 §8 的 T71 收口注记。〕
2. **mission 列表全表无分页**（`listMissionSummaries`）——已移交 RFC-311 性能治理面。
3. **`/code` work-items 的 nextCursor 未接翻页**——已与 RFC-311 session 交接（其 T29 余项）。
4. **review 结果尚未升为 catalog fact**（verification 那半已于 2026-08-20 补齐，见对应收口注记）
   ——卡点不是投影而是持久化：`mr.review.external` 的 findings 目前根本不落库，要先定 findings
   的存储形态。
5. **cutover preflight 的 per-repo dry decision probe** 未做独立命令（能力由 `GET /api/code/cutover`
   的 preflight + policy simulator 覆盖）；T99 的「cancel 运行中旧 rounds」与 T103 的 soak
   只读化是 runbook 人工步骤。

### 交付后修复（2026-08-19）

Done 之后用户在 UI 上连报两条，顺查又照出两条同族缺陷。四条同一个根因族，一并记账：

| #   | 症状                                                    | 根因                                                                                                     | 处置                                                         |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `/code/config/adapters` 整页 404                        | 前端端点前缀写成 `/api/code/...`；adapter 属 integration bounded context，实际挂 `/api/integrations/...` | `f9ff00da` + 读后端源码对账的 `code-config-api-base.test.ts` |
| 2   | adapter 建不出来（`Invalid literal value, expected 1`） | 后端 create 期 strict parse，前端只交 `{name, purpose}`                                                  | `438f350d`，后并入下方共用契约                               |
| 3   | 建完数字员工点"发布" → **500 internal-error**           | `publishDigitalEmployee` 裸 `schema.parse`，空草稿的 ZodError 被兜底成 500                               | `safeParse` + `digital-employee-draft-invalid`（422）        |
| 4   | policy 详情页存下不合法 JSON 后点"发布" → **500**       | `publishAutomationPolicy` 同款裸 parse，且 `revise` 对草稿完全宽容 ⇒ 发布是唯一校验点                    | `safeParse` + `automation-policy-draft-invalid`（422）       |

**结构性处置**（不是逐个打补丁）：载荷构造与端点 base 提进
`packages/shared/src/developmentConfigCreate.ts`，创建对话框与
`packages/backend/tests/rfc310-config-create-contract.test.ts` 调**同一个函数**，后者打
`createApp` 起的真实 app 做四族 create→read→publish 全走一遍。前后端不再各存一份，
漂移无处可藏；③④ 正是这条测试补上后**当场照出**的。

**教训已落 `docs/dev-gotchas.md`**：①mock 掉的边界不构成契约证明，同一事实在两处 ⇒ 首选
共用一份 + 真实重放；②同族资源里只要有一个走裸 `.parse`，它就是那个把用户可达的校验失败
变成 500 的（服务层 ZodError 没有 422 兜底，只有路由层解析请求体那一处有）。

### 视觉基线连带刷新（2026-08-20）

`a762a707` 给侧栏加了「数字员工」分组（`lib/nav.ts` 自上次刷基线以来唯一被改过的导航源），
全站视觉基线一起失效。按 `e2e/visual-regression.README.md` 的 Option A 取 hosted 实拍图，
**分五轮**刷完 30 张 Linux 基线（`47eeafa3` / `296c178c` / `f466152e` / `dea8fece` / `4788fd76`）。
三条值得留在这里的账：

1. **多轮不是流程缺陷，是 `rfc250-visual-states.spec.ts:531` 的 serial 组**——组内一个失败即中止
   其余，所以每轮只暴露一张。事前按「截图是全页还是局部、含不含侧栏」预测了 #4–#9 的红绿，
   **四轮逐字命中**；serial 组里有 K 张要刷，最坏就是 K 轮。
2. **其中 2 张连带结算了阈值下的历史欠账**：`homepage` 的示例数据计数（RFC-307，08-17，255px）
   与 `workflow-complex-overview` 的 OUTPUT 节点图标（RFC-306，08-17，97px）。门禁
   `maxDiffPixelRatio: 0.002` 在 1280×800 上允许 2048px，这两笔一直躲在额度里、**从未单独红过**，
   被本次约 5000px 的侧栏差异顶过阈值才浮出来。所以「视觉红了」不等于「全是这次改动造成的」。
3. **`waitForStableAuthenticatedShell` 的 settle 锚点被本 RFC 弄失效了**：`/code` 从末尾被挤到
   中间。修复见 `e89d624c`——锚点改前缀匹配并由 `NAV_GROUPS` 推导（`e2e-visual-infrastructure.test.ts`
   守卫），中间还踩了一次「精确匹配 `a[href="/memory"]` 匹配不到 `/memory?tab=all`，把 2 红变成
   26 红」的坑，教训（源码守卫看不见 DOM，改选择器必须真跑一次）已落 `docs/dev-gotchas.md`。

darwin / win32 基线未动：它们积着同样的第三方历史漂移，折进来会让归因失真，而 CI 视觉门只看 ubuntu。

### 前台实走验收（2026-08-19）

按用户要求「自己从前台走一遍关键流程」：起独立 home 的 daemon + 内嵌前端逐页操作。

**走通的**：adapter 创建→发布；员工创建→空草稿发布得到具名 422（不再 500）；policy 创建→
发布 v1；仓库导入（`file://` 本地仓）；mission 发起（无员工时如实 `blocked / no-employee-match`，
时间线记 `block: policy-content-missing`）；动作模板与员工授权 JSON→发布 v1；指派绑定员工+策略；
mission 重试后推进到 `working`、readiness `automationReady: true`。**未走**：Agent 真正执行那一段
（需要已配置的 runtime 二进制），以及 MR/pipeline 的真实外部系统——它们由 T109 的 system-mock
全旅程 E2E 覆盖。

**又逮到三个缺陷**（全部"点开就见"，typecheck / lint / 单测 / e2e / CI 无一拦住）：

| #   | 症状                                                  | 根因                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | `/code/assignments` 点「新建指派」整页 error boundary | 四条 useQuery 把 `{items:[…]}` 声明成裸数组 ⇒ **该页从未能用**，而它正是 mission 解析员工的必经配置                                                                                                                                                             |
| 6   | 员工详情存草稿后整页白屏（React #31）                 | versioned ref `{id,revision}` 被当字符串塞进 JSX                                                                                                                                                                                                                |
| 7   | 员工「默认策略」永远显示「—」                         | 同 6 的另一半：`refText` 只认字符串，遇对象**静默退化**（不报错，只是说谎）                                                                                                                                                                                     |
| 8   | 「点击创建，弹窗就消失了，什么都没变化」（用户实报）  | 遮罩盖满视口，页头那颗**同名**「创建」只是透过遮罩可见、实际点不到；那一下命中遮罩 → 默认 `closeOnOverlayClick` 关闭 → 已填内容静默丢弃且不发请求。装输入的五个弹窗（配置创建 / 草稿编辑 / mission 发起 / 指派 / 策略创建）统一改 `closeOnOverlayClick={false}` |

三处共同结构：**测试 fixture 照着前端的错误假设造数据**（裸数组 / `'id@rev'` 字符串），与实现
互相印证，于是全绿。处置除修复外，补了两层机械链接：fixture 由后端 domain schema `safeParse`
裁定；列表端点形状守卫（判据表逐条 curl 真实 daemon 实测——启发式版本曾把 `/api/agents` 这类
真·裸数组误判，差点要求改正确的代码——并常驻一条判据函数自检用例）。顺带把 missions /
assignments 两处列表的仓库 ULID 显示为仓库地址。

## 13b. PR-11：业务员工说明书、问题生产与统一界面

### 目标

业务用户只定义“哪一步在什么条件下由谁做，成功/失败后去哪”；Java/C++ 是预置起点。动作模板、验证 profile、adapter、
资源 ID/revision 和 JSON 不再是员工创建/详情的必经概念。MR 问题类型、生产者和处理者都属于员工 revision，并且 Agent/
script 只生产本步结果，不选择下一步。

| 编号 | 任务                                                                                                                     | 依赖         | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------ | ---- |
| T113 | `EmployeePlaybookContentV1` strict codec、步骤/跳转/重试/问题类型/producer/handler 与 canonical compiler                 | T14,T19      | ✅   |
| T114 | 聚合 `GET/PUT/validate/preview/publish /digital-employees/:id/playbook`；一次命令保存并冻结完整 closure                  | T113         | ✅   |
| T115 | Action implementation 扩 script executor；仍经 TaskEngine→Wrapper→NodeExecutor→Kernel，统一 envelope/workspace validator | T41,T113     | ✅   |
| T116 | `ProblemSetEnvelopeV1`、只读 Agent/script producer、closed type/subject/head/evidence validator 与稳定工作集             | T67,T73,T113 | ✅   |
| T117 | handling rule 按 type+facts 选 Agent/script；same/fresh retry、fallback、重采/重验闭环                                   | T115,T116    | ✅   |
| T118 | 员工创建向导：基本信息→范围→步骤→问题处理→外部协作→完成标准；只显示业务名称                                              | T114         | ✅   |
| T119 | 员工详情改“说明书”：负责范围、步骤、问题处理、连接、仓库、运行摘要；技术 closure 仅高级折叠                              | T114         | ✅   |
| T120 | `/code`、员工列表/详情统一 `/repos`/`/webhooks` operations 骨架；移除 hero/旧活动图，任务归 `/tasks`、成效归 `/outcomes` | T118,T119    | ✅   |
| T121 | business i18n、只读权限、responsive、route/inventory、真实浏览器逐页视觉/交互回归                                        | T118-T120    | ✅   |

## 13c. PR-12：跨仓 child Mission 与外部审批 saga

### 目标

门禁问题可按员工步骤调用另一名数字员工在另一仓维护独立 MR，再由 Agent 准备审批材料、程序幂等提交、短程序观察并
durable wait；父任务按 all/any/quorum 与明确 deadline 分支继续，不占用 Agent 会话，也不让提示词递归调 Agent。

| 编号 | 任务                                                                                                                     | 依赖      | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| T122 | step-run/mission-link/approval-saga/join 表、唯一索引、OCC 状态机、migration/backup/restore                              | T113      | ✅   |
| T123 | `ChildMissionIntent/Receipt` exact codec、标准 admission participant、target repo/employee 权限与独立 workspace/MR claim | T122      | ✅   |
| T124 | parent-child 幂等 create/adopt/observe、completion condition、ancestry/depth/child/wall-time budget 与动态环阻断         | T123      | ✅   |
| T125 | `ApprovalRequestDraftEnvelope` Agent/script prepare 与 semantic validator；无 credential、不能直接 submit                | T115,T122 | ✅   |
| T126 | integration `approval-gateway` adapter：submit + lookup-by-idempotency-key + observe closed receipt                      | T125      | ✅   |
| T127 | pending→deferred wake；webhook correlation 只记 hint，timer 每次短 observe；重启保 deadline/ordinal                      | T126      | ✅   |
| T128 | all/any/quorum join、deadline/rejected/expired/unavailable/partial 分支、迟到 receipt observation-only                   | T124,T127 | ✅   |
| T129 | cancel/handoff/terminal fence：不擅自删 child MR/审批；已 dispatch 先结算，剩余观察继续可见                              | T124,T128 | ✅   |
| T130 | 员工编辑器的“调用其他员工/提交审批/等待审批/汇合”步骤卡与发布路径预演                                                    | T118,T128 | ✅   |
| T131 | stateful approval system mock + 第二 Git remote；响应丢失、乱序、重启、重复 webhook、reject/timeout 矩阵                 | T126-T129 | ✅   |
| T132 | 全 E2E：父仓红灯→child 仓 MR ready→审批 approved→父门禁重跑→父 MR ready；full gate + exact-SHA CI                        | T130,T131 | ✅   |

## 13d. PR-13：服务端 Journey 与无指导操作链

### 目标

用户不需要知道资源层级或阅读说明；从任意业务页面都能看到当前位置、下一步、负责人和触发/阻断原因。人需要操作时主按钮
与表单同页，系统自动工作时明确写“无需你操作”与下一次 wake，设置成功自动进入后继页面。

| 编号 | 任务                                                                                                                  | 依赖      | 状态 |
| ---- | --------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| T133 | `JourneyProjectionV1` strict codec、employee-setup/mission-delivery 纯 projector、projection digest 与权限降级        | T113,T122 | ✅   |
| T134 | setup/read Mission API 返回 journey；mutation 返回 nextLocation，closed command catalog 执行时重验 revision/authority | T133      | ✅   |
| T135 | 共用 `JourneyNextAction`（步骤、当前位置、负责人、唯一主动作、自动 wake/deadline）及 responsive/accessibility         | T134      | ✅   |
| T136 | `/code` 零配置决策：创建员工→发布→设置范围→首项工作；移除 hero/活动图并统一 operations 骨架                           | T135      | ✅   |
| T137 | 员工创建后直达说明书；详情 readiness/发布/范围/发任务连续动作，技术 JSON 权限折叠                                     | T114,T135 | ✅   |
| T138 | assignment 保存后同页显示“发起任务”；新建 Mission Stepper 说出后一步，成功直达详情                                    | T135      | ✅   |
| T139 | Mission 顶部 journey 覆盖回答/来源/自动执行/child/approval/blocked/tracking/ready/merged，动作与表单同页              | T128,T135 | ✅   |
| T140 | E2E-A 零配置首次上手；E2E-B 跨仓+审批+ready+merged；每停点断言 current/next/owner，刷新与重启不丢                     | T136-T139 | ✅   |

### 本轮三次实现自审（2026-08-19）

本表只审功能闭环，不把安全审计混入结论。每轮都以可执行回归锁住发现，不以页面说明代替实现。

| 轮次              | 纵向检查                                                                                                        | 实际发现                                                                                                          | 修复与回归证据                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 无指导操作链   | 从侧栏进入、创建员工、逐步选执行者、指派仓库、发任务、看任务与成效；检查每页下一步是否同屏                      | 旧页面模板仍渲染机械返回按钮；成效沿用能力构建样式；员工详情发布动作不直观；导航测试仍锁旧分组                    | RFC-310 页面 `PageHeader back` 清零；顶层固定“编排 → 数字员工 → 运行与仓库”；`/outcomes` 使用 operations 骨架；路由、导航、overlay 与页面回归锁住无返回按钮和归属                    |
| 2. 规则与生命周期 | 成功/失败跳转、producer/handler fallback、join、child、审批、handoff/terminal receipt 从头重放                  | 失败专用步骤会被数组顺序误当独立入口；已结算 producer 会继续 fall-through；旧 Mission DTO 缺 `journey` 时详情白屏 | 只从显式边进入被引用步骤；producer 使用 decision/settled/none 三态；旧 DTO 降级到原位 resume/attach；child/approval/handoff/terminal 用例锁定                                        |
| 3. 重启与数据     | daemon 重建 composition、审批 pending→approved、不同 revision 调用环、上传 seed、pipeline 大结果、本地 evidence | 审批等待虽落库但缺“重建端口后继续”的直接证明；`A@1 → B@1 → A@2` 可绕过按 revision 比较的递归阻断                  | 用同一 SQLite 重新创建 saga store 后继续观察并保留 ordinal/deadline；动态环按 employee identity 阻断而非 revision；system mock 锁响应丢失幂等 adoption、两仓隔离和大日志本地文件合同 |

当前本地证据（2026-08-20 两条浏览器旅程跑绿后重写；上一版的两处错记已就地更正）：
完整 `bun run gate:local` 全绿（backend 四分片 + typecheck / lint / format / depcheck / shared /
**system mock** / frontend），两条 RFC-310 旅程 E2E 在本机 chromium + system mock 上跑绿。

**更正一：上一版写的「当前受限执行环境不能创建 listener」不成立。** 本机可以起 listener——同一棵树上
system mock 套件与编译后 daemon + Playwright 都真跑起来了。把「跑不了」写进计划的直接后果是**没人去跑**，
于是下面这些只有真跑才会暴露的东西一路留到了交付之后。

**更正二：`gate:local` 从来不跑 system mock 用例**（CI 的 lint job 跑）。据此推上去的
`rfc310-approval` 有一条红用例（`observationIndex` 是**观察次数计数器**、不是 statuses 下标），CI 一格红才
发现。已修用例并把 `test:system-mocks` 补进 `scripts/local-gate.ts` 的 quality 车道。

### T140 两条旅程的首跑账（每条都以可执行回归锁住）

| #   | 首跑照出的问题                                                                                                                                                                     | 性质                                                                                           | 回归锁                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `digital-employee-control-center` / `code-assignments-link` / `code-launch-mission` 三个 testid 在前端源码里根本不存在                                                             | **spec 写完从未被执行过**                                                                      | 锚点改成真实 UI（build 卡片 + 服务端 journey 的唯一主动作）                                        |
| 2   | 新建 Mission 向导的 `disposedRef` 只在 cleanup 置 true、挂载时不复位 ⇒ `<StrictMode>` 双调用后上传永远被判成「页面已关闭」并删文件                                                 | **生产缺陷**                                                                                   | `code-missions-page.test.tsx`（StrictMode 渲染；「卸载后重挂载」写法是空洞绿，变异实证过）         |
| 3   | 声明 `input.kind='mission-requirement'` 的步骤在需求物化成 bundle 之前就被派发 ⇒ Agent 在**没有任何需求上下文**的工作区里被拉起                                                    | **生产缺陷**（业务说明书只写「这一步吃需求」，物化是平台的事）                                 | `rfc310-playbook-coordinator.test.ts`「materializes it before dispatching」                        |
| 4   | 该步骤的身份取 `mission.requirementBundleRef`（requirement *fact 快照*指针，每写一次 cell 就换 id）⇒ 每轮重算身份、重新认领 run、重新拉起 Agent                                    | **生产缺陷（活锁）**：实测同一步骤 110 次 succeeded、110 次 Agent 执行，links/approvals 全为 0 | 同上「keeps one identity when the requirement fact snapshot is rewritten」                         |
| 5   | read-only 动作（`approval.prepare`）覆盖 `__action.runId`，发布链据此找 candidate 现场 ⇒ 用没有业务改动的 workspace 重放 stage，得到假的 `candidate-tree-drift`                    | **生产缺陷**（多步说明书必然触发）                                                             | `rfc310-pr5-delivery-chain.test.ts`「does not steal the candidate context from its producing run」 |
| 6   | `/code` 首屏主动作的 href 是 `?create=1`，而 TanStack 默认 search 解析会 JSON.parse 每个值 ⇒ 到达路由时是**数字 1**，只认 `true`/`'1'` 的版本整个丢掉 ⇒ 零配置操作链第一跳静默断掉 | **生产缺陷**                                                                                   | `code-config-pages.test.tsx`「deep-link create flags survive TanStack search parsing」             |

E2E 侧另有两条**用例自身**的错（记下来免得再犯）：`aria-current="step"` 挂在 `li` 本身，用
`filter({has})` 一个都匹配不上、再 `.or().first()` 就退化成「第一步」；以及不显式传 `home` 时
harness 视其为自己的临时目录，`stop()` 会连库一起删——「重启不丢」那一段于是在空库上跑。

### 两条旅程覆盖什么

- `e2e/rfc310-zero-config-onboarding.spec.ts`（**E2E-A**）：零配置账号只按每页高亮的那一个动作走完
  创建员工 → 发布 → 设置范围 → 发起首个任务，每一停点断言 current/next/owner，并各断言一次
  **刷新不丢**与 **daemon 重启不丢**。
- `e2e/rfc310-digital-employee-journey.spec.ts`（**E2E-B / T132**）：浏览器发起带上传的 Mission →
  父仓实现 → 跨仓 child Mission ready-to-merge → 审批 prepare/submit/observe → 父仓 commit/push/MR →
  真实 review 事件驱动的修复轮与回帖 → committer merge → merged 终态 → `/outcomes` 可见。
  本机连跑两次稳定（3.0m / 3.1m）。

T131 的矩阵按项对账：响应丢失后幂等认领、同 key 只认同一 intent、rejected/expired/unavailable 三态、
传输故障不冒充回执、重启（客户端重建）后台账不丢，均在 `packages/system-mocks/tests/rfc310-approval.test.ts`；
第二 Git remote 与「平台只对子仓开一条 MR」由 E2E-B 断言；重复投递的幂等在 `development_wake_hints` 的
delivery-key 唯一性（`rfc310-pr2-mission-store.test.ts`）；迟到 receipt 的 observation-only 在
`rfc310-playbook-coordinator.test.ts` 的 join 用例。

**hosted CI 实跑结果（2026-08-19 `cc615ed1`）**：两条旅程在 **ubuntu 与 macos 两格全绿**；
**windows 一格红**——E2E-B 的 Agent 动作以 `step-failed:implement-parent-change:agent-contract-exhausted`
收场，当时**原因无法定位**：CI 日志不带 stub 的 stderr，而 mission 的 `blockDetail` 恒为 `null`。
处置：该 spec 曾显式 `test.skip(process.platform === 'win32', …)` 并登记进 `ALLOWED_SKIP_COUNTS`，
解除条件写在 spec 顶部（拿到 stub stderr 后定位）。E2E-A 在 windows 上是绿的。

**windows 真因定位（2026-08-20，`a6ca84ed`）**：停跑已解除，真因是
`EEXIST: file already exists, mkdir '.'`——development stub 的 `change.implement` 分支写
`mkdirSync(dirname('digital-employee-result.txt'), { recursive: true })`，而 `dirname` 是 `'.'`：
**POSIX 上是 no-op，Windows 上抛 EEXIST**。已修（`parentDirToCreate` 单点 + 纯判据回归锁
`packages/system-mocks/tests/rfc310-windows-mkdir.test.ts`），通用教训进 `docs/dev-gotchas.md` §跨平台。

**这条真因是三轮观测叠加才看见的，每一轮都补掉了一处「有信息但到不了人眼前」**：
① `blockDetail` 恒 null ⇒ 上层只有一个 typed block code（`239e8237` 修）；
② 有了 remediation，但**子进程的 stderr 从不进任何失败回执** ⇒ 只有裸退出码 `opencode exited with
code 1`——而 stub 自己的失败是 exit 2，连「是不是 stub 的问题」都判断不了（`c44f1dab` 修）；
③ 有了 stderr 尾巴，拿到手却全是压缩过的 bundle 源码碎片——尾巴按总字节取尾时，bundle 那种单行
几十 KB 的源码行一行就占满窗口；下游 `stepFailureDetail` 又 `slice(0,500)` 取头。**两处互不知情、
各切一半**（`ebafbf50` 修：逐行先裁头 + 500→2000）。
定式已进 gotchas：**给失败回执补诊断信息时，从产生点到人看见的那块 UI，沿途每一处截断都要数一遍**
——「字段里有东西了」不等于「信息到得了人眼前」。

**修掉 EEXIST 之后的下一站（2026-08-20 `a329393a` 实跑，如实登记）**：windows 那格**仍红，但停在了
完全不同的地方**，且已经走过原先炸掉的那一步——`implement-parent-change` 通过、`delegate-gate-change`
拿到 child mission `ready-to-merge`（`completionSatisfied: true`）、审批 `APP-00001` **approved**。
父 Mission 随后停在 `status: working`、`revision: 20`：
`readiness.machineHolds = [{ kind: 'upload-fulfillment-pending', detail: 'upload plan not published' }]`，
`uploadPublicationRef: null`，`effects: []`，`currentActionRunId: null`，平台侧 MR 始终没建出来。
判据：**首跑与 retry 两次停在同一个 revision、同一个 hold**（两条不同 mission），所以是确定性停机而不是
windows 慢；同 shard 的 E2E-A（零配置上手）在 windows 上是**绿**的，ubuntu / macos 两格全绿。
处置：给 spec 的 `waitFor` 加了可选 `diagnose`，超时那一刻额外取一次
`/api/code/missions/:id/decision-trace` 拼进异常消息——mission JSON 只说明「它停了」，
决策轨迹才说明「reconciler 为什么没派下一步」。本机复现不了（只在 hosted windows 上出现）、
验收 VM 当前也连不上，所以仍走「补一处观测 → 看下一轮」这条路，与前三轮同法。

**决策轨迹给出了答案（`72eda83b` 实跑）**：十条 guard **全 pass**（含 `upload-fulfillment`），
两条规则都 not-matched，`selected = { kind: 'run-verification', profileRef: '…@1' }`
——也就是说 reconciler **派了活**，卡住的是验证本身。根因结构性：本 spec 上传的验证程序是
`#!/bin/sh` 脚本、且断言其 git mode 为 `100755`，而平台解析 `repo:<path>` 之后是**直接 spawn
该路径**（`infrastructure/verificationRunner.ts` 的 `createRepoScriptResolver` 返回
`argv: [abs]`，不带解释器）。POSIX 上靠 shebang 生效；Windows 没有 shebang 语义，`.sh` 不可执行，
`100755` 也不是 Windows 检出的概念。

**处置（限定一轮兑现）**：E2E-B 在 win32 上**重新停跑**，但停跑理由已从「原因尚未定位」换成一条
结构性判据——**这套夹具本身只在 POSIX 上成立**，即便平台将来支持 Windows 的验证程序也一样；解除
条件写死在 spec 顶部（换跨平台验证程序夹具 + 去掉 `100755` 断言）。平台该不该支持 Windows 的
`repo:` 验证程序（需要一套解释器策略：显式 `interpreterRef` / 按 shebang 找 bash / 明确声明
POSIX-only）是**产品能力取舍**，已登记 `docs/audit-backlog.md` 待用户裁决，未自行选路。
同 shard 的 E2E-A（零配置上手）在 windows 上是**绿**的——停的是这条 spec 的这套夹具，
不是「数字员工在 windows 上不能用」。

顺带记两条这次暴露的**可观测性缺口**（不阻塞，但下一轮谁碰谁顺手修）：

1. ~~playbook 的 `step-failed:*` block 只带 reason 串~~ **已修（2026-08-20）**：
   `stepFailureDetail` 按 reason 反查失败的 step run → action run → attempt 回执，把
   `remediation`（如 "opencode exited with code 2"）落到 `blockDetail`；取不到就保持 null
   而不是编一句。下一次 windows 腿再红时，mission 详情与 e2e 报错里会直接带上原因。
2. e2e 的 system mock `seedCodeHost` 对同名项目返回 500 `already seeded`，Playwright 重试那一轮会
   先死在 beforeAll 上、把真正的失败盖掉。已改为每次运行生成新项目路径（两条 spec 都改了）。

### T121 收口注记（2026-08-20）—— `/code` 八个业务页的逐页视觉基线

业务 i18n / 只读权限 / responsive 早随 PR-8 的 inventory 棘轮覆盖；缺的一直是**逐页视觉基线**。
本轮补齐，`e2e/visual-regression.spec.ts` 的场景数 36 → 44：

- **六页走 route 夹具**（`e2e/code-surface-fixtures.ts`，固定 JSON 顶掉列表端点）：`/code` 首页
  导航（**停在第 3 步**，这样 done / current / next / pending 四态同框，零配置那版只画得出第一步）、
  员工列表（有内容 + 空状态两张，空状态是真实用户见到的第一页且布局完全不同）、执行器库、
  规则集列表、指派列表、`/outcomes`。真实数据里全是 ULID 与相对时间，播出来的页面每次跑都不一样，
  像素基线一天都活不下去。
- **员工详情页故意不用夹具**：它的 playbook 投影（步骤、执行器、违规项、readyToPublish、journey）
  是服务端算出来的一整套闭包，手写夹具既写不准、也会随后端演进悄悄失真。这一张播真资源、走真
  创建向导，锁的就是用户看到的那一页。
- **时区**：`toLocaleString()` 的列（policies 的 Updated、outcomes 的 Completed）按 Playwright
  的 `mask` 遮掉——列宽仍在图里，布局回归照样看得见，只有那串随机器时区变化的本地化文本被排除。
- **`/code/outcomes` 与员工详情页此前被 RFC-311 并发改写**，一度按「不给对方制造必然返工」跳过；
  RFC-311 于 `88f714b7` 收口为 Done 后按新形态补上（服务端 counts、keyset 翻页的「加载更多」）。
- darwin 基线本机已产并**连跑绿**；linux 基线按 `e2e/visual-regression.README.md` 的 Option A
  由 hosted nightly 收割（首轮**预期红**并上传 actual PNG，逐张人审后再提交）。

**这一轮基线第一次截图就照出一个真 bug**：创建向导预置的工作步骤名（`STANDARD_CAPABILITY_STEPS`
的 `displayName`）是五个**中文字面量**，而它是**落库内容**——于是英文界面创建出来的员工，整页英文里
孤零零一行「实现修改」。功能测试从不看文字属于哪种语言，只有像素基线看得见。已修：`displayName`
改由调用方按语言给（`stepName` 必填，让编译器点出全部调用点），文案进 i18n；回归锁在
`packages/frontend/tests/code-employee-playbook.test.tsx`（含「本模块不得漏出任何 CJK 字符」）。

### verification fact 收口注记（2026-08-20）—— 让 `verification.repair` 排得上

`verification.repair` 这条能力从 PR-4 起就齐了（capability 定义、envelope 成员、semantic
validator 全在），但它**永远排不上**：verification 的结果只写进 `__delivery.verifiedProfiles`
这类内部 cells，而规则谓词只能读 closed catalog 里登记的 fact。于是无论跑挂了什么，发布链一律
以 typed block `verification-failed:<profile>` 收场——组织连「失败就派修复」这条最基本的规则都
**写不出来**（写了会在 policy publish 期被 catalog 以 `unknown-fact` 拒掉）。

补的是三个 leaf（新 group `verification`，均 POST_ADMISSION）：

| fact                             | 口径                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `verification.lastOutcome`       | `not-run` / `passed` / `failed`；描述**已有结果**的整体成色       |
| `verification.allRequiredPassed` | policy 要求的每个 profile 都 passed 才为 true；**没跑完算 false** |
| `verification.failedProfileRefs` | 只收 failed，不含未跑的                                           |

「还没跑」与「通过了」必须分开——这与 pipeline 那组是同一条硬边界，也是这次特意用两个 fact
（`allRequiredPassed` + `failedProfileRefs`）而不是一个的原因：跑挂了进集合，没跑完只体现在
布尔为 false 而集合为空。

投影是纯函数 `domain/verificationFacts.ts`，在既有的 `__delivery.*` 落盘处同时写入；发布链那条
block **保留不动**——它是「没有规则接手时」的兜底，不是唯一出口（与 pipeline 完全同形：
`redispatchDelivery` 只在 `selected.kind === 'block'` 时接管，规则命中就轮不到它）。

前端 `data/policyFactCatalog.ts` 的静态镜像同步（`code-policy-pages.test.tsx` 有集合相等对拍）。
回归锁 `rfc310-verification-facts.test.ts` 五条 + 发布链用例里的真实链路断言；变异核对：去掉
投影那一行，链路断言当场红。

### T81 reopen 收口注记（2026-08-20）—— 外部 reopen 建带链接的新 generation

design §10.4 只有一句话：「后续 reopen 不让 terminal aggregate 逆转，而是由 admission policy
建立链接的新 Mission generation、重新 claim 当前 MR/head」。此前完全没接——终态 Mission 在
`runMissionReconcile` 顶部直接 `consumeWakeHints` + `terminal-noop`，reopen 投递被静默吞掉。

落点：迁移 `0191_rfc310_mission_reopen_lineage`（`development_missions.reopened_from_mission_id`）

- `application/commands/reopenMission.ts` + reconciler 终态分支的探针 + 新 outcome
  `mission-reopened`。**不复用 `development_mission_links`**：它的 `parent_step_run_id` NOT NULL，
  而 reopen 不由任何 playbook step 触发，硬塞进去等于让台账说一件没发生的事。

四个刻意的选择（都在代码注释里写了理由，这里只列结论）：

| 选择                                                                                                   | 理由                                                                              |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 触发只认 wake hint，不在每轮 sweep 探                                                                  | 终态 Mission 只增不减；每轮探一次 = 成本随历史线性增长、收益为零                  |
| **继承**原 Mission 钉住的 employee/policy，不重跑 assignment 选择器                                    | 否则一次无关的指派变更可以中途接管一条**正在进行的外部 MR**，那是运维事故不是特性 |
| `direct` 继承需求证据（复制 `development_bundle_refs` 指针行，blob 内容寻址共享）并直接 `materialized` | 正文只存在于平台自己的 evidence 里，不继承就永远物化不出需求                      |
| `external-reference` **重新采集**（source 留 `active`）                                                | 工单在 MR 关闭期间很可能已经变了，照搬旧快照 = 让新一轮基于过期需求干活           |

幂等靠 `launchIdempotencyKey = reopen:{closedMissionId}`，且是**双重**的：命令入口先查一次，
真正的护栏是该列的唯一索引（并发两条投递同时到达时 `createMission` 撞回既有行）。重新 claim
能成立是因为 `dev_mr_claims_active_unique` 是 `WHERE state='active'` 的**部分**索引——终态释放
的是 state、行本身保留，所以 (endpoint, project, iid) 三元组还能从旧 claim 行读回来（为此给
store 加了 `getMrClaim`；既有的 `findMrClaim` 只能反向查）。

回归锁 `rfc310-pr7b-reopen-generation.test.ts` 三条：正向（原终态字段逐字不动 / 后继带链接 +
adopt + 继承配置 / 重新 claim 成功且旧 claim 仍 released / 幂等第二次投递不再派生）、
「投递了但外部仍 closed ⇒ 什么都不发生」、「external 不继承旧快照」。前两条做过变异核对
（去掉 `hints > 0` 门、把 direct/external 分档改成一视同仁，各自当场红）。

**收口后当场自查出的两处接线缺陷**（写在这里是因为它们比功能本身更容易复发）：

1. **整条链原本在生产上是死代码**。reopen 探针只在收到 wake hint 时才跑，而 webhook 入口
   （`routes/webhooks.ts`）原先只对 `state='active'` 的 claim 落 hint——MR 关闭时平台正好
   释放了 claim，于是「外部重开」这件事**永远产生不了 hint**。判据抽成纯函数
   `domain/webhookWake.ts::shouldWakeForWebhook`：active 唤醒；released 且 Mission 是
   `closed-unmerged` 唤醒（这就是 reopen 信号）；其余不唤醒（merged 不接受重开、
   handoff 后 tracking-only 不该被 webhook 拽回来）。路由改为调它，并留一条源码层断言防止
   有人把逻辑抄回去。
2. **`findMrClaim` 此前不定序**。T81 让「同一条 MR 有多行 claim」从异常变成常态（每重开一次
   多一行），而唯一索引只约束 `state='active'`。不定序时多行返回哪一条由 SQLite 说了算，
   而它的调用方只关心「现在归谁」。改为 active 优先、同态取最新；变异核对：去掉 orderBy
   当场红。

**如实登记的残留**：`reopenedFromMissionId` 目前只驱动行为、**未上 UI/API DTO**（列表投影按
RFC-311 的性能判据只取 18 列，详情 DTO 与契约登记属 PR-8 的 UI 面）；接手时若要在时间线上
显示「本任务由 X 重开派生」，加的是读模型与契约登记，不需要动本次的写侧。

### T78 收口注记（2026-08-20）—— conflict repair 的 Agent 执行面

首版把 repair 模式停在 typed block `conflict-repair-agent-surface-not-wired`：source-control 的
prepare/finish 已在（T77），缺的是「怎么把那个冲突现场交给 Agent、以及解完之后怎么发布」。本次按
design §8.5 的六步逐条接完：

| 步  | 落点                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | `__mr.targetSha` 投影进 cells（此前只落 refsJson，决策面读不到 T，合并方向无法在 launch 时冻结）                                                                                                             |
| ②   | `run-agent-action` arm 在 `workspaceMode === 'edit-conflicts'` 时从 `__mr.headSha`/`__mr.targetSha` 冻结 S/T                                                                                                 |
| ③   | launch 走 `conflictMerge.prepare` → `actionWorkspace.adopt`（**不**走 materialize：现场含 .git/MERGE_HEAD，重建不出来）；seed overlay 一律不叠；validator 的 `writablePrefixes` = 平台标记的冲突集           |
| ④   | 收口的语义闭集 `closedRefs.conflictPaths` 注入 `conflict.repair` validator（`conflict-path-outside-markers` PR-4 已备）                                                                                      |
| ⑤   | `conflictRepairDelivery.publishConflictRepair`：finish 双 parent merge commit → `candidateDelivery.push` 对 **S** 的 exact-head CAS（effect 台账 `conflict-push`）                                           |
| ⑥   | push 撞 `remote-head-changed` ⇒ typed `conflict-head-changed`：整树废弃 + facts 判过期，**不进 agent-contract 重试预算**（同一现场重跑必然再撞，只会烧完预算后以完全误导的 `agent-contract-exhausted` 收场） |

care 链同步接三条 policy 边界（都在 takeover **之前**判——规则命中 conflict.repair 时 selected 不是
静止态，放进 takeover 就永远轮不到）：`maxRepairAttempts` 触顶 ⇒ `blocked(conflict-needs-committer)`
（含失败轮，且只在无在途动作 + facts 新鲜时判）；report-only 却路由了 conflict.repair ⇒
`blocked(conflict-repair-disabled-by-policy)`；repair 模式但组织没配规则 ⇒ `wait(conflict-repair-not-routed)`。
Agent 自己交 `blocked` outcome 时 block code 也收敛为 `conflict-needs-committer`（design §8.5 的措辞）。

顺带补两处只在生产才会暴露的接线：`prepareConflictMerge` 现在摘 origin + 写 RFC-308 exclude 并接受
`workspacesRoot`（现场要交给 Agent 跑，就必须与普通 action workspace 同形、且落 appHome 之下，否则
RFC-308 的 owner 门直接让 task 起不来）；push 成功后 `__delivery.pushedSha` 必须一起前进——MR source
head 已经是这个 merge commit，后续任何 fast-forward 发布都以它为 CAS 期望值。

新增 `countActionRuns(missionId, capabilityId)`（预算算的是「平台替人试了几次」，失败轮尤其要算）。
回归锁：`rfc310-pr7b-conflict-repair-journey.test.ts`（真 git + 真 bare remote 的三条——正向双 parent
CAS 发布 / 越界改动被 **workspace 对拍**判 `write-outside-allowlist` 且远端纹丝不动 / S 被人推动后
CAS 拒绝且不覆盖别人的提交）、`rfc310-pr7b-conflict-merge.test.ts` 的现场形态与 finish 幂等重入、
`rfc310-pr7-mr-care-chain.test.ts` 的三条 policy 边界。

**如实登记的残留**：conflict repair 只走 exact S/T 的一次性现场，没有「解到一半保存进度」的形态；
repair 预算按 Mission 全生命周期累计（不按 head 重置）——两者都是当前的有意选择，不是遗漏。

## 13e. PR-14～PR-18：数字员工操作系统实现

### 目标与实施记录

把 RFC-310 从“研发 Mission 的步骤编排”提升为可程序化注册代码、设计、测试等员工类型的公共数字员工 OS。旧实现是
迁移来源：Envelope、Script、TaskEngine、source-control、代码平台调用、Connection/Token、evidence 与 MR care 均优先
复用；禁止在新模块复制执行器、Git、Token 或 provider adapter。

本节已于 2026-08-21 获得实现和直接提交授权。实施前置项的实际结果：

1. proposal/design §0A 的目标设计与四层配置层级经用户逐轮确认；
2. RFC-294 bounded-context owner、最小 public surface 与 migration residual 已同步，专项 exact dependency manifest 可执行对拍；
3. live baseline 与旧 writer/poller/wake/child/executor/Token 调用面完成盘点，切换采用“冻结新 Mission admission、存量 drain”，不做不可证明的在途机械 adoption。

### 提议任务

| 编号  | 任务                                                                                                                                                               | 依赖                | 状态 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---- |
| T141  | 在 proposal/design/plan 落 OS、四层配置层级、WorkContract、分类工具箱、共享限额快照、确定性职责图与执行底座复用的规范修订                                          | 用户本轮确认        | ✅   |
| T142  | 钉住 live baseline，盘点 Mission/wake/resumeAt/poll/child/link/join/mr-care/TaskEngine/source-control/code-host/Token 全调用面                                     | 设计批准            | ✅   |
| T143  | 更新 RFC-294 owner 清单与 dependency manifests：新增 `digital-employee`、`event-center`，禁止 bootstrap/类型分支与跨 context internal import                       | T142                | ✅   |
| T144  | Employee Type Package SDK：strict codecs/compiler、WorkItem/WorkContract、AuthoringManifest、JobTemplate、员工 definition 与程序化发布 API                         | T143                | ✅   |
| T144a | 分类工具注册：`type + work item + contract` 闭合 API、Agent/Workflow required ports、ProgramTool 规范/Script 接线、fixture receipt、岗位默认与员工 override        | T144                | ✅   |
| T144b | 从“设置 → 限额”物化不可变执行快照：same/fresh-scene 复用已有额度，固定 backoff/deadline/handoff 属平台合同，Case admission pin 且无独立设置入口                    | T143,T144           | ✅   |
| T145  | EmployeeCase、ContextRecord/Link、artifact refs、ExternalContextBinding、OCC/lease/outbox/backup-restore                                                           | T144                | ✅   |
| T146  | Context Assembler/materializer：外部 ID/上传/证据只传 refs，MR/commit Context Envelope 的 adoption/recovery 对拍                                                   | T145                | ✅   |
| T147  | Event Type/Source catalog、i18n 显示名/说明、Subscription、EventRecord/Delivery strict contracts 与 Webhook/internal-event ingestion                               | T143,T145           | ✅   |
| T148  | ObserverActivation：0→1 激活、1→0 draining、batch subjects、cursor/lease/backoff、baseline scan、hybrid dedupe、restart recovery                                   | T147                | ✅   |
| T149  | AttentionRule pure compiler + desired/actual reconcile；Context transition 后自动订阅/取消且 crash 不漏看                                                          | T145,T147,T148      | ✅   |
| T150  | EmployeeCase durable queue：priority/tie-break、dedupe/coalesce/obsolete、单 active Round、terminal fence 与事实重采                                               | T147,T149           | ✅   |
| T151  | ReactionRule/Round/Plan：按当前工作项 deterministic 选 exact tool registration，输入输出合同、validator、Case global policy 与 effect closure 全 pin               | T144a,T144b,T150    | ✅   |
| T152  | 接现有 TaskEngine→WrapperRuntime→NodeExecutor→Kernel；证明 Agent no-Git/no-code-host、Script exact envelope，零第二 executor                                       | T151                | ✅   |
| T153  | 复用 source-control candidate/commit/CAS push 与 integration code-host Connection/Token；typed intent/receipt、adopt/recovery、merge/approve 不可达                | T151,T152           | ✅   |
| T154  | EmployeeInvocation/Channel/Result Envelope、child Case create/adopt、parent DelegationContext 与公开 milestone 订阅                                                | T145,T149,T151      | ✅   |
| T155  | all/any/quorum、deadline/partial/failure、ancestry/depth/budget/cycle、ready receipt 重验、parent cancel 默认 detach                                               | T154                | ✅   |
| T156  | 公共运行投影：本地化 Event、Case Context/关注/队列/Reaction/Observer/child channel 与同页下一步，隐藏业务页 machine ID                                             | T144-T155           | ✅   |
| T157  | 迁移 analyzer 报告存量 Mission/MR claim/child/approval；无法证明可机械映射时显式阻断，不伪造影子 adoption                                                          | T142-T156           | ✅   |
| T158  | writer generation 单切：冻结旧 Mission 新 admission、存量 claim 原 writer drain；新 Case 独占新 admission，禁止 active adoption 与同 MR 双 writer                  | T157                | ✅   |
| T159  | 设计、测试两个最小类型包 fixture + proposal §0A.11 研发完整 type package，证明 OS core 与前端无 `if type === development`                                          | T144-T158           | ✅   |
| T161  | 数字员工通用 IA：`/digital-employees` 分类目录与每类“员工/工具箱/适用范围”页签，复用 operations 外观，旧 `/code`/executors/assignments 跳转迁移                    | T144,T156           | ✅   |
| T162  | 单一固定职责图四模式：toolbox/job-template/employee/runtime 共用 workItem identity 与布局；生命周期背景、全量节点、合同 receipt；无 edge drag/阶段下拉/全局 picker | T144a,T159,T161     | ✅   |
| T163  | 岗位模板与最小员工编辑器：模板只存默认工具；员工只存分类/模板/名称启停/范围/工具覆盖；缺工具深链并恢复草稿；无 Event/Context/effect/retry                          | T144a,T161,T162     | ✅   |
| T164  | 删除独立数字员工策略页/API，复用“设置 → 限额”；节点/工具/分类/员工 DTO 负扫描 retry 字段为零，在途 Case 保持 admission 快照                                        | T144b,T156,T161     | ✅   |
| T160  | 真实 E2E：分类工具注册→员工发布→任务；主动轮询0/1订阅、Webhook+poll去重、MR自动关注、红灯修复、跨仓返回、审批、committer merge、重启/乱序/重复矩阵                 | T148-T159,T161-T164 | ✅   |

### 功能自审记录

| 轮次                          | 自审问题                                                                 | 发现                                                                                                                | 处置与回归证据                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一轮：真实集成闭环          | 从外部问题 ID 到父/子真实 MR、门禁、审批、committer 合入是否只靠生产接线 | 审批 intent canonical digest 不一致；Case ID 污染 Git ref/path；同 MR 的后续门禁采集重复创建 Pipeline Context       | 统一 canonical digest；引入稳定 identity/ref 编码；重复采集更新现有 Context；全旅程 system-mock E2E 走真 bare remote、真 adapter CLI 与大日志               |
| 第二轮：跨阶段 Context 可移植 | 创建 MR 后，数字员工能否仅凭 MR/commit 恢复问题来源并自动关注下一阶段    | commit/MR 没有最小 recoverable Context Envelope，阶段间仍依赖本地 Case 记忆                                         | commit message 与 MR description 同写 Case/Context/schema/work-item envelope；external subject binding 可反查 Case；delivery policy 与 system-mock E2E 锁定 |
| 第三轮：业务运行可读性        | 用户能否在同页看懂“现在发生了什么、关注什么、下一步是什么”               | 运行页误用员工配置模式，waiting 状态和 machine ID/state 直接暴露                                                    | 改用 runtime graph；本地化事件/状态/下一步；业务页隐藏 raw Case/Event/round/channel ID；UI contract 锁定无阶段下拉、无连线拖拽、同节点工具入口              |
| 第四轮：RFC-294 边界          | 新 OS 是否又长出跨域内部 import、万能 Event port 或 bootstrap 类型分支   | integration observer 穿透 development internal；Event participant 膨胀到 6 方法                                     | approval subject 改走 exact public contract；观察控制与 Case 订阅/投递拆口；`os-architecture-manifest.json` 与 RFC-294 preflight 双棘轮全绿                 |
| 第五轮：配置闭包与规模        | 四层 authoring 是否能在真实路由、升级与大量存量任务下保持确定且有界      | 37 个新端点漏 API 契约；迁移报告三次无界读取；schema migration 写入业务资源会污染纯升级；递归 JSON 类型压垮路由推导 | 全量补 registry；报告改成精确计数+最多 100 条明细和批量聚合；内置 Agent 改由 boot 幂等播种；序列化投影先校验再原样响应；57 条聚焦回归与完整本地门禁全绿     |

### 批次停止条件

- Event Center 或 Context 被塞回 `development-automation` 内部，只能服务代码员工；
- 数字员工/Observer 绕过现有 TaskExecution 自己 spawn Agent/Script；
- 新增第二套 repository token、code-host adapter、Git commit/push 或 Workflow runtime；
- 订阅依赖一次性尾调用而不能从 Context 重建；
- 父员工同步持有进程等待子员工，或父 Agent 直接 spawn 子 Agent；
- Event payload/DB/prompt 承载完整流水线大日志；
- 旧 Mission 与新 EmployeeCase 同时写同一 MR；
- 开发员工专用字段进入通用 OS core 或通用 UI 出现 `if type === development`；
- 工具箱退化为无分类/工作项/WorkContract 的全局执行者列表，或员工 picker 直接读取底层资源库；
- 增加工具仍要求选择阶段/工作项，或职责图允许拖拽连线、改变类型包拓扑；
- Event machine ID 作为业务主文案，或 Event 与工作项用同义标题重复表达；
- retry/fresh-scene/backoff/budget 出现在分类、工作项、工具或员工 DTO/UI 中，或另造数字员工策略入口而不复用“设置 → 限额”；
- 通用 employee/assignment/invocation DTO 硬编码 repository，或新分类仍必须经过 `/code` canonical route。

## 13f. PR-19：平台执行契约与职责泳道

### 目标与任务

本批把“每个实现自己约定如何喂输入/收输出”收回平台机制层，并修正职责全景把 MR 看护节点误画成顺序清单的问题。
业务 `WorkContract` 与平台 `ExecutionContract` 分层：前者由员工类型包定义业务完成标准，后者统一 executor transport、
兼容校验、fixture、exact output 和运行结算。画布拓扑仍由类型包固定，但新增业务可读的职责泳道而非自由编辑器。

| 编号 | 任务                                                                                                                                                                                                                         | 依赖           | 状态 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---- |
| T165 | 新增 `execution-contract` bounded context：strict guide/transport/ref、Agent/Workflow/Program compatibility、真实 Script fixture、exact output validator 与窄 participant                                                    | T143,T151      | ✅   |
| T166 | 接 authoring/runtime/UI：外部 ID 直接 `contractInput`、大输入 env/file、Agent 显式声明和 `agent-result`、Program 起始代码、Plan 冻结前输入与编辑/发布/结算输出同一 exact validator                                           | T165           | ✅   |
| T167 | AuthoringManifest 增 `spine/branch` 职责泳道与完整性校验；通用画布实现主干居中、职责横排、自循环和外侧回路；研发 MR 看护拆成事件主干与五条职责支线；先以 `development@2` 追加发布；同步页面留白和任务按钮                    | T144,T159,T162 | ✅   |
| T168 | 多轮功能自审、聚焦/系统链路/视觉/完整门禁、RFC-294 owner 账与 exact-SHA hosted CI/visual 终态验证                                                                                                                            | T165-T167      | 🚧   |
| T169 | Agent 执行契约选择移入输入/输出页；`agent-result` 显示为不可单改的契约托管端口；选择/切换/取消时原子增删端口与 sidecar；create/update/bundle/intent 共用服务端规整命令；公共 guide 改为窄运行投影 + 已校验序列化 exact guide | T165,T166      | ✅   |
| T170 | Event Center 从数字员工页迁为“运行与仓库”的全局入口；新增独立 `event-sources:*` 权限，数字员工只保留 Attention/订阅投影与跳转                                                                                                | T147,T161      | ✅   |
| T171 | 自定义轮询来源 authoring：同 ID 草稿修订、Script/事件合同/周期/批量/入库规则、真实 fixture、immutable publish/retire 与 exact catalog 注册                                                                                   | T147,T148,T165 | ✅   |
| T172 | 自定义 Observer adapter：固定 input file/stdout envelope、event key 闭集映射、平台 dedupe/入库、按订阅启停、cursor/lease/restart；API/UI/E2E 覆盖完整用户链路                                                                | T170,T171      | ✅   |
| T173 | Event Center 中立化：从 Event Type/Delivery 移除 priority，ReactionRule 持有代码员工队列 priority/preemption；历史存储列迁移清理与乱序回归                                                                                   | T147,T150      | ✅   |
| T174 | 统一 Publisher/Subscription 合同：Webhook 注册 push source/type，Subscription 封闭联合 exact/filtered，selector directory 与 bounded routing facts，不允许 ingress 直接旁路启动                                              | T147,T170      | ✅   |
| T175 | 统一 durable Delivery/notification：automation subscriber adapter 复用既有 webhook owner/ACL/串行/熔断/supersede/terminal fence；delivery lease/retry/dead-letter、重启恢复与单 writer 切换                                  | T174           | ✅   |
| T176 | 重做全局事件中心 IA：事件来源统一展示 Webhook/轮询；“实时订阅”统一展示 Attention 与 Webhook 响应规则；投递/观察健康同域可见，旧 `/webhooks` 仅兼容跳转                                                                       | T170,T174-T175 | ✅   |
| T177 | 多消费者传输不变量：immutable EventRecord、`(eventId, subscriptionId)` 唯一 Delivery、独立 ACK/lease/retry/dead-letter 与审计保留；exact/filtered 多播和一方失败隔离回归                                                     | T174,T175      | ✅   |
| T178 | source-neutral WorkStart：automation target 封闭联合 orchestration/digital-employee，统一 event origin、TriggerContext、delivery 幂等与结果投影；数字员工 intake 从已发布类型合同 authoring                                  | T175           | ✅   |
| T179 | Task owner lifecycle outbox：初始与每次 status CAS 同事务写 stable observation，公共 worker 按“设置 → 限额”重试并发布到 Event Center；多订阅者回归                                                                           | T175,T178      | ✅   |
| T180 | EmployeeCase owner lifecycle outbox 与 event-start provenance：Case 状态事务发布、同 delivery 重入采用已有 Case、员工/父任务可订阅公开 Case 状态；禁止内存回调                                                               | T175,T178      | ✅   |
| T181 | Webhook 响应规则编辑器增加数字员工目标：只列 published/enabled 员工，读取类型 WorkIntakeContract 渲染 target/body/external-id，触发记录深链到 Case；文件上传保持显式人工入口                                                 | T176,T178      | ✅   |
| T182 | 收敛 Event/Command 边界：移除 initial work event/attention/outbox，类型包声明 `workStartWorkItemRef`；首次 Case 直接进入确定工作项，后续只响应真实 committed fact                                                            | T178,T180      | ✅   |
| T183 | 统一代码平台来源：`code-host.activity@1` 同时承载 push/poll；旧 Webhook occurrence matrix 标记 compatibility，员工复核信号标记 internal，公开目录只展示权威业务事件，exact revision 冲突 fail closed                         | T174,T182      | ✅   |
| T184 | 来源无关响应规则：目录动态选择全部带 TriggerParameterContract 的公开事件，支持四类 WorkStart target、subject all/exact/prefix、独立多播投递与运行结果                                                                        | T176,T178,T183 | ✅   |
| T185 | 万级运维读面：EventRecord/Subscription/Delivery 服务端分页与索引；来源审计扩为全局事件记录，Webhook 原始入站单列兼容视图；订阅数按 exact+filtered 实值聚合                                                                   | T170,T176      | ✅   |
| T186 | 代码平台事件可达性：每个已支持 Webhook occurrence 同时发布 public `code-host.*` business fact 与 compatibility fact；public 合同统一注入 `trigger.code_host.*`，目录与响应规则选择集合完全一致                               | T183,T184      | ✅   |
| T187 | 存量事件升级闭环：旧入口/MR/协同/审批类型降为 internal；活跃 MR Attention/Subscription/ObserverActivation 迁到统一来源；协同与审批双发 public fact；目录过滤空内部来源并锁定 immutable revision 启动兼容                     | T173,T183,T186 | ✅   |
| T188 | 退役早期持久化的第二套 `code-host.webhook` 公开目录：历史 revision 保留为 compatibility，升级后公开目录与新增订阅只呈现统一 `code-host.activity`；迁移与真实新库页面锁定                                                     | T183,T187      | ✅   |
| T189 | 自定义事件参数合同交互：每事件显式配置 namespace，区分机器参数键与界面显示名称，实时展示完整路径；参数行使用非持久化稳定编辑 ID，逐字输入不重建/丢焦点                                                                       | T171,T184      | ✅   |

T168 的 PR-19 基线于 2026-08-21 完成：当时完整 `gate:local` 8m31s 全绿（backend 11,622 pass / 36 skip / 0 fail，
frontend 6,669/6,669，shared 2,219/2,219，system-mocks 35/35）；真实用户旅程、数字员工视觉基线、system-mock
全链与 Event Center dbVersion=199 实页均独立复跑通过。实页锁定公开目录 15 个事实/唯一代码平台来源，以及参数键逐字
输入焦点和 `trigger.issue.issue_id` 实时路径。PR-20 修改后的 gate/visual/hosted 结果必须重新取当前提交证据，不能继承这组早期数字。

## 13g. PR-20：可选职责、动态分派与 system-mock 覆盖收口

### 目标与任务

本批把研发数字员工从“图上看起来完整”收紧为“用户只配置实际职责、事件先刷新真实现场、每条外部闭环可执行复验”。公共 OS 与
开发类型包分开验收：前者证明可被后续设计/测试员工复用，后者必须在 RFC-304 的 stateful system mock 底座上证明真实 Git、代码平台、
Agent/Script、审批和事件生命周期，而不是用 application 内存 fake 自证。

| 编号 | 任务                                                                                                                                                               | 依赖      | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| T190 | Manifest lane 增 `optional`；员工编译冻结 `enabledWorkItemRefs`，无配置不阻断/不订阅，部分配置按泳道合同 fail closed；职责图显示可选状态并移除端口圆圈/共享干线    | T167      | ✅   |
| T191 | `orderedDispatchAuthoring` 与岗位级配置：任意失败类型、列表优先级、唯一末尾 fallback、每类 exact 工具或协同目标；运行时逐类确定性分派                              | T190      | ✅   |
| T192 | ReactionRule 增 `capabilityWorkItemRef`；检视/冲突事件由可选职责控制启用，但实际先执行平台 `observe-mr`，按权威新 Context 再进入处理节点                           | T173,T190 | ✅   |
| T193 | 检视线程全树采集、revision、自有标记、修前 ACK、Agent 每线程 resolution envelope、平台 push 后结果回帖和 replay/self-loop 抑制；内置检视修复 Agent                 | T192      | ✅   |
| T194 | 外部审批保持通用 prepare/submit/observe adapter 边界；审批泳道可选；平台调度配置不注入 Agent/Script 业务 `contractInput`                                           | T165,T190 | ✅   |
| T195 | 新 OS stateful system mock 扩成四仓：父子员工、审批/大日志、真实 Git/MR、同一检视 thread 多轮评论、ACK→Agent 修复→push→回帖、自回复重放、committer 合入；45 个断言 | T191-T194 | ✅   |
| T196 | 建 design §15.8 公共能力矩阵并逐组复跑；浏览器锁 20 节点、可选职责、动态关系、无横向溢出；人工检查并刷新三幅目标视觉基线；完整 gate 与 exact-SHA hosted CI         | T190-T195 | ✅   |

### 当前可复跑证据

- 公共平台合同/运行：`execution-contract-platform`、`rfc310-digital-employee-os-architecture`、
  `rfc310-digital-employee-authoring`、`rfc310-employee-case-runtime`、`rfc310-digital-employee-os-worker`。
- Event Center：`rfc310-event-center` 覆盖目录、source、订阅启停、Observer、Webhook nudge、晚订阅、A-B-A、批量、去重、
  exact/filtered 多播及失败隔离；task lifecycle 和 0193–0199 migration tests 单列保持旧 Webhook 功能。
- 外部状态：`rfc310-employee-workspace-delivery`、`rfc310-pr7b-conflict-repair-journey`、旧
  `rfc310-t109-full-journey-e2e` 与新 `rfc310-digital-employee-system-mock-e2e` 均使用真实 Git/HTTP 边界。
- 检视协议：`rfc310-pr7-mr-facts` 锁完整 thread/self marker 事实；新 system mock 以 45 个断言锁先 ACK、完整树输入、commit 后回帖、
  自回复不重触发与最终外部 merge。
- 浏览器：零配置 3 条 + 完整员工旅程 1 条；目录/全景/工具弹窗 3 条 macOS 目标视觉基线无更新参数复跑通过。

当前工作树最终本地门禁（2026-08-21）：`bun run gate:local` 8m30s 全绿，backend 四个随机分片合计
**11,624 pass / 36 skip / 0 fail**，frontend **6,674/6,674**，shared **2,219/2,219**，system-mocks
**35/35**，typecheck/lint/format/depcheck 全绿；第一轮唯一 lint warning 已删除后从头重跑，不能用第一轮局部结果代替本次终态。

最终 hosted 终态（2026-08-22）：功能/视觉冻结提交为 `96df8c49c84d532e630f0b8346cbde4787e811cd`；
[CI 32502058325](https://github.com/wangbinquan/agent-workflow/actions/runs/32502058325) **31/31 jobs success**，
[visual 32502058323](https://github.com/wangbinquan/agent-workflow/actions/runs/32502058323) **55/55 tests success**，无失败或取消。
T196 的本地完整门禁、推送、exact-SHA hosted CI 与 visual 四项条件均已满足。

### 功能自审记录

| 轮次                         | 自审问题                                                                         | 发现                                                                                                    | 处置/锁定                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 第一轮：输入可消费性         | 只给问题 ID 时，Agent/Script 是否能直接得到字段；大输入是否仍依赖 prompt         | 旧 WorkContract 只有 schema 名，没有 transport 和字段来源；脚本作者不知道 env/stdout                    | 平台 guide 给字段来源、transport、示例；外部 ID 直投影；Script 同时支持 inline/file 并提供三种语言起始代码    |
| 第二轮：发布前确定性         | 能否在选择工具时知道 Agent/Workflow/Program 真能消费/产出，而不是运行时才猜      | 前端可能按 Agent 名称硬编码；Program 只保存文本；输出可能夹 Markdown/多字段                             | 平台批量候选 receipt；Agent 声明 exact contract；Workflow structural closure；Program 真 runner fixture       |
| 第三轮：运行结算复用         | 编辑期通过的合同是否与真实 Reaction 输入、prompt、Script port 和最终结算完全同源 | Script 旧 host 固定 `prompt` input；只做业务 semantic validation 会漏 extra/cross-run                   | host input port 显式化；平台先对拍 exact fields/round/nonce，再调用类型 semantic validator                    |
| 第四轮：职责关系可读性       | MR 看护的检视、流水线、冲突、审批和合入判断是并行反应还是一条顺序链              | 节点按全局 order 平铺，人的职责、事件入口和回路无法辨认                                                 | manifest 声明主干/职责支线；支线内横排、支线间分隔，回边使用短虚线外侧通道；纯布局回归锁几何关系              |
| 第五轮：横向扩展与界面一致性 | 新设计/测试员工是否仍能复用；全景、窄屏、operations 留白和任务动作是否一致       | 不能把 `care-*` 写进通用画布，也不能为窄屏折叠掉全景                                                    | 通用组件只读 manifest；窄屏横向滚动；所有数字员工页面统一 body padding；任务入口改“新建编排任务”并复用间距    |
| 第六轮：拓扑与视觉证据       | 图上的每条边是否真有运行规则；20 节点是否真的都进入视觉证据                      | 三条旧后继是伪关系；多类流水线错误缺自循环；1280×800 组件截图裁掉最下方合入判断泳道                     | manifest 对齐 settlement；剩余失败类型回到修绿；虚假直达边删除；组件证据临时增高并锁定回环/协同/就绪关键边    |
| 第七轮：平台入口唯一性       | 新员工类型或测试装配能否遗漏平台契约后继续发布/运行                              | authoring/runtime participant 仍为 optional，并保留旧 resource/fixture 校验 fallback                    | 三处 composition 改为 required；删除旧旁路与重复 inspector/Program fixture；架构棘轮锁定不存在 optional 路径  |
| 第八轮：Agent 端口生命周期   | 契约和端口是否能分别编辑，或通过 API/bundle 保存“有契约无端口/删契约留端口”      | 契约原在能力页且只 append `agent-result`；取消、切换和端口单删均不联动；完整 guide 还形成 42 叶公共 DTO | 选择器移入输入/输出；托管端口无独立动作；保存入口统一规整；公共面收窄为 runtime view + strict `guideJson`     |
| 第九轮：多消费者隔离         | 一个 Webhook 命中多条规则时，一方失败是否会结算或污染其他消费者                  | 旧 dispatcher 让每个规则共写同一 WebhookDelivery 状态，首个失败可覆盖共享审计                           | 共享行只记录 ingress/routing；每个订阅独立 Delivery/lease/retry/dead-letter；双规则一成一败全 HTTP E2E 锁定   |
| 第十轮：模块边界最小能力     | Event Center 是否能拿到 Webhook DB、全量 dispatcher 或业务启动内部               | provider adapter 曾跨层拿 DB/服务，EventCenter dispatcher 类型还附带 endpoint-wide dispatch             | 拆 integration domain/public/port/infrastructure；适配器仅依赖 required SPI；exact manifest 与源码棘轮锁定    |
| 第十一轮：Webhook 失败窗口   | 原始行落库后 Event publish 失败或响应丢失，Resend 是否漏触发或重复启动           | `received` 行会占住 UUID；Event dedupe 又使用易变化的原始行 ID                                          | publish 失败置 failed 释放 UUID；identity 改 provider UUID；duplicate re-observe 并唤醒 pending Delivery      |
| 第十二轮：坏持久化定义       | 员工 revision/type package JSON 损坏时，规则编辑能否得到稳定错误而非 500         | `safeParse(JSON.parse(...))` 仍会先抛原生 SyntaxError                                                   | 持久化 JSON 先防御解析；分别稳定返回 employee definition/intake contract 422；独立回归锁定                    |
| 第十三轮：事实与入口边界     | “工作入口”和“MR 观察”是否被误建成事件，Webhook/poll 是否各造一套公开类型         | 首次 Case 曾伪造 work event；代码平台目录同时暴露 ingress occurrence 与权威 MR fact                     | WorkStart 改直接命令；同一 hybrid source；compatibility fact 不进公共目录；首步/目录回归锁定                  |
| 第十四轮：目录与选择闭环     | 目录中 Task/Employee/自定义事件能否直接配置响应，而非只能选静态 Webhook 枚举     | 旧 TriggersPanel 硬编码 `CODE_HOST_EVENT_TYPES`，非 Webhook 事件只能看不能选                            | 新标准响应规则直接消费 catalog；仅按公开性和参数合同筛选；四类 target 和参数注入同屏                          |
| 第十五轮：大表与来源审计     | 几万条订阅/事件/入站是否仍整表物化或纵向堆叠；来源订阅数是否真实                 | 审计读面与创作入口混排，Webhook/raw 与标准 Event 混作“来源审计”                                         | 三个审计面独立分页；来源数 exact+filtered 聚合；标准 Event 与 Webhook ingress 分视图                          |
| 第十六轮：事件语义可达性     | “关注 MR”与“工作入口”是否仍伪装成事件；公开代码平台事实是否全部能选              | 周期门禁复核曾以“流水线状态更新”公开；旧 Webhook matrix 隐藏后缺少可配置的代码平台业务事实              | 周期复核改 internal；WorkStart 仍为直接命令；11 类 `code-host.*` public fact 与响应规则同源，raw 仅兼容       |
| 第十七轮：存量升级连续性     | 已登记 revision 和运行中 Attention 能否在重构后继续启动；内部来源是否留下空目录  | 直接改 `development.*@1` 会触发 immutable conflict；旧 MR activation 若只改类型包会停止轮询             | 旧 revision 只改 visibility；MR 订阅/attention/activation 数据迁移；审批/协同双发公开事实；真实启动与迁移测试 |
| 第十八轮：持久化目录唯一性   | 新代码只注册统一来源时，升级库是否仍因旧 catalog 行出现两套 Webhook 目录         | 生产形状库仍有 `code-host.webhook@1` 及 11 个 public type，与 `code-host.activity@1` 并列               | 0199 保留不可变行并降为 compatibility；滚动升级、新库目录 15 个公开事实和唯一代码平台来源实页验证             |
| 第十九轮：参数合同可编辑性   | 自定义来源作者能否理解并稳定输入完整 Trigger 路径                                | namespace 被隐藏并写死 `custom_event`；参数行用 fieldId 作 React key，逐字输入即重建并跳回名称框        | namespace 同屏可配；机器键/显示名释义分开；稳定 editorKey 不入合同；实页填入后焦点仍在参数键且路径实时更新    |
| 第二十轮：职责最小闭包       | 不需要检视/流水线/冲突/协同/审批的员工能否直接保存执行                           | 旧必需 slot 把所有泳道都当成发布前提；配置一个工具还可能隐式开启其他能力                                | lane 显式 optional；无绑定不阻断且不订阅；部分泳道闭包 fail closed；员工 revision 冻结 enabled work items     |
| 第二十一轮：动态错误处理     | 用户能否定义任意流水线错误类型并给每类注册不同工具/员工                          | 分类包固定类型会把业务枚举写死；一个 repair slot 不能解释一对多运行分派                                 | 岗位级有序路由表、唯一末尾 fallback、exact destination；类型列表顺序即规则优先级，Agent 不参与选择            |
| 第二十二轮：Event 与事实     | 评论/冲突 Webhook 到来时是否可能拿旧 Case Context 直接修复                       | Event Center 只发 wake hint，旧 reaction 直接落分类/修复节点，缺一次权威 MR refresh                     | capability gate 与实际刷新 work item 分离；先 observe-mr，再按新 revision 进入职责；无变化即正常收敛          |
| 第二十三轮：检视协议闭环     | 多轮 thread、ACK、修复说明和自身回复是否完整且不会死循环                         | 只取末条评论会丢上下文；平台回复可能被重新当成人类意见；Agent 没有逐 thread 处理说明合同                | 完整树 + stable revision；修前 ACK/修后回帖；self marker；envelope resolutions；stateful mock replay 零新增   |
| 第二十四轮：公共能力证据     | 公共 OS 与开发类型包是否只是单元测试绿，外部状态迁移有没有真正跑通               | 分散测试无法直接回答能力层级；in-test fake 不能证明 Git/code-host/Script/approval 边界                  | design §15.8 分层矩阵；公共合同+恢复；跨边界 stateful system mock；浏览器功能+像素；当前 SHA 完整 gate/hosted |

### 批次停止条件

- `execution-contract` 出现 `development` literal、业务 WorkItem 路由或员工重试策略；
- digital-employee 类型包各自复制 Agent prompt、Script env/stdout parser 或 output exact validator；
- Agent 候选只按名称/tag 前端猜兼容，或 Program 未运行真实 fixture 就可发布；
- Agent 契约与 `agent-result` 可分别保存、托管端口仍可单独编辑/删除，或完整 guide 重新扩成超预算公共 DTO；
- Event Center import Webhook/Task/Employee 内部实现，或 provider adapter 取得 DB、integration infrastructure、endpoint-wide dispatcher；
- Webhook ingress/replay 直接调用 dispatcher 启动工作，绕过 immutable Event 与 per-Subscription Delivery；
- EventRecord 增加全局 consumed 位，或任一消费者修改共享 Webhook audit/其他 Subscription 的 ACK、重试、死信状态；
- 职责泳道/连线可由业务用户拖拽修改，或阶段重新成为工作项归属下拉框；
- MR 看护的五类职责再次按全局 order 混成单行，回路与前向关系无法区分；
- 任一可选泳道未配置时阻断员工发布/执行，或仍建立对应 Attention/Reaction；
- 流水线失败类型重新写死在平台 enum，缺唯一末尾 fallback，或由 Agent 选择下一类型/工具；
- 评论/冲突 Event 绕过 `observe-mr` 权威刷新直接进入修复，或平台自身 ACK/结果回帖再次触发检视修复；
- 窄屏通过折叠/重排节点破坏“全量展开”，而不是保留固定布局并允许滚动。

## 13h. PR-21：内置工具、材料入口与方案评审

### 目标与任务

本批收紧开发数字员工首次交付链：用户不用把平台内置 Agent 重复注册成自定义工具，正文/文件不会空跑外部取件工具，且可在真正改
代码前复用已有 TaskEngine review 完成人工方案评审。同时修复增加工具弹窗被契约内容撑出横向滚动条的问题。

| 编号 | 任务                                                                                                                                             | 依赖      | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| T197 | 增加 `PlatformToolCatalog`；投影内置 Agent 为只读、exact、可选择/自动两类工具；authoring/runtime 统一解析，所有写接口 fail closed                | T167,T196 | ✅   |
| T198 | Intake manifest 增 kind requirement 与 boolean option；开发类型把外部 ID 绑定可选取件槽，正文/文件走 platform 材料接收并在 admission/UI 同源筛选 | T197      | ✅   |
| T199 | 增内置方案分析 Agent、`humanReview` directive 和 analyze→review→implement 固定 host；复用评论、驳回/迭代、批准与 durable waiting                 | T197,T198 | ✅   |
| T200 | 生成上传材料明确 prompt 清单，锁多文件目标路径、平台 request manifest、分析/实现读取指令与最终 ChangeCandidate/MR 提交                           | T198,T199 | ✅   |
| T201 | 工具弹窗消除横向 overflow；前端合同、后端反向、TaskEngine review、System Mock、桌面/窄屏浏览器和视觉基线形成覆盖矩阵                             | T197-T200 | ✅   |
| T202 | 三轮功能自审、`bun run gate:local`、exact-path commit/push、精确 SHA hosted CI/visual 终态核对                                                   | T197-T201 | 🚧   |

### 批次停止条件

- 内置工具只在前端拼接，岗位发布或运行时不能解析相同 exact revision；
- 平台工具可经写 API 修改/停用，或 automatic 工具混入岗位选择；
- 正文/文件仍必须配置取件工具，或外部 ID 在无绑定时先建 Case 再异步失败；
- 评审开启后实现 Agent 在 review 批准前可运行，或 reject/iterate 不能把意见送回方案 Agent；
- 上传路径只存在 Context 而未明确进入 Agent 指令，或跳过取件导致文件不进入最终 MR；
- 工具弹窗任一目标视口 `scrollWidth > clientWidth`。

## 13i. PR-22：职责小卡片、负责范围与统一新建任务

### 目标与任务

本批把“如何配置一名员工”和“如何交给员工一项工作”压缩为人的语言：工具箱按职责卡片准备工具，岗位模板点击同一卡片选择默认执行者，员工只
选择岗位与负责范围；任务入口与现有编排创建向导合并。配置事实来自 published revision，不能让 draft 或旧全局默认改变运行目标。

| 编号 | 任务                                                                                                                                        | 依赖      | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| T203 | 固定 external/upload/review/pipeline 平台路径；Agent 顶层 `deliveryContent`/`reviewReplies`，平台合成 Context 与 Git/MR/评论副作用          | T197-T200 | ✅   |
| T204 | 全景仅在工具箱常驻；以区域/泳道小卡片替换连线画布；岗位新建/修改改为页内详情，绿/黄状态及必选缺失闪烁定位                                   | T197      | ✅   |
| T205 | 员工范围合成单个仓库/仓库组/任务时指定 picker；API 投影 `publishedWorkScope`；固定仓隐藏选择、组内过滤、task scope 要求选择及旧 global 兼容 | T204      | ✅   |
| T206 | `/tasks/new` 增数字员工创建卡片；任务列表只留“新建任务”；数字员工总览/分类页经统一入口预选，并复用执行者/空间/内容/确认四步 Stepper         | T204,T205 | ✅   |
| T207 | codec/authoring/runtime/workspace/system-mock、前端功能、桌面/窄屏浏览器与 overflow 回归；三轮功能自审、完整 gate、提交推送和 exact-SHA CI  | T203-T206 | 🚧   |

### 本批功能自审记录（2026-08-22，hosted 终态待补）

| 轮次               | 自审问题                                                                                  | 发现                                                                                                                          | 处置与证据                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一轮：统一入口   | 把数字员工放进 `/tasks/new` 后，是否破坏即时编排、定时任务、重跑和编辑定时任务的既有语义  | 数字员工是有状态 Case，不支持现有编排向导的定时/重跑编辑语义；初版只统一了首张卡，选择后落到一页式表单，没有延续四步体验      | 仅在普通新建首步显示第四张卡；数字员工继续复用执行者→空间→内容→确认四步 Stepper，最终一步才调用 Case command；schedule/edit/relaunch 保持原三类；浏览器逐步断言并提交        |
| 第二轮：范围与材料 | 创建时的仓库选择是否只看 draft、固定仓是否重复选择、正文/多文件与外部 ID 是否走错取件路径 | API 若只返回 authoring draft 会让已经发布员工的运行目标漂移；正文/文件若仍要求取件工具会形成无意义必填                        | 增 `publishedWorkScope`；固定仓隐藏 picker、仓库组只列成员、任务时指定必须选择；正文/文件由平台接收，外部 ID 才要求取件工具；authoring/runtime/system-mock 锁定              |
| 第三轮：确定性执行 | 工具卡片展示的输入输出是否与真正 Agent/脚本信封、Git/MR/评论副作用同源                    | 初轮合同测试暴露新增 `materialTargetDirectory` 与 `deliveryContent` 后旧 fixture 仍能构造不完整输入；方案评审路径也缺固定断言 | 平台合同统一注入材料/方案/流水线路径，输出统一为 `deliveryContent`/`reviewReplies`；host 测试锁定 plan→review→implement 和 exact Markdown 路径，平台独占 commit/push/MR/回帖 |
| 第四轮：创作与视觉 | 去掉连线画布后能否仍全景理解职责，弹窗和关键参数是否被裁切，内置工具多行是否让测试误判    | 1200px 组件快照仍被 app-shell 内滚动裁断；首次配置测试错误假设节点只有一个“可用”工具                                          | 视口提升到可容纳 20 张职责卡，人工检查完整全景、工具箱和弹窗；状态断言收紧到刚创建工具行；统一任务四卡增加独立视觉场景；桌面/760px 均锁无横向 overflow                       |

本地终态证据：`bun run gate:local` **9m34s 全绿**——backend **11,626 pass / 36 skip / 0 fail**、frontend
**6,674/6,674**、shared **2,219/2,219**、system-mocks **35/35**，typecheck/lint/format/depcheck 全绿；四步创建真实页面
旅程 **1/1**、零配置旅程 **3/3**、目标视觉 **4/4**，system-mock 完整链 **1/1（52 断言）**。T202/T207 保持进行中，
直到本批 exact-path commit/push 与精确 SHA hosted CI/visual 全部终态通过。

### 批次停止条件

- 员工列表或每个页签仍重复固定全景，或岗位创建仍在弹窗中一次铺开全部职责参数；
- 可选黄色卡片阻断发布，或必选缺失只禁用按钮而不指出具体职责；
- 创建员工仍先选“仓库/仓库组类型”，或出现“全局默认”；
- 固定仓库员工启动任务仍要求重复选择，或 UI 读取 draft scope；
- 任务列表继续并列“编排/数字员工”两个主按钮，或数字员工没有进入统一创建卡片；
- 旧 revision 3 `global` 因 codec 升级无法继续运行，或新 revision 5 仍可创建 `global`；
- 本轮 system-mock/E2E、窄屏 overflow、完整 gate、远端 exact-SHA CI 任一未形成终态证据。

## 14. 风险与停止条件

| 风险                                                                          | 预防/停止条件                                                                                                              |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 快照对拍存在漏检（Agent 的 Git/受保护写未被发现）                             | PR-0 直接 go/no-go：检测机制对已知同形攻击（file API/绝对 binary/`GIT_DIR` 等）必须零漏报，否则该 runtime 不进入员工可选项 |
| 自建 adapter 只能输出无 head/完整性语义                                       | gate 永远 partial；可以诊断/给 Agent看，但不得参与 ready/pass，需扩 provider contract                                      |
| 旧模板大量依赖任意 hook/arbitrate/select                                      | 迁移报告显式 blocked；不自动启用，不用 Agent翻译；由管理员改成 typed rule/adapter                                          |
| source-control 现有 participant 缺 exact remote-head CAS/conflict preparation | 在 source-control owner 扩 bounded offered contract并独立测试；不得在 Mission 调 Git                                       |
| 大 evidence 超磁盘/保留成本                                                   | admission/bundle/Mission budget + streaming + owner-aware GC；超限 block，不截断冒充完整                                   |
| policy 过于复杂导致不可解释                                                   | closed predicates、AST/rule 数硬上限、shadow/no-match publish gate；拒绝通用 DSL                                           |
| cutover 时外部状态持续变化                                                    | freeze旧 writer、epoch/claim、重采 external truth、generation flip；无法取得一致 snapshot 就延期 cutover                   |
| ready 定义与代码托管 approval 语义不同                                        | UI 分 machine holds/human holds/host mergeable；只有 host 明确可合入才叫 ready-to-merge                                    |

## 15. 不在本计划内

- OS 级沙箱、只读 Git view、command broker、env allowlist 重构与 outbound 网络管控（2026-08-18 用户裁决：首版为
  提示词+事后校验+回退，上述项列为后续增强、另立 RFC）；
- 自动 approve、resolve、merge 或直接维护 main；
- Agent 自主创建 capability/tool/rule、编辑 stage graph 或选择下一动作；
- 通用表达式/脚本 policy 与任意 code-host custom action；
- 将 requirement/pipeline 大正文迁入数据库或 prompt；
- 多个可写 Agent 对同一 workspace 并发后自动融合；
- per-hunk 自动分片、跨多个 MR 的 release train、主干红灯自动修复。
