# RFC-310 · 规则驱动的研发数字员工任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。
>
> 状态：**In Progress（2026-08-18 获用户批准，按批次实施；T4/T5/T7/T43/T44/T52/T106 已按 design.md §19 裁决改写）**。

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

| PR/批次 | 名称                     | 用户可验证结果                                                                          | 依赖      |
| ------- | ------------------------ | --------------------------------------------------------------------------------------- | --------- |
| PR-0    | 合同与安全 go/no-go      | RFC-294 import ratchet、no-Git 真实 runtime probe、bundle streaming/provider probe 可行 | RFC 批准  |
| PR-1    | 规则与配置内核           | Java/C++/polyglot 员工和 policy 可发布、模拟、确定性选中，无 Agent 决策                 | PR-0      |
| PR-2    | Mission 聚合与 worker    | Mission 可 launch/reconcile/block/cancel；lease/OCC/outbox/crash 恢复成立               | PR-1      |
| PR-3    | Requirement 与上传 seed  | 正文/带目标路径上传/外部 ID 统一成 bundle；上传由平台形成可重建仓库 seed                | PR-2      |
| PR-4    | AgentAttempt no-Git      | Agent 按 envelope 工作；错误同会话重试，耗尽 whole-workspace fresh rerun                | PR-0,PR-2 |
| PR-5    | 第一价值链               | requirement → Java 实现 → program verify → platform commit/push/MR → watching           | PR-3,PR-4 |
| PR-6    | PipelineEvidence         | 自建门禁程序与大日志 bundle、exact-head 多 gate、rerun/repair                           | PR-5      |
| PR-7    | MR care                  | feedback/CI/conflict/readiness 回退与持续看护到外部 terminal；永不 merge                | PR-6      |
| PR-8    | 完整配置与活动 UI        | 数字员工/动作/策略/适配器/仓库 assignment 和 Mission trace 全部可配置可解释             | PR-5,PR-7 |
| PR-9    | RFC-304/309 迁移 cutover | 配置迁移报告、active MR 单 writer 接管、legacy 只读、无双 writer                        | PR-8      |
| PR-10   | 收口与发布               | 删除 legacy writer/决策脚本/unsafe runtime 路径，真实 E2E、完整 gate、文档账目          | PR-9      |

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
| T49  | same-session structured feedback N 次 + persistent attempt ledger                                                          | T46,T47   | 🚧   |
| T50  | whole-workspace discard/rematerialize + fresh session/new nonce M 次                                                       | T42,T49   | ✅   |
| T51  | boundary violation 快退、capability revoke、悬挂进程/attempt recovery                                                      | T43,T50   | ✅   |
| T52  | 所有 runtime 的检测/回退/credential/rollback 真实子进程测试进入常规 gate                                                   | T43-T51   | ✅   |

交付注记（2026-08-18，PR-4 完工；T49 部分——见末条）：

- **执行链（T41/T43/T44，fork J）**：digital-employee host task（codeRoundLaunch 同款 anchor+synthesized snapshot+StartTaskSchema funnel；`internalSource`+`preCreatedWorktree{cleanup:'borrowed'}`）；`modules/task-execution/composition/agentActionExecution.ts` 组装 `{launch,fetchOutcome,cancel}` runner，executionRef=taskId（durable）；终态 `onTerminal` 回调由装配点反查（`missionIdOfExecutionRef`）落 wake hint。零 Git identity/零凭据：StartTask 不带 gitUserName/Email（spawn either-empty-skip 分支即不注入；RFC-067 普通任务注入面不动，对照组测试锁双向）。真 mock-opencode 子进程 9 测（done/协议缺失/四类 launch 校验/cancel 幂等/interrupted 经普通 reapOrphanRuns 收敛）。
- **域内合同（T45/T46/T47 + T42/T49 域半，fork K）**：AgentInputManifestV1（content-addressed，digest 排除 nonce）、prompt assembler（固定顺序+untrusted delimiter 哨兵转义+英文不可覆盖 protocol block）、`<agent-result nonce>` 信封 exactly-one parser（**nonce 对拍 digest 化**——collect 轮平台只有 attempt.nonceDigest，明文由 Agent 回显）、capability semantic validator（coverage 双射/feedback 恰一 disposition/闭集/read-only 禁 changed）、workspace validator（protectedSnapshot 生产化+escape/预算/outcome↔现场一致性）、attempt 状态机+`ab1:` baseline codec+structured feedback。
- **T48 candidate（source-control）**：临时 clone 独立 diff（`write-tree` oid 即内容寻址身份；gitignore 尊重 + 上传目标 `add -f` 保全；`.agent-workflow/` 按 RFC-308 exclude 语义从 overlay 排除——journey 实红修正：evidence mount 是平台放的，不是业务变更；baseline 里 tracked 平台路径进 diff 仍固定阻断）、上传 lineage 四规则、同输入 byte-identical。`bindChangeCandidateParticipant` 组装、DA 以结构同形端口消费。
- **编排（orchestrator，主 session）**：launch 半（baseline→workspace(+seed planDigest 换算——mission 行存 seedTreeDigest 而 seeds 目录名是 planDigest，fork 缝合 bug 已修)→manifest/nonce/prompt→launcher→台账+pre-state evidence blob〔migration 0179 `pre_snapshot_ref`〕）；collect 半（reconcile 顶部插桩，guards 之前）：§7.5 全流水线→§7.7 `planNextAttempt` 分类（boundary=discarded+整树废弃+fresh；协议/语义→fresh；耗尽=blocked(agent-contract-exhausted)）；fresh rerun 同输入合同（missionRevision 冻结在 action 创建时、nonce 不入 digest）；validated 结算=candidate cell+run settled+currentActionRunId 清+**诚实 `action-stage-complete:<outcome>` block**（verification/发布链属 PR-5/PR-6，不静默重复启动作）；needs-information→agent 问题集入台账→既有澄清闭环（publish→awaiting-information→answers）。coverage 闭集从 requirement manifest 冻结进 pre-state。
- **已知缺口/偏离（呈报）**：①**T49 same-session 结构化反馈 N 次未接**——host-task 形态一次性、runner 无 session-continue 面，sameSession 预算强制 0、协议失败直走 fresh；PR-5 需给 runner 增 continue 面后接通。②**requirement evidence 树在 RFC-130 iso 隔离 cwd 内不可见**（`.agent-workflow/` git-excluded 不进快照分支）——prompt 以 untrusted index 携带需求语境；三个候选机制（forcedContainerPaths 注入面 / runtime staging 挂点 / DE host iso 禁用面）随 PR-5 T42 余项专项拍板。③`AgentActionLauncherPort.launch` 经内部端口直传 workspacePath（不入 DB/prompt/event）；§7.2 严格 path-free 化同随 PR-5。④对拍现场 = action workspace（agent 真实 cwd 是 iso worktree，其污染由 task-execution merge-back/discard 机制先行隔离；回流 action workspace 的任何 Git/protected/evidence 差异由快照对拍检出）。

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
  必须命中 launch 冻结的当前 candidateRef、findingId 唯一、findings 是素材不是裁决）；**链驱动的自动 review
  排程与 `verification.repair` 规则闭环同欠一个前置**——verification/review 结果尚未升为 catalog fact，规则
  谓词读不到（`__delivery.*` 是内部 cells）。verification failed 现为 typed block
  （`verification-failed:<profile>`）。fact 升级 + repair/review 排程记 PR-6。
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
- **本批遗留（除既有 PR-5 债外）**：same-session continue 面、evidence-in-iso 三候选拍板、launch 端口
  path-free 化——原 PR-5 注记项均未消化，顺延 PR-6/专项；`change.implement` 的 route-selected 多模板
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
| T71  | memory/backpressure/retention tests + GB-scale nightly/soak fixture                                                | T65,T67,T70 | 🚧   |

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
- **T71 部分（🚧）**：memory/backpressure 已覆盖（64MB 流式断言 + importer budget 拒收）；**retention GC 未
  实现**——policy `retention.*TtlDays` 目前无消费者，evidence 内容寻址池只增不减（完整 GC 需要全池引用
  扫描，工程量独立）；GB-scale nightly/soak fixture 未建。两项归 PR-10 收口或独立 RFC，呈用户知悉。
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
| T78  | `conflict.repair` edit-conflicts profile + platform finish merge commit + CAS push                 | T43,T47,T77     | 🚧   |
| T79  | report-only 默认、repair budget/blocked handoff；禁止 rebase/force/ours/theirs shortcut            | T76-T78         | ✅   |
| T80  | readiness/handoff/tracking-only + external upload fulfillment/lineage + ready 回退                 | T29,T72,T76     | ✅   |
| T81  | terminal：merged/closed/no-change + upload-unfulfilled；reopen/cancel fence/reconcile              | T30,T72,T80     | 🚧   |
| T82  | periodic reconcile + webhook loss/replay/out-of-order，所有入口同一 facts path                     | T25,T72,T81     | 🚧   |
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
  + finish（「已解决」按工作树 marker 内容检测而非索引 unmerged——Agent 无 Git，add 是 finish 的职责；只
  add 冲突集，顺手改动 `conflict-extra-changes` 拒不收编；平台身份 merge commit 双 parent；零 push——发布
  归 deliverCandidate CAS）。`bindConflictMergeParticipant` 已入 composition 与两装配点。
- **T78 部分（🚧）**：conflict 决策面已接（care 链 §4.7 顺序 2：report-only 呈现于 readiness；repair 模式
  typed block `conflict-repair-agent-surface-not-wired`）；**Agent 执行面欠三件**——workspaceValidator 的
  edit-conflicts profile（冲突集 writablePrefixes）、orchestrator 的 merge-workspace 物化分支（prepare 的
  workspace 含 .git，不同于 actionWorkspace）、conflictRefs 闭集注入。validator 的 `conflict-path-outside-
  markers` code 与 envelope 成员 PR-4 已备。归 PR-8 或专项。
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
- **T81/T82 遗留（🚧）**：reopen→新 generation 链、webhook out-of-order 显式矩阵。

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
| T94  | migration analyzer：模板/矩阵/script/hook/arbitrate/select 逐项分类与 source digest | T0,T13-T16  | ⏳   |
| T95  | 生成 ActionTemplate/DigitalEmployee/Policy/Adapter candidates；无法映射显式 blocked | T94         | ⏳   |
| T96  | migration report UI/CLI：旧 id/ACL/upstream、差异、缺项、publish gate               | T85-T90,T95 | ⏳   |
| T97  | schema expand/backfill verify/backup-restore；legacy rows 尚不 drop                 | T21,T95     | ⏳   |
| T98  | cutover preflight：每 repo employee/policy/adapter/no-Git probe/dry decision 全绿   | T52,T96,T97 | ⏳   |
| T99  | freeze old admission + delivery backlog + quiesce/cancel old rounds                 | T98         | ⏳   |
| T100 | 从 external truth 建 Mission、legacy link、active MR claim；旧未发布 workspace 废弃 | T99         | ⏳   |
| T101 | writer generation flip + replay wake backlog + per-MR single-writer verification    | T100        | ⏳   |
| T102 | rollback drill：无 side effect 前回退；有 side effect 后 stop/reconcile/handoff     | T101        | ⏳   |
| T103 | soak 后 legacy API/UI/worker 只读化；查询仍可追溯                                   | T101,T102   | ⏳   |

cutover 的验收样本必须包含：无 MR 的 requirement、已有 MR/绿、已有 MR/红、feedback 待处理、冲突、运行中
Agent、push 已发生但 receipt 丢失、MR 已在外部 merged。

## 12. PR-10：收口、删除与发布

| 编号 | 任务                                                                                         | 依赖      | 状态 |
| ---- | -------------------------------------------------------------------------------------------- | --------- | ---- |
| T104 | 删除 legacy launch/monitor writer、arbitrate/select 决策、任意 hook Mission 路径             | T103      | ⏳   |
| T105 | 删除旧 repo × capability 写面、五 capability 产品入口、unsafe generic code-host port 消费    | T103      | ⏳   |
| T106 | digital-employee 路径移除 Git identity 注入并锁检测/回退接线；负扫描 0（env 继承按裁决保留） | T104      | ⏳   |
| T107 | cross-context internal import 清零；public surface/required ports/field budgets 复核         | T104-T106 | ⏳   |
| T108 | schema contract：确认 rollback 窗口/backup restore 后 drop 不再使用的 legacy write schema    | T103-T107 | ⏳   |
| T109 | 系统 mock 全旅程、真实 runtime、Git remote、浏览器、crash/large-log/permission E2E           | 全部      | ⏳   |
| T110 | focused/typecheck/lint/format/depcheck/migration/architecture + 完整 `bun run gate:local`    | T109      | ⏳   |
| T111 | hosted CI exact SHA、发布/升级/rollback runbook、运维 dashboards/alerts                      | T110      | ⏳   |
| T112 | RFC-304/309 转出账与 RFC-310 AC 逐项证据，`STATE.md`/索引/docs/dev-gotchas 收口              | T111      | ⏳   |

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
| AC-10 同会话重试 + whole-workspace fresh                | T49-T51                                                      |
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
- per-hunk 自动分片、跨多个 MR 的 release train、主干红灯自动修复；
- 在 RFC 获批前实施任何上述任务。
