# 标志位控流审计 & 通用扩展点改造建议（2026-07-07）

> **调研问题**：系统中有哪些「用标志位控制流程」的实现？哪些是坏味道？哪些可以重构消除、把流程抽象为「注册即扩展」的通用扩展点？
>
> **方法**：9 路并行只读调研——后端 4 路（调度/生命周期、clarify/review/协作/ACL、运行时/注入/资源、routes/ws/daemon/env/DB）、shared 1 路（含跨包绕过验证）、前端 4 路（画布/编辑器、任务/评审/反问页、公共组件/hooks/api、资源管理页），覆盖生产代码 backend ~69k + frontend ~56k + shared ~13k LOC。每项发现均含 file:line、检查点计数、重构方向与工作量/风险评估。
>
> **交叉对照**：`design/scheduler-audit-2026-06-10.md`（其根因 R1「状态分桶手工 if/else」、R2「权威判定多处 fork」、R5「wrapper 三套实现」、R7「代理信号」正是本主题的调度域具象，已排入 WP-2/3/6/10）与 `design/dedup-audit-2026-06-13.md`（is-wrapper-kind 13 站、terminal-status 4 份等 68 项重复）。重叠项在本文标注归属、挂回既有队列，不重复立项。
>
> **可信度**：各发现由单路 agent 产出、主发现经 2-3 路独立互证（runtime 分支、wrapper 谓词、终态集合、死旗标均双源确认）；file:line 为调研时点快照，落地前请逐项复核。

---

## 0. 判定口径

**「标志位」六类**：① 布尔函数参数（尤其调用点传字面量）；② options/props 布尔控制字段；③ 模式字符串（mode/kind/type/decision…）多处分支；④ env gate；⑤ DB 布尔列/状态列直接驱动分支；⑥ sentinel（null / 魔法字符串 / 参数存在性 / 时间戳 NULL 组合）。

**不算坏味道**：领域事实布尔（readonly、visibility、builtin、autoCommitPush）、单点检查不透传、i/o 边界解析、纯展示派生、测试专用 gate、框架惯例（TanStack `enabled`、受控组件 `disabled/open`）。

**坏味道判据**：(a) 调用者指挥被调者「怎么做」而非「做什么」；(b) 同一标志 ≥3 处检查（shotgun surgery）；(c) 新增一种行为要改 if/switch 链而非注册新条目；(d) 多布尔组合出非法态、靠注释/422 兜底；(e) 标志跨层透传 ≥2 层；(f) 状态编码进人读文本列、靠 startsWith 当机器协议。

## 1. 一句话结论

**本仓的「布尔参数病」已被历次 RFC 治理得相当好——转移表+CAS、`satisfies Record` 编译穷举、boot drift-guard、能力注册表都有教科书级实现；真正的系统性欠账是六个「注册表半截 / 缺席」的位置（runtime 能力、节点 kind 行为表接线、系统通道端口、失败形态编码、merge_state 状态机、前端 Segmented/TabBar 原语），外加一批「注册表存在但新代码绕开再写一份」的漂移——后者已累计 ≥12 个可指认的真实 bug / 假旋钮。**

## 2. 扩展成本总表（「新增一种 X 今天要改几处」）

这张表直接回答「哪些流程该抽象为通用扩展点」——现状成本越高、目标形态越明确的越该做：

| 扩展轴 | 现状成本 | 目标形态 | 归属 |
|---|---|---|---|
| 新增一种 **runtime**（第三协议） | **~14-15 处** if/else（probe/模型/二进制/凭据桥/spawn/捕获/smoke/inventory） | driver 能力对象 + `DRIVERS` 注册 1 行 | §4.1 → RFC-G1 |
| 新增一种 **wrapper kind** | 前端 14 处 or-chain + 后端 services/validator ~16-38 处 + shared 2 份私有 Set + WrapperNodes 6 分支 ≈ **~40 处** | `NODE_KIND_BEHAVIORS` 加 `container` 维度，谓词查表 | §4.2 → W0+RFC-G4 |
| 新增一种 **叶子 node kind** | **~13 处 / 7+ 文件**（schema、行为表、渲染器、computePorts、nodeTitle、Inspector 巨型 case、palette 5 点、尺寸表…） | 注册面收敛到 4 处编译强制点 | §4.2 → RFC-G4 |
| 新增一种 **系统通道端口**（`__clarify__` 族） | **≥6 处、3 种语义家族**（成员集都不一致） | 端口描述符注册表 1 行 | §4.5 → RFC-G5 |
| 新增一种 **可 follow-up 失败形态** | runner 前缀 + scheduler 顺序敏感 startsWith 链 + shared reason 联合 + opening 链 ≈ **4-5 处** | `failure_code` 列（或前缀注册表）+ 渲染表 1 行 | §4.3 → RFC-G3 |
| 新增一种 **review 决策** | review.ts 内 **~30 行分支**（8 个正交策略逐处三元）+ 前端 3 份色映射 | 决策策略表 1 行 + `DECISION_CHIP_KIND` 1 行 | §5.2 → RFC-G7 |
| 新增一个 **WS 频道** | 同文件 4 处 + broadcaster 3 处 = **7 处**（漏一处即静默漏鉴权） | 频道 spec 注册 1 项 | §5.4 → RFC-G10 |
| 新增一种 **任务/节点状态** | 后端已编译强制（never 穷举）✅；**前端 3-5 份色调/集合拷贝**（已漂移出 bug） | 前端并入 lib 表驱动 | §4.6 → W0 |
| 新增一种 **输出 kind** | 4-5 处但**全有 boot drift-guard 交叉断言** | ——已达标（全仓最佳实践） | 范本 §7 |
| 新增一种 **修复规则 / 可延后冲突码** | 双端 satisfies 编译强制 / ReadonlySet 加一项 | ——已达标 | 范本 §7 |

## 3. 顺手抓到的真实 bug / 假旋钮（与标志位直接相关，当下可修）

1. **`revokePats` 收而不办**（安全语义假旋钮）：`services/users.ts:82` + `shared/schemas/user.ts:63` 对外公开，实现处 `users.ts:108` 是 TODO——管理员传 `revokePats:true` 后 PAT 依然有效。**需产品拍板：实现或删除。**
2. **`rejectSelfQuestionerFullSeal` 死守卫**：`clarifySeal.ts:98` 定义 + 12 行 docstring，`rg` 零读取（RFC-132 拆除守卫时漏删）；`routes/clarify.ts:263`、`clarifyAutoDispatch.ts:383` 仍郑重传 `true` 且注释声称守卫生效。直接删。
3. **loop 下拉提供不存在的端口**：`canvas/wrapperCandidates.ts:46-60` `deriveOutputPorts` 对 review 节点返回 `['output']`，该端口不存在（权威实现 `WorkflowCanvas.tsx:1673` 是 `reviewApprovedPortName()`+`approval_meta`）→ exitCondition/outputBindings 下拉出现假端口。
4. **同文件死分支**：`wrapperCandidates.ts:33-44` `deriveTitle` 读 `rec.source`，schema 字段实为 `inputSource`（`shared/schemas/review.ts:76`）→ 分支永不可达。
5. **`status-chip--warning` 无样式**：`tasks/TaskDiagnosePanel.tsx:172` 引用的 class 在 styles.css 只有 `--warn`（styles.css:2769）→ warning 级告警 chip 裸奔。
6. **已取消反问轮显示绿色「已回答」**：`routes/clarify.tsx:84` 判 `status !== 'awaiting_human'` 即绿，漏了 `canceled`（`shared/schemas/clarify.ts:362-368`）。
7. **interrupted 节点行两处颜色矛盾**：`routes/tasks.detail.tsx:1030`（amber）vs `NodeDetailDrawer.tsx:241` / `node-session/SessionTab.tsx:273`（gray）——同一 node_run 状态在任务表与抽屉/会话切换器颜色不同（noderunTone 共 3-5 份拷贝已互相漂移）。
8. **`'form-invalid'` sentinel 漏出生字符串**：4 处 `throw new Error('form-invalid')`（mcps.new:36 / mcps.detail:51 / plugins.new:34 / plugins.detail:62），只有 mcps.new:68 过滤——其余 3 页在字段错误之外额外冒一条未翻译 banner。
9. **claude 运行下 opencode 轮询器空转**：`runner.ts:1119-1129` live subagent poller（读 opencode XDG SQLite）无 runtime gate 无条件启动，claude 节点下每 1.5s 空转 BFS 靠连续失败自禁——能力未内聚 driver 的直接后果。
10. **`status-chip--red` 依赖「将删除」的废弃别名**：`routes/clarify.detail.tsx:831` 是全仓唯一引用 raw-color 别名（styles.css:2790-2820 注明 cleanup PR 将删）的地方——清理落地即静默褪色。
11. **`review.ts:1916` 向新行倒灌 legacy kind**：`approvedDocKind = hasSourcePath ? 'markdown_file' : null` 持续写入 legacy 别名，违反 `shared/kindParser.ts:14-16`「仓库内部统一 `path<md>`、不要倒回去」。
12. **`claudeCodeEnabled` 三重矛盾**：`shared/schemas/config.ts:54` 注释「Default off」；前端 `AgentForm.tsx` 按 `!== false` 默认**开**；后端零 enforce（API 直调可绕过）。要么删（改读 runtimes 注册表 enabled，RFC-118 机制已有）、要么后端补 enforce。
13. **shared 同名异义陷阱**：`services/taskQuestions.ts:1574` 导出 `TERMINAL_TASK_STATUSES = ['done','canceled']`（2 值，「问题不再派发」语义），与 `shared/lifecycle.ts:203`（4 值）同名不同义，已被 `taskQuestionDispatch.ts:51` 导入——import 自动补全错拿即静默 bug。应改名 `QUESTION_DISPATCH_CLOSED_TASK_STATUSES`。
14. **AclPanel 手搓 segmented a11y 漂移**：`AclPanel.tsx:157` 用 `role="group"`+裸 button（无选中态 aria），其余 8 处手搓用 `role="radio"`——同一控件两套 a11y。

另有一批**死代码型标志**（读者被迫证明分支是死的）：`fanoutSourceSync.ts` 全文件 no-op 存根占 7 个调用位（`WorkflowCanvas.tsx:334,425,465,515,562-566,871,1012,1359`）、`NodeDetailDrawer.tsx:68` 不可达 `'prompt'` tab、`clarify.detail.tsx:563` `requiredMissing=false` 恒假仍参与 3 处分支、`TaskQuestionList.tsx:124` `deferred=true` 恒真守卫 3 处（注释还留着 RFC-132 前的过期语义）、`TaskFeedbackList.tsx:36` `canSubmit` 无人传、`lib/nav.ts:12` `SubNavItem.variant` 零消费、`ResourceList.tsx` 死组件（0 调用者，内嵌与 ErrorBanner 逐字重复的 ErrorBox）、`db/schema.ts:528-535` 已删列 `deferred_question_dispatch` 的 8 行孤儿注释、`runner.ts:267` `dangerouslySkipPermissions` 生产端从未有人传值的假旋钮（当前 CLI 模式下「非跳过」根本跑不通）、RFC-132 残留说谎注释簇（`taskQuestions.ts:542-546/736/804`、`clarifyAutoDispatch.ts:3-18` 文件头、`clarifyRounds.ts:1-20` 承诺 3 个已删函数）。

## 4. P0 结构性发现（六项）

### 4.1 runtime 协议半截注册表 —— 全仓最重的「注册表存在但被绕过」

`runtime/index.ts:35-43` 的 `DRIVERS` 注册表（multica Backend-factory 模式）只挂了 `parseEvent` + 系统代理 `buildSpawn`；`runtime/types.ts:10-11` 自己写着计划 "PR-B adds `probe` / `listModels` / `captureSession`" 但从未落地。于是 `runtime === 'claude-code'` 的 if/else 散落 **~14-15 处**：

- `runner.ts:831`（业务 spawn 主分支，含 memory 注入方式分叉）、`:537-541` / `:1500-1504`（inventory 插件 gate）、`:1456`（子代理捕获二选一）
- `runtimeSmoke.ts:99-129`（`buildSmokePlan` 近乎重写一遍 `driver.buildSpawn`）
- `runtimeRegistry.ts:171`（内建名 fallback 硬编码，旁边 `:30` 的 `BUILTIN_NAMES` Set 没用）、`:239-241`（按 protocol 选 config key）
- `routes/runtimes.ts:80-83` / `:129-133`（二进制解析、探针二选一）、`routes/runtime.ts:34-52`（模型列表）、`cli/start.ts:134-149`（boot 软探测）
- `memoryDistiller.ts:927/938`、`nodeRunMint.ts:307/373`（冻结值合法性再抄集合）、`runtime/index.ts:32`（`resolveRuntime` 硬编码三元，生产已无调用者的半死代码）

伴生小病：**`bridgeCredentials`** 的判定在 4 个调用点各写一套（`runner.ts:858` 用 `runtimeCmd === undefined` 哨兵反推「生产环境」、`memoryDistiller.ts:938` 恒 true、`routes/runtimes.ts:155,174,248` 硬编码 true），中间纯透传 3 层；**二进制头四字段并存**（`opencodeCmd`/`runtimeCmd`/`runtimeBinary`/`claudeCmd`，3 处汇聚逻辑，`runner.ts:840-843` 靠注释警告「claude 千万别拿 opencodeCmd」）；**技能物化三分支**（project/managed/external）在 `runner.ts:1578-1597` 与 `runtime/claudeCode/config.ts:48-68` 逐行同构两份；`OPENCODE_PURE` 解析式复制两份（`runner.ts:1508`、`inventory.ts:201`）。

**重构方向（RFC-G1）**：`RuntimeDriver` 扩为完整能力对象——`{ kind, parseEvent, buildSpawn, probe(), listModels(), defaultBinaryOf(cfg), capabilities: { inventoryPlugin, liveSubagentPoll, credentialBridge } }`；`ProtocolSchema` 由 `Object.keys(DRIVERS)` 派生；head 解析收敛到 `runtimeHead` 单点、runner 只收 `cmdHead: string[]`；技能物化抽 `materializeSkillInto()` 单函数。新增 runtime = 新 driver 目录 + 注册 1 行。工作量 L、风险中（`runtime-opencode-golden.test.ts` byte 锁护航，分片推进）。

### 4.2 节点 kind 知识散射 —— NODE_KIND_BEHAVIORS 是「文档表」而非「行为表」

`shared/node-kind-behavior.ts:133-208` 的五维行为矩阵有 `satisfies Record<NodeKind,…>` 编译强制（新 kind 必须填表），但文件头自认 "Today: only `retryCascade` is consulted at runtime"——**5 维中仅 1 维被消费**（`task.ts:1960`）；limits/orphanReap/gc/shutdown 四维对应的真实逻辑仍 kind-blind 或 inline。同时「是不是 wrapper」这个最常被问的谓词不在表里：

- **wrapper 三连判定无共享谓词**：前端 14 处（`WorkflowCanvas.tsx:1093-2198` 内 7 处 + `wrapperOps/wrapperFit/wrapperMembership/wrapperCandidates/coordProjection` 各私有一份）、后端 services+validator or-chain（`scheduler.ts:375-377/6062/6074`、`dispatchFrontier.ts:50` 的 `WRAPPER_KINDS` 只有本文件用、`workflow.validator.ts:222/409`…）、shared 2 份私有 Set（`workflow-sync-diff.ts:25`、`schemas/workflow.ts:61-68` 内嵌）。`coordProjection.ts:31-34` 的注释就是事故记录（RFC-060 加 fanout 漏了这里）。dedup-audit 已登记 13 站，本轮实测三包合计 **~40 处**。
- **端口/标题推导 fork 4 份**：权威 `WorkflowCanvas.tsx computePorts:1589-1701`；`wrapperCandidates.ts:46-60` 已漂移成 bug（§3-3）；`controlFlowEdge.ts:66-83`、`dropTarget.ts:30-47` 各一份镜像。
- **NodeInspector 1071 行巨型 kind-switch**（`NodeInspector.tsx:172-1243`，8 case 各一整个表单）——与 `NODE_TYPES` 渲染器注册表（好模式）不对称。
- **散装 kind 集合**：`scheduler.ts:372-380` runOneNode 白名单（9 kind 逐一 `!==`）、`:1272` `SETTLES_WITHOUT_ROW_KINDS`、`stuckTaskDetector.ts:431`、`nodePalette.ts` 同文件 5 点、前端 `isPromptCapableKind`（`lib/node-prompt.ts:36`）与 `isAgentKind`（`lib/injected-memories-card.ts:13`）逐字相同不同名、后端 `PROMPT_CAPABLE_KINDS` 又两份（`inventory.ts:127`、`sessionView.ts:31`——`inventory.ts:33` 明明有集中 helper）。
- `isProcessNodeKind`（or-chain，`schemas/workflow.ts:61-68`）与表派生 `nodeKindParticipatesInRetryCascade`（node-kind-behavior.ts:221）双实现并存，一致性靠测试非编译。

**重构方向**：W0 先做机械收敛（shared 导出 `WRAPPER_NODE_KINDS`/`isWrapperKind`，全 or-chain 替换，S/低风险）；RFC-G4 再做结构收敛——行为表加 `container`、`hasOwnSession`、`settlesWithoutRow` 维度并逐维接线；`derivePorts(node, agentByName, def)` 单源（`Record<NodeKind, PortDeriver>`）；NodeInspector 拆 per-kind 表单组件 + `Record<NodeKind, FC>` 注册表；runOneNode 分派表化（白名单 = `Object.keys` 自动成立）。

### 4.3 errorMessage / errorSummary 充当机器协议 —— 人读文本列兼职路由键

- **前缀路由协议**：前缀常量四散（`envelope.ts:235/248/265`、`scheduler.ts:667`、`dispatchFrontier.ts:65`）+ 3 个**裸字面量双端复制**（`'no <workflow-output> envelope found in stdout'` 产 `runner.ts:1333,1341` / 消 `scheduler.ts:675`；`'clarify-and-output-both-present'`；`'clarify-questions-'` 靠上游 error code 命名约定间接拼出）。消费侧 `scheduler.ts:675-714` 是 **7 连 startsWith 且顺序敏感**（:707 注释明说必须排在 :714 前）。新增一种可 follow-up 失败 = runner 造前缀 + decide 链插分支（排对顺序）+ `shared/prompt.ts:883-1013` 渲染链加 case，4-5 处 shotgun。
- **supersede 标记**：`superseded-by-review-{decision}[-rollback]` 把三个事实编码进 error_message 前缀（写 `review.ts:2074`；读 `dispatchFrontier.isReviewSupersededRow`〔RFC-095 起是 LOAD-BEARING dispatch contract〕、`clarifyRerunLedger.ts:146/263`；常量同值复制靠 parity 文本测试锁防漂移）。前端已收敛单一 decode 点（`lib/noderun-status.ts`）是正确的止血形态。
- **`errorSummary === 'daemon-restart'`**：写 `orphans.ts:65`、读 `autoResume.ts:62` 精确匹配选 boot auto-resume 候选——两个独立裸字面量，orphans 改一个字即静默瘫痪 autoResume。

**重构方向（RFC-G3）**：正解是 node_runs 加 `failure_code` 枚举列（errorMessage 回归纯人读），`decideEnvelopeFollowup` 变 `Record<code, {reason, followup}>` 查表、prompt 渲染同表取值（`FOLLOWUP_REASONS` 表）；supersede 加 `superseded_by_review` + `rolled_back` 列。过渡方案（不动 schema）：有序前缀注册表数组、双端 import 同一常量。`daemon-restart` 最小修是 shared 常量。与 scheduler-audit **WP-10（rerun_cause 持久化）同族**，建议排期相邻或合并。
**✅ 已由 [RFC-145](RFC-145-failure-code-structuring/proposal.md) 落地（2026-07-08，走正解非过渡）**：failure_code 7 值生产域 + FOLLOWUP_POLICY 7→6 投影表（clarify-forbidden 隐式降级显式化）、runner 11 stamp 点正向声明、7 连 startsWith 链删除；supersede 三事实列化（isReviewSupersededRow 改 IS-NOT-NULL、双 fork 字面量 + parity 锁退役、前端 decode 字段化）；migration 0077 三列 + 11 条 backfill；errorMessage 机器读源码守卫禁令。daemon-restart 已由 W0-5 先行治理确认。

### 4.4 merge_state 五值状态列全裸直写 —— 与本仓自建的状态机范式直接冲突

node_runs.merge_state（RFC-130：NULL/isolating/pending-merge/merged/conflict-human/merge-failed）驱动第二正交生命周期（settled 判定 `scheduler.ts:1356`、frontier 分桶 `:1563-1565`、重放 `:1705/:1777`、fanout `:4175`），但 **~19 处写点全部 `db.update(nodeRuns).set({ mergeState })` 裸直写**（scheduler.ts:1640-5041 间 19 处）。对比：status 列有转移表+CAS+ESLint ratchet+s14 源码守卫**四层防护**，merge_state **零层**——转移合法性（isolating→pending-merge→merged|conflict-human…）全靠隐式约定，并发 merge-back 与冲突决议可互相覆盖。

**重构方向（RFC-G2）**：照抄 RFC-053 三件套——`transitionMergeState(db, nodeRunId, event)` + 转移表 + 源码守卫测试；frontier 分桶从表派生。工作量 M、风险中（RFC-130 测试群现成）。
**✅ 已由 [RFC-144](RFC-144-merge-state-machine/proposal.md) 落地（2026-07-08）**：五件套全落 + 第 7 值 `abandoned`（abandoned ⇔ 被取代，mint 收口点单事务废弃前代）+ 顺手修出并坐实一个真 bug——**stale replay**（入口 replay 只按 (taskId,mergeState) 捞行，被 retry/review 取代的旧行重放会把过期 delta 物化进主树；先红后绿 + migration 0076 清洗存量）。勘误：本节所称「ESLint ratchet」实为 grep-guard 单测（services/lifecycle.ts:18 注释陈旧）；「dispatchFrontier 分桶」实在 scheduler.ts deriveFrontier（dispatchFrontier.ts 不读 merge_state）。

### 4.5 「channel/系统端口」判定 6 处分叉、3 种语义家族

同一份「哪些端口是系统通道、图遍历时该不该当数据流依赖」的知识存在 6 份、且**语义已分裂**：

- `shared/clarify.ts:790-798` `isClarifyChannelEdge`（5 端口、source/target 对称判）
- `shared/workflow-sync-diff.ts:34-44` 私有 `CHANNEL_PORTS`（同 5 端口但**任一侧命中即算**——更宽）
- `shared/prompt.ts:360-363` `SYSTEM_PORT_NAMES`（仅 2 端口，管 auto-append）
- `scheduler.ts:5987-6001` 手写第三种语义（`__clarify__` 仅当 target kind==='clarify' 才跳过，cross-clarify 保留为数据流依赖）——**同文件 5665/5679 行却又用共享谓词**
- `dispatchFrontier.ts:141-152`（注释自称 "verbatim from buildScopeUpstreams" 的手抄副本）
- `taskQuestionDispatch.ts:206-214`（第四变体：`__clarify__` 无条件跳过）

下一个 RFC-056/120 式功能几乎必然新增通道端口，届时 ≥6 处改动、零交叉锁。**重构方向（RFC-G5）**：shared 端口描述符注册表 `SYSTEM_CHANNEL_PORTS: Record<portName, { promptInjected, dataflowDep: 'never'|'unless-target-clarify'|… }>`，六处消费点改查表；先用测试钉住 scheduler 的 nuanced 语义再收敛。

### 4.6 前端状态→UI 映射散射 + 缺 Segmented/TabBar 原语 —— bug 集中营

前端「表驱动/判别联合/纯 resolver」基建其实齐全（`TASK_STATUS_KIND`、`resolveReviewView`、`PHASE_KIND` 都是现成样板），主要坏味道是**新代码绕开样板再写一份**：

- **评审决策色映射 3 份、2 套色名体系**（`routes/reviews.tsx:35-40` legacy 色名、同文件 :178-188 又一份嵌套三元、`ReviewDecisionInfo.tsx:19-24` 语义色名）；`superseded` 只有 1 份处理、其余静默落灰。
- **noderunTone 3-5 份拷贝已互相矛盾**（§3-7）；同族 `statusLabel` fallback 也漂移（`ConversationFlow.tsx:153` 回显 raw vs `SubagentBlock.tsx:72` 落 pending）。
- **裸 `status-chip status-chip--X` span 10 处**绕过 `<StatusChip>`（含 §3-5 的无样式 class 与 §3-10 的废弃别名）。
- **任务终态/活跃态集合 ≥3 份**（`lib/task-detail-tabs.ts isTerminal` / `RecentlyDoneList.tsx:17` / `RunningTaskList.tsx:18`）+ 后端 `gc.ts:24-29` 手抄（dedup-audit 已点名 4 站，且 gc 是裸字面量无 satisfies 守卫）+ shared 同名异义陷阱（§3-13）。
- **`.segmented` 只有 CSS 没有组件**：9 文件 13 处手搓 active 三元 + 手写 aria（已漂移，§3-14）；`LanguageSwitch` 的 CSS 整块 fork（styles.css:1999-2044 与 .segmented 块逐字重复）。**`.tabs` 同病**：13 文件手搓 `aria-selected` + ≥5 个 fork 命名空间（`.auth-tabs__tab`/`.inbox-drawer__tab`/…）= 视觉参数 5 个平行真相源。
- TaskStatusChip 与 home/task-row `describeStatus` 是同枚举两套 i18n 键族（新状态改两处）。

**重构方向（W0 + RFC-G8）**：立即修 3 个存量 bug 并把映射收进 `lib/`（`DECISION_CHIP_KIND`、`NODE_RUN_STATUS_TONE`、`CLARIFY_STATUS_CHIP`、`TASK_TERMINAL_STATUSES` 前端引 shared）；新建 `<Segmented>`（options 表驱动、a11y 内置）与 `<TabBar tabs={[{key,label,badge?}]}>` 两个公共原语（CLAUDE.md 强制复用条款的补齐），迁移可分批；ConfirmButton `danger` 布尔（16 调用点 14 处传字面量）收敛为 `variant/size` 枚举对齐 `.btn--*` CSS 枚举。

## 5. P1 系列

### 5.1 clarify/prompt 渲染协议——三代注入路径叠置 + 散装布尔簇（含 RFC-132 收尾）

- **RFC-132 删除半途而废**：backend 生产侧只产 `flatBlock`（`scheduler.ts:2655-2668`、`clarifyQueue.ts:314`），但 `renderUserPrompt`（`shared/prompt.ts:205-295`）仍带 `crossClarifyContext`（后端零生产者，仅 `runner.ts:171,790` 透传壳）、`questionsBlock`/`answersBlock`/`buildClarifyPromptBlock`/`buildExternalFeedbackBlock` 等零生产调用的死变体；`prompt.ts:521-541` legacy 段与 7 个 clarify token 的替换值运行时恒空。`clarify.ts:536-538` 注释挂账的 PR-2/PR-4 待收尾。
- **`inlineMode` 单字段 6 处分支**（`prompt.ts:396→446/456/524/536/594/637`）+ 伴生 `currentRoundOnly`「今天恒等于 inline」的推测性泛化（唯一生产者恒成对设置）。
- **clarify 通道 5 布尔散装**（`runner.ts:189-220` clarifyStopNotice/hasClarifyChannel/clarifyStopped/clarifyMode + scheduler 侧派生 `:2635/2698/2714`）：类型可表示非法组合（stopped∧¬hasChannel），全靠构造纪律；跨 scheduler→runner→renderer 透传 ≥2 层。
- **envelopeFollowup 四字段散装**（`runner.ts:372-394`，注释自述 "Always passed together"）：runner 内 6 处独立 `!== true` 守卫，followup=true 缺 reason 靠 `?? 'envelope-missing'` 容错。
- `hasClarifyChannel` 单信号多决策是 RFC-141 有意设计（措辞与协议同源），不算纯坏味道；更强形态是 scheduler 一次算出 `protocol: 'ask-back'|'ask-back-inline'|'output'` 枚举下传，把 2×2 隐式组合显式化。
- sessionMode 全链 ~15 处分支：服务层已由 `decideResumeSessionId`（`clarifyFallback.ts:71-89`）收口良好，shotgun 集中在 prompt 渲染层——随本项一并 per-mode 策略对象化。

**重构方向（RFC-G6）**：先完成 RFC-132 PR-4 删除（死字段/死渲染段/死 token 降级拍板，可先加「生产者为零」源码断言）；再收敛为判别联合——`clarifyChannel: {kind:'none'} | {kind:'self'|'cross'; directive:'ask'|'stopped'; injectStopNotice}` 与 `promptPlan: {kind:'initial'} | {kind:'followup'; reason; …}`，renderer 按 per-mode 策略对象（`{substituteInputs, questionsSection, trailing, …}`）渲染。golden 测试锁字节，risk 可控。

### 5.2 review 决策与多文档模式（后端）+ 历史只读视图（前端）

- **`args.decision` 一个字符串驱动 8 个正交策略、review.ts 内 ~30 行分支**：端口发布、迭代号、rerun 配置键名（`rerunnableOnReject/OnIterate`）、回滚键名+**不同默认值**（`rollbackFilesOnReject`→true / `OnIterate`→false）、supersede 后缀、mint cause、级联条件、生命周期事件（`review.ts:1828-2151`、`buildReviewPromptContext:2467-2494` 等）。→ **决策策略表** `REVIEW_DECISION_POLICY: Record<ReviewDecisionKind, {bumpsIteration, transitionEvent, rerunnableKey, rollbackKey, rollbackDefault, mintCause, cascade, buildPromptCtx}>`，新决策 = 注册一行。
- **`isMultiDoc × itemsInline` 两布尔叠 3 路径且两套推导来源**：dispatch 侧按上游端口 kind 推（`review.ts:436/444`）、decision 侧按数据形状 NULL sentinel 重推（`:1824/:1717`）——将来不一致即漂移。→ 第一步抽 `resolveReviewRoundMode(): 'single'|'multi-inline'|'multi-path'` 两侧共用（S/低risk）；第二步三 variant 对象（L，先补网）。
- **`decidedBy` 三态魔法字符串**（用户 ULID | 'local' | 'system'）：审计列兼职流程判据，`ne(docVersions.decidedBy,'system')`（`review.ts:2453/2477`）直接决定 iterate 重跑 prompt 取哪行（注释 2440-2445 记载过选错行 bug）。→ 最小改 `SYSTEM_DECIDER` 常量+`isSystemDecision()` 谓词；根治加 `decided_by_kind` 列。
- **review 输入 kind 解析 3 处 fork**（`workflow.validator.ts:317-328`、`WorkflowCanvas.tsx:1656-1673`、`review.ts:2800-2836` 各手抄「inputSource→agent.outputKinds 查 kind」前半段）+ 发布口字面量（`review.ts:1939 'approved_doc'`、`:1748 'accepted'`）不走 `reviewApprovedPortName` oracle + §3-11 的 `markdown_file` 倒灌。→ shared 增 `resolveReviewInputKind()`。
- **前端历史只读视图三态两套机制**（RFC-142 焦点）：单文档有纯 resolver `resolveReviewView`（`lib/review/readonly.ts:56`）但 12 个逐字段三元挑数据源 + 11 处 readonly 渲染守卫；多文档 `MultiDocReviewView.tsx:92-103` 没沿用 resolver 形态、就地重写 sentinel 链；汇合点 `ReviewDocPane.tsx:70-72` 的 (readonly, awaiting) 布尔对含非法组合。→ 抽 `resolveRoundView` 同形 resolver + `viewedVersion` 一次挑齐对象 + `mode: 'awaiting'|'decided'|'historical'` 单 variant prop（**不用** React Context——传播只有一层）。

### 5.3 五资源页骨架 ×5 与「新建 vs 编辑」三种矛盾 idiom（前端资源域）

- 列表页同构骨架 **5 份完整拷贝**（agents/skills/mcps/plugins/workflows 路由）：`visibility==='private'` chip、owner 徽标、`useUserLookup`、Loading/Error/Empty 三连、del mutation——RFC-099 后端统一了模型、`AclDialogButton` 统一了管理入口，唯独列表展示层没统一。→ `<ResourceNameCell>` + `useResourceList()`；顺带裁决 `ResourceList.tsx` 死组件（复活成真 DataTable 或删除）。
  **更正（RFC-151）**：`ResourceList.tsx` 已删除（§8 决策④落地），「去留」裁决作废；`.data-table` 为事实标准与抽取基线。
- 新建/编辑双模式三种 idiom 并存：`nameLocked` 布尔 prop（agents/mcps/plugins，调用点全传字面量）、组件级整体 fork（memory 双 Dialog ~120 行逐字重复）、单组件 mode 字符串 7 处分支（`settings.tsx:863-1080` OidcProviderDialog，含「测试连接」按 mode 既隐藏按钮又 throw 的双重编码）。→ 钦定一个 idiom：共享 fields + `useResourceFormPage({load, buildCreate, buildUpdate})`；OIDC 差异收敛为 submit 策略对象。
- detail 页 `loaded` hydrate-once 布尔 ×4 份（手工模拟 seed-once 状态机，MemoryEditDialog 已衍生第 5 变体并自带 stale-race 长注释）→ `useDraftFromQuery()`。
- Picker 四份 ~75 行逐字复制（SkillsPicker/McpsPicker/PluginsPicker/AgentDependsPicker，dedup-audit §list-multiselect-picker 已登记）→ `ResourcePicker<T>` 配置化。
- `skills.new.tsx` 四模式 tab ×8 分支点——同文件 `ImportZipPanel` 已示范「每模式一个自包含 panel」的正确形态，照做即可。
- 杂项：`form-invalid` sentinel（§3-8，正解是 `buildCreatePayload` 判别联合结果在 mutate 前分支）、`FuseDialog` 双 undefined-prop 隐式模式 → `entry: {kind:'from-skill'}|{kind:'from-memories'}` 判别联合、`AgentImportDialog` `'yaml-parse-failed:'` 前缀协议 → warnings 升级 `{code, blocking}[]`、`skills.detail.tsx` `isManaged` 7 处 → `skillCapabilities(sourceKind)` 能力对象。

### 5.4 WS 层：后端频道分支簇 + 前端失效 if-链 ×6

- 后端：新增一个 WS 频道要改同文件 4 处 + broadcaster 3 处（`ws/server.ts:119-126/134-156/203-216/300-459/533-548`、`ws/broadcaster.ts:63-97`）；tasks-list/workflows/memories 三处近似复制「admin 短路+缓存+出错丢帧」。→ `CHANNELS: ChannelSpec[]` 注册表（`{pathRe, parse, upgradeGate?, makeSubscriber, helloName}`）+ `gatedSubscribe()` 高阶函数。安全敏感面，改动需逐帧对拍（RFC-054/099 测试锁定）。
- 前端：6 个 WS hook 各写一份 `msg.type ===` if-链；`useTaskSync` 与 `useClarifyWs` 订阅同一 socket path、处理重叠事件但失效集不同（靠注释互相提醒）；reviews.detail + MultiDocReviewView 双挂 useTaskSync 开两条相同连接。→ 声明式 `INVALIDATION_RULES: Record<EventType, (msg,ctx)=>QueryKey[]>` + 泛型 `useWsInvalidation(path, rules)`，表本身可单测（符合「首选可断言面」仓规），顺带 socket 复用。

### 5.5 「一个函数缝两个」的模式参数（拆分即愈）

| 标志 | 位置 | 病状 | 拆法 |
|---|---|---|---|
| `LedgerOpenMode 'revivable'\|'in-flight'` | `clarifyRerunLedger.ts:60,89-142` | 4 调用点全传字面量；`mintCause` 仅一种模式有意义；`taskQuestions.ts:679-703` 还有一份自称 mirror 实则语义不等价的内联副本（已历两次三处齐改） | 拆 `isEntryConsumedForBorrow` / `isEntryConsumedForDispatch` 共享核心；第三种 queued 语义若确属独立则命名第三个导出 |
| `stageTaskQuestion(db, id, staged: boolean, actor)` | `taskQuestions.ts:1502-1563` | 两方向的守卫/写粒度/原子性全不对称（stage 逐行+seal 门+CAS；unstage 级联+无门） | 拆 stage/unstage 两导出，route 按 body 分发一次 |
| `listMemories(…, {includeBody})` | `memory.ts:196-230` | 布尔切换返回类型（overload 救回类型面），两条路径耦一个查询函数 | 拆 `listMemories`/`listMemorySummaries` 共享 where |
| `resolveDependsClosure(…, allowMissing)` | `agentDeps.ts:46-85` | 布尔改变返回契约的可达分支，调用点靠注释解释（`routes/agents.ts:189-198` "shouldn't happen" 防御） | 拆 Lenient/Strict 两函数，窄类型消灭防御分支 |
| `sealRoundQuestions` 布尔簇（autoStage/allowResealFor/死 flag） | `clarifySeal.ts:98-123` | 每个 flag 文档都在解释「只有 X 通道会传」——调用方身份决定组合 | `SealPolicy` 具名预设（CONTROL/AUTO_DISPATCH），新通道=新预设 |
| `searchUsersPublic` 的 `excluded.size === 0` | `users.ts:286` | 用另一参数的基数隐式切换 disabled 可见性；传 `[]` 即意外看到 disabled | 显式 `includeDisabled` 或拆 `searchAssignableUsers` |
| `submitClarifyAnswers` 的 `defer` + 3 伴随参数 | `routes/clarify.ts:223-268` | 布尔选两条 80 行管线，伴随参数仅一侧合法、靠 2 个手工 422 | zod `discriminatedUnion('channel', [Quick, Control])`，wire 兼容层映射旧 defer |
| `BatchImportDialog.handleRetry(id, withOverride)` | `BatchImportDialog.tsx:142,287,295` | 教科书 flag argument | 拆两函数或 `mode` 枚举 |
| `WorkflowCanvas` 双身份 | `WorkflowCanvas.tsx:127-184` | `readOnly`+5 个 sentinel props 组合出「编辑画布 vs 任务画布」两个组件（双保险判定 10 处、readOnly 38 行、每加 overlay 复制一套 ref-guard 样板、toFlowNodes 7 参数） | `mode: 'edit'\|'task'` + 单 `taskOverlay` 对象（一个 ref-guard 管全部） |
| 连接通道 4 条平行 if-链 | `WorkflowCanvas.tsx:553-689/858-941/263-271/1017-1021` | clarify→cross-clarify 演化即整套复制（drag helper 295↔453 行平行），顺序敏感（:900-931 记录过顺序 bug） | 「连接通道」注册表 `{classify, validate, apply, cascadeOnEdgeDelete, cascadeOnNodeDelete, systemHandleNames}`（与 §4.5 端口注册表联动） |
| `clarify.detail.tsx` `isCross` ≥18 处 | `:690` 起 | 一页实为两页；4 个 kind 早退 effect | 不拆页（hook 稳定性），cross-only 片段聚合成自判 kind 的子组件（`ClarifyQuestionHandler` 已是范例）；clarify.tsx renderRow 两份 `<tr>` 合并 |
| clarify 草稿状态机 ×2 | `clarify.detail.tsx:157-398` vs `CentralizedAnswerDialog.tsx:418-546` | 同一「服务端草稿优先/IDB 兜底/LWW/熔断」协议两份且已分叉（remote-merge/saving 指示器 vs resubmit 排除） | `useClarifyRoundDraft()` hook，内部 `'idle'\|'seeding'\|'ready'` 显式阶段枚举 |

### 5.6 其他 P1/P2 值得登记的

- **`allowTerminal` 语义漂移**（`lifecycle.ts:145` 写着 "ONLY for fixup scripts"，实际 17 个正常流持有者）：真实缺口是转移表没有 `revive`/`rearm` 事件，迫使 wrapper 复用行续跑/fanout 原地重跑绕低阶 API。→ 补事件、正常流迁回、allowTerminal 回归 fixup-only。
- **`IsoHandle.passthrough` 11 处守卫**（`nodeIsolation.ts:69` + scheduler 6 处）→ null-object（`PassthroughIso` 各操作 no-op），调用方 if 全删。同型正例已有：`subagentLiveCapture.ts:100`、`memoryDistillScheduler.ts:388` 的 NOOP_HANDLE。
- **`WrapperProgressSchema` 非判别联合**（kind+全 optional，`wrapperProgress.ts:43-106`）→ `z.discriminatedUnion('kind',…)`。
- **memory scope 四元组分支 ~6 函数群**（`memory.ts:699-724` 手写 agent/workflow 表分支**旁路了 `resourceAcl.ts:54` 的 `ACL_TABLES`**、`memoryInject.ts:105-163` 四段查询、distiller 四元组）→ scope descriptor 表复用 ACL_TABLES。产品上 scope 极少变，P2。
- **launcher 输入 kind 分发 5 处**（`workflows.launch.tsx:398-497/212/143-202` + `NodeInspector.tsx:201-220`，upload 平行 state 是根源）→ input-kind 注册表 `{editorExtraFields, launcherControl, isMissing, needsMultipart}`。注意 launch body whitelist 雷区（memory 已档）。
- **`connectionSync` 双 kind 三入口**（review/output 字段↔边镜像，`connectionSync.ts:158-391`）→ per-kind edge-bound field descriptor；本身已是单一 chokepoint，优先级低。
- **`ModelSelect` 双重 runtime 选择 props**（RFC-111 `runtime` 与 RFC-114 `runtimeName` 覆盖关系，`ModelSelect.tsx:41-73`）→ 单一 `source: {kind:'protocol'|'runtime', name}` 联合。
- **`GroupWrapperNode` 内 kind 三元链 6 分支点**（`WrapperNodes.tsx:49-267`）→ `WRAPPER_CHROME: Record<kind, {icon, labelKey, pillKey, portLayout}>` 配置表；顺带修 `:191/:247` 的 `'__done__'` 字面量（绕过 `FANOUT_DONE_PORT_NAME` 与 signal-kind 判定，aggregator 得不到 signal 样式）。
- **布尔 query 解析四种口径**（`oidc.ts:52` 仅 'true' / `memories.ts:206` 'true'|'1' / `cached-repos.ts:40`、`runtime.ts:54` '1'|'true' / `tasks.ts:555` `!== 'false'` 双重否定）→ `util/http.ts parseBoolQuery(c, name, {default})`，非法 422。
- **DB 布尔列两制并存**：裸 integer 0/1 三列（`tasks.auto_recovery_suspended:494`、`users.force_password_change:1297`、`oidc_providers.enabled:1378`）与其余 `mode:'boolean'` 混用，消费点手写 `=== 1`/`? 1 : 0`（auth.ts、users.ts、recoveryBreaker.ts、doctor.ts）→ 统一 `mode:'boolean'`（存储格式不变、零迁移）。
- **`resourcePermissionGate` union 硬编码 6 种**，`server.ts:126-137` 为 settings 手工复刻同构 gate → union 放宽即消除。
- **`exitCondition` parse/evaluate 双链**（`exitCondition.ts:31-73`）：封闭 4 值小集合、现状可容忍；产品要扩展时再做 `EXIT_CONDITION_REGISTRY`（登记触发器，勿预支）。
- **`QuestionForm` kind 分支 ×10**（单组件内聚，可接受）：第三种题型出现时先拆 Single/MultiChoiceBody，登记触发器。
- **小字面量绕过**：`NodeInspector.tsx:1040` `rec.sessionMode ?? 'isolated'` 绕过 `resolveClarifySessionMode`（docstring 明言防 sprinkle）；`'__commit_push__'` 前缀 backend/frontend 各一份字面量（`commitPush.ts:15` vs `tasks.detail.tsx:825`）应移 shared；`NEW_CLARIFY_TRIGGER_CAUSES`（`task-questions.ts:234`）加 `satisfies readonly RerunCause[]` 把 test-forced 升 compile-forced；`wrapperFanout.ts:128` / `outputKinds/index.ts:63` 的 `?? 'string'` 硬编码应引 `DEFAULT_OUTPUT_KIND`；`OUTPUT_KIND_UI` 的 `downloadable`/`dataBearing` 两维零消费者（`output-port.ts:13-16` 结构判断绕过）——查表或删维防假 SSOT；outputKinds legacy `HANDLERS` Record + markdownFile.ts 未删（registry.ts:19-21 自述）；单用户模式 sentinel `source==='daemon'` 五连拷 → `useIsMultiUser()`；`canManage ?? isAdmin` ×7 + isAdmin 双供给路径 + editable/onEdit 双重编码 → `canManageMemory()` 谓词 + `useMemoryEditDialog()`；`Field group` 布尔（3 字面量调用点）→ `as: 'label'|'group'`；`memberContainer` 第 5 位置布尔（`structureGraph.ts:265,608`）。

## 6. 既有良好扩展点盘点（目标形态范本）

落地本文任何改造时，**优先照抄这些已验证的形态**：

| 范本 | 位置 | 形态 |
|---|---|---|
| 任务/节点状态机 | `shared/lifecycle.ts`（RFC-053/097/108） | 事件 ADT + 转移表 + CAS + allowedFrom + ESLint ratchet + s14 源码守卫（四层防护） |
| 修复选项注册表 | `lifecycleRepair.ts:77-107` + `shared/diagnose-repair.ts:122-148` | `satisfies Record` 双端编译强制 + boot taxonomy 断言 + grep-guard；行为对象（preflight/apply/destructive） |
| 输出 kind 注册表 | `shared/outputKinds/registry.ts:278-335` + `uiCatalog.ts:125-142` | **全仓最完善**：注册 + load-time drift-guard 三层 boot throw；RFC-080 `handler.carriesData()` 能力查询优于 kind 枚举（`controlFlowEdge.ts:45-51` 消费范例） |
| 分片注册表 | `shared/shardingRegistry.ts` | registry + `path<*>` 通配回退，**已核实无绕过**（scheduler.ts:3815 唯一消费点） |
| 状态分桶穷举 | `dispatchFrontier.ts:296-357` isDispatchable + `scheduler.ts:1494-1588` deriveFrontier | exhaustive switch + never（新增状态编译红），已消灭历史 5 次漏桶 |
| freshest picker 单源族 | `freshness.ts`（RFC-096/098） | "the ONE sanctioned picker" 收口九处漂移 fork |
| rerunCause 枚举列 | `nodeRunMint.ts:198-241`（WP-10 先行） | 「行为什么存在」入结构化列，穷尽 switch，替代代理条件 |
| 冲突码策略集合 | `clarifyAutoDispatch.ts:86-102` | ReadonlySet 导出 "the ONE shared retryable set"，新增冲突码=加一项 |
| 资源 ACL 单源 | `resourceAcl.ts:54-163`（RFC-099） | `ACL_TABLES` 注册 + 谓词族；**跨包核查未发现绕过**（仅 memory.ts 部分旁路，见 §5.6） |
| ACL 端点参数化 | `routes/resourceAcl.ts mountAclEndpoints` | 按 `{type, base, param, load}` 五资源复用 |
| 权限点声明 | `auth/permissions.ts:12,63` `ROLE_PERMISSIONS` | 表驱动 gate |
| runtime 三级 fallback | `runtimeRegistry.ts:204-227` + `resolveFrozenRuntime` | 内部系统代理（distiller/commit/merge）统一样板，无旁路 |
| 前端渲染器注册 | `WorkflowCanvas.tsx:113-125` `NODE_TYPES` | per-kind 渲染器 + 共享小组件（QuestionBadge "one source of truth, no per-node fork"） |
| 前端状态表驱动 | `lib/task-status.ts TASK_STATUS_KIND`、`TaskQuestionList` PHASE_ORDER/PHASE_KIND/DISPATCH_ERROR_KEYS | Record 表 + `<StatusChip>` kind 枚举 |
| sentinel→联合 resolver | `lib/review/readonly.ts resolveReviewView`、`lib/noderun-status.ts`（supersede 前缀唯一 decode 点） | 边界一次解析成判别联合 |
| 纯决策 oracle | `clarifyFallback.ts decideResumeSessionId` + `SESSION_NOT_FOUND_PATTERNS` 注册表、`clarifyRounds.ts resolveEffectiveClarifyChannel`、`dispatchFrontier.ts decideScopeOutcome`、`shared/schemas/review.ts:473` | 决策集中一处、scheduler 只消费结果 |
| null-object | `subagentLiveCapture.ts:100`、`memoryDistillScheduler.ts:388` | 禁用态返回 no-op handle，调用方零分支 |
| 能力集派生 | `gitVersion.ts:55-62 capabilitiesFromVersion` | 版本→能力布尔集一次求值，消费端读能力不比版本 |
| 类型层防线 | `api/client.ts:26`（query 类型禁布尔）、`resumeStatus` 三态枚举注释（tasks.detail.tsx:1082） | 让非法态不可表达 |
| 标志拆除先例 | RFC-130（readonly 并行标志→iso 机制）、RFC-141（4 门→2 门）、RFC-132（三路注入 fork→单队列 `selectAgentQueue`） | 「删标志换机制」的通路已验证 |

## 7. 建议落地路线（与既有队列挂钩）

**原则沿用 fortify-then-refactor**：每包先落 oracle 测试（红）再动刀；全部走 RFC（除 W0 快赢）。

- **W0｜快赢批次**（不必单独 RFC，随手 PR + 测试，可拆多个小 commit）：
  §3 的死旗标清扫（1/2/4 + 死代码型全列）与 3 个前端映射 bug 修复；`isWrapperKind` shared 导出 + 全仓机械替换（dedup-audit 已列零散快赢）；终态集合全部改 import shared + `gc.ts` 收口 + 同名异义改名；noderunTone/决策 chip/clarify 状态映射收进 lib 表；`daemon-restart` 常量化；`parseBoolQuery` 统一；DB 0/1 三列改 `mode:'boolean'`；小字面量绕过批改（§5.6 末段）。**`revokePats` 与 `claudeCodeEnabled` 需用户先拍板**。
- **RFC-G1｜runtime 能力对象收口**（§4.1，L）——独立可先行；与 dedup-audit RFC-C（resolveOpencodeCmd 五处复制等 opencode 收口）相邻，建议同期。
- **RFC-G2｜merge_state 状态机化**（§4.4，M）——照抄 RFC-053 三件套；与 scheduler-audit WP-4（nextTaskStatus CAS 家族）同族但独立可做。
- **RFC-G3｜失败形态结构化**（§4.3，M-L）——与 scheduler-audit **WP-10（rerun_cause）合并推进**最划算（同为「成因入列、门控改 switch」）；过渡版（前缀注册表）可先行。
- **RFC-G4｜节点 kind 知识收口**（§4.2，M-L）——W0 的谓词收敛后，做行为表逐维接线 + derivePorts 单源 + NodeInspector/nodePalette 注册表化；前端部分注意与 scheduler-audit WP-6（wrapper 语义一致化）边界：G4 管「kind 判定与注册面」，WP-6 管「wrapper 运行时语义」。
- **RFC-G5｜系统通道端口描述符注册表**（§4.5，M）——先测试钉住 scheduler nuanced 语义；与 5.5 的「连接通道注册表」（前端）同一 RFC 或前后脚。
- **RFC-G6｜prompt/clarify 协议 ADT + RFC-132 PR-4 收尾**（§5.1，M-L）——golden 锁字节护航。
- **RFC-G7｜review 决策策略表 + 多文档 mode 单源 + 前端只读视图 variant 化**（§5.2，M-L）——`resolveReviewRoundMode` 第一步可单独先落（S）。
- **RFC-G8｜前端 Segmented/TabBar 原语 + ConfirmButton variant 化**（§4.6，M）——对应 CLAUDE.md 前台统一风格条款；与 dedup-audit RFC-F（页面骨架）互补不重叠。
- **RFC-G9｜五资源页骨架**（§5.3，M-L）——建议直接并入 dedup-audit RFC-F 扩大版（其 §4.7 已含 detail header/ListPicker/ResourceList 裁决）。
- **RFC-G10｜WS 双端注册表**（§5.4，M）——后端频道 spec + 前端失效规则表；安全敏感，逐帧对拍。

**推荐顺序**：W0（立即）→ G1 / G2（并行，独立域）→ G3（搭 WP-10）→ G4 → G5 → G6 → G7 → G8 / G9（前端批，可与后端并行）→ G10。与 scheduler-audit 总路线（WP-1→WP-7→…）不冲突：G2/G3 与 WP-4/WP-10 排期对齐即可。

## 8. 需要用户拍板的决策点

1. **`revokePats`**：实现（resetPassword 里调 PAT 吊销，几行）还是从 schema+interface 删除？「收而不办」的安全开关不允许继续存在。
2. **`claudeCodeEnabled`**：删除（前端改读 runtimes 注册表 enabled）还是后端补 enforce？
3. **`markdown_file` 倒灌修复**：新写入改 `path<md>`（读侧 parse 等价折叠、兼容无虞）是否需要附带存量数据迁移说明？
4. **`ResourceList.tsx` 死组件**：复活成通用 DataTable 壳（G9 的载体）还是删除？（dedup-audit 同问未决）
5. **W0 中 `fanoutSourceSync` 调用位内联删除**：文件头自述 "A follow-up cleanup PR can inline-delete the call sites"——确认按此执行。
