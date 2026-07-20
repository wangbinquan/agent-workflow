# 附录 B｜逃逸缺陷考古（4 条证据流）

> 每条记录回答同一个问题：**当时那么厚的测试网为什么没拦住它？**
> `whoFoundIt=user-report` 表示这条是用户在生产中撞到后才被发现的。


## A1 — RFC 文档里的用户报告类缺陷

跑的检索：先用题面给的 9 个关键词对 design/RFC-*/proposal.md 全量 grep（命中 35 个 RFC），逐个读背景/根因段 + design.md 的「测试策略」段；再对每条结论去落地物证——find 定位 e2e/focus-ring-clip.spec.ts、packages/frontend/tests/{dialog-body-focus-outline-clip,workgroup-room-composer-outline-clip,editor-layout-viewport-fit,focus-ring-inset}.test.ts、packages/backend/tests/{input-port-contract,scheduler-audit-s10-async-transaction-decorative,rfc093-db-tx-sync,workgroup-host-output-isolation,rfc202-*,rfc193-*,rfc199-*}.test.ts；另用 grep 搜 `inputs-editor__kind|outputs-editor__kind`（src 与 tests 均零命中，反证 RFC-194 说的「假绿」测试确实只存在于 CSS 文本里）；并实读了两个焦点环守卫的文件头注释确认它们自承「source-level assertions against styles.css — jsdom does no layout」。

三条结论。

第一，**本仓的逃逸不是「没测」，而是「测的形状不对」**。20 条里只有 RFC-004 一条接近「压根没测」（画布 happy path 无覆盖，且 fixture 用 'out' 与画布产出的 inputKey 不同形，属漂移导致的假覆盖）。其余全是：测了单条路径但没测组合（RFC-052/053/074/202）、测了两套镜像实现的其中一套（RFC-058/064）、测了后端解析但没测字段有没有到达用户（RFC-103/156/175）、或者测的是源码文本而非行为（RFC-206/194，以及 RFC-184/193/202 的兜底层仍是文本锁）。**厚测试网 + 路径式形状 = 对 seam 和组合空间完全无防护。**

第二，**「源码文本断言」在本仓已经造成了可量化的伤害**。RFC-206 是最贵的样本：四次补丁各留一条 styles.css 文本锁，四条全绿，用户报到第五次；proposal.md:30 直陈「jsdom 没有布局引擎，这类测试永远无法发现实际被切了」。RFC-194 是最干净的样本：CSS 约束了一个 DOM 从未挂过的 class，测试恒绿且零价值。可执行的元规则应是——**任何针对某 class/字面量的源码文本断言，必须同时有一条断言证明该字面量在真实渲染/执行路径上生效**（RFC-206 的反向自检探针 + AC2 变异测试就是这个思路，但只在这一个 RFC 里做了）。

第三，**分清「补了一条」与「上升为机制」是本次审计最有区分度的判据**。真正上升为机制的只有 6 条：RFC-053（NodeKind handler 表的 TypeScript exhaustiveness，编译期强制，最强一档）、RFC-093（类型层拒绝 async 事务回调）、RFC-074（provenance 行戳取代标量 counter，三套 picker 收敛为一个纯函数）、RFC-064（合掉字段维度本身）、RFC-206（真实布局引擎守卫 + 修法从 O(容器数) 改 O(1)）、RFC-057（typed 修复白名单取代一次性脚本）。其余 14 条都是单点补，同类问题的复发位置在每条的 guardGeneralized 里已标出。最值钱的教训是 RFC-058→RFC-064 那条链：**抽出公共原语若不同时消灭产生分叉的那个维度，漏镜像还会继续**——RFC-058 合了表和 prompt 层，之后仍出血 4 次，直到 RFC-064 把两个计数器合成一个才止住。同一模式正在 RFC-103/156/175 的「多入口漏透传」上重演（用户 memory 里的 stampLaunchExtras 事故是第二次），至今没有结构约束。

未纳入表内但同类的用户报告：RFC-016（包装器「很难用、很难理解」）、RFC-168（工作组详情页「太丑」）、RFC-173（资源与依赖界面「太丑」）、RFC-137（答题不该区分同/跨节点）——这四条与 RFC-008 同属 ui-visual-or-layout，共同缺口是仓库直到 RFC-206 才有第一条真实布局引擎的守卫，此前 UI 只靠 e2e 截图基线兜底，而该基线本身只覆盖默认页签。

### `design/RFC-206-focus-ring-clip-elimination/proposal.md:9,30` — /repos 批量导入弹窗里输入框聚焦时上边缘被切掉、/agents 高级页签输入框左右边缘被切掉；用户原话「还有好几个地方都是这样的」「为什么总是出这种问题」。

- **发现者**：user-report　**根因类别**：`text-assertion-only`
- **现象**：/repos 批量导入弹窗里输入框聚焦时上边缘被切掉、/agents 高级页签输入框左右边缘被切掉；用户原话「还有好几个地方都是这样的」「为什么总是出这种问题」。
- **测试网为什么没拦住**：这是同一现象的**第五次**复发，前四次都留了测试锁（packages/frontend/tests/dialog-body-focus-outline-clip.test.ts、workgroup-room-composer-outline-clip.test.ts、editor-layout-viewport-fit.test.ts），但这三个文件全部是对 packages/frontend/src/styles.css 的**源码文本断言**——我实读了 dialog-body-focus-outline-clip.test.ts:18-20，注释自己写明「These are source-level assertions against styles.css — jsdom does no layout」。jsdom 没有布局引擎，这类测试只能锁住「某条补丁的字面量还在」，物理上无法发现「实际被切了」。缺陷发生在两个各自增长的集合的笛卡尔积上：外扩焦点环规则约 36 条 × overflow!=visible 裁剪容器 100+ 条，交叉处无归属，写 CSS 的人看不见三层之下被切的控件。
- **当时补的防护**：新增 e2e/focus-ring-clip.spec.ts：Playwright + CDP 强制 :focus-visible 伪类，在**真实布局引擎**里遍历全部主要路由与弹窗，逐边测量 room < ink 即失败并报出「哪个元素、被哪个容器、切了哪条边、差多少 px」；配套 packages/frontend/tests/focus-ring-inset.test.ts 静态守卫（外扩环必须命中「固有尺寸控件」白名单）。两层白名单都带陈旧条目检测。
- **是否上升为通用机制**：这次是唯一一条真正**上升为通用机制**的：修法从 O(容器数) 的「给容器补 padding」改成 O(1) 的「环画在控件内部」，并配了两层可执行守卫 + 反向自检探针（design.md:229 注入一个必然被切的元素证明审计引擎没瞎）+ AC2 变异测试（把 .form-input:focus 的 outline-offset 改回 0 必须变红，防守卫退化成空跑）。design.md:195 记录收口自查时又补抓到三个静默假阴（≤720px 视口漏扫、按类名+容器去重导致漏测、UA outline-style:auto 被低报）——说明「几何守卫」本身也需要防空跑机制。前四次补丁则是典型的单点补：每次只补被报出来的那条轴，所以每次都从没补到的轴复发。

### `design/RFC-184-workgroup-host-output-isolation/proposal.md:9,15` — 线上任务 01KXFE9668F0TJ7D2P720F42SE（leader_worker 全自动）第一轮 leader 秒挂，error_message=port-validation-path-empty-path。DB 里 6 个工作

- **发现者**：user-report　**根因类别**：`mock-too-deep`
- **现象**：线上任务 01KXFE9668F0TJ7D2P720F42SE（leader_worker 全自动）第一轮 leader 秒挂，error_message=port-validation-path-empty-path。DB 里 6 个工作组任务全部 failed/interrupted、**0 个 done**；唯二到 dispatched 的 assignment 都是人类手动 @coder 建的——leader 自动派发这条路从来没跑通过一次。
- **测试网为什么没拦住**：工作组引擎测试全部把 runHostNode **stub 掉了**（rfc164-workgroup-engine.test.ts:170 直接返回假 outputs），真实 runNode 路径从未被覆盖；测试文件自己在 733-734 行承认了这一点。mock 打得太深，把「host 轮复用成员真实 agent 的 outputs/outputKinds 原样喂进通用 runNode」这条真实接线整段挖空，于是 parseEnvelope 补空串（envelope.ts:381-384）→ RFC-049 逐 kind 校验按 path<md> 拒空串（runner.ts:1323-1346）的整条因果链在测试里根本不存在。
- **当时补的防护**：新增 packages/backend/tests/workgroup-host-output-isolation.test.ts，走**真实 runNode**（非 stub hook）红→绿：不投影则秒挂、投影后 done 且 outputs 带 wg 端口；另锁 wgHostRolePorts 与 renderWgProtocolBlock 的 <port> 清单逐 role 镜像、以及「host 轮 node_run_outputs 零行」不变式。
- **是否上升为通用机制**：只补了工作组这一处。文件顶部注释自承「真实 runHostNode 需 iso+git，单测难触，故用源码文本锁兜底 scheduler/workgroupRunner 三处接线」——也就是接线层仍是 text-assertion。同类问题会复发在任何「引擎测试 stub 掉真实执行原语」的地方：dynamicWorkflowRunner 的编排 host 轮（本 RFC 显式非目标）、以及所有以 fake outputs 短路 runNode/runner 的套件。仓库没有一条通用的「stub 覆盖率/真实路径必须至少有一条 e2e」的机制。

### `design/RFC-074-provenance-node-freshness/proposal.md:26-46,60` — 任务 01KSHVXCH6RQ5F5P64MZ4FZVN6：用户 approve v2 后 18ms，同一 review 节点又冒出一行 awaiting_review，强制用户对**刚批准过的同一份内容**再批一次。

- **发现者**：user-report　**根因类别**：`cross-module-seam`
- **现象**：任务 01KSHVXCH6RQ5F5P64MZ4FZVN6：用户 approve v2 后 18ms，同一 review 节点又冒出一行 awaiting_review，强制用户对**刚批准过的同一份内容**再批一次。
- **测试网为什么没拦住**：根因不是某处写错，而是「用标量 counter（clarifyIteration）模拟 DAG 图级因果」这个建模选择。同一个 cci 被三套**互相不一致**的 picker 解读：isFresherNodeRun（scheduler.ts:411，键 = cci,retryIndex,id）、resolveUpstreamInputs（scheduler.ts:3133，键 = iteration,retryIndex，**无 cci**）、Layer B freshness（scheduler.ts:763，纯数值比大小）。「节点实际读了哪行内容」与「freshness 认为哪行最新」可以是不同的行。既有测试都沿着单条已知路径走，跨这三个 picker 的组合从未被交叉验证。落 RFC 前补做的 17 场景端到端探测（packages/backend/tests/clarify-review-combination-scenarios.test.ts）一次抓出 4 个 RED，其中最常见的 S8 只是「A(反问)→B(不反问)→检视」这种最普通的拓扑——说明缺的不是边缘用例，是**组合空间**从未被扫过。
- **当时补的防护**：PR-A 先锁 ≥20 条现有行为 baseline（含事故 task 快照回放 A18-A20），PR-B 落 isNodeRunFresh 纯函数 + consumed_by 行戳 provenance（≥16 case），PR-C 退役 cci（≥12 case）。三个 PASS 边界场景 S10/S11/S18 被显式保留为回归锁，划清触发边界。
- **是否上升为通用机制**：**上升为机制**：把 freshness 从「counter 比大小」换成「记因果行戳」，是 RFC-070 在 clarify 老化上已验证的同一招推广到节点数据流；三套 picker 收敛为一个 isNodeRunFresh 纯函数。方法论上也上升了——「先写组合场景探测器再落 RFC」这套做法（17 场景 × 真 runTask）是本仓少见的主动组合扫描。但它是这一个 RFC 的一次性动作，没变成对其它 seam（wrapper 嵌套 × retry × cancel、multi-repo × fanout × iso）的常设组合探测。

### `design/RFC-064-unified-clarify-runtime/proposal.md:14-40` — 10 天内 10 个 dated patch（design/RFC-056-clarify-cross-agent/patch-2026-05-22..27 共 9 个 + commit 747dcae），表现各异：下游 done 行盖过新

- **发现者**：self-audit　**根因类别**：`duplicated-impl-drift`
- **现象**：10 天内 10 个 dated patch（design/RFC-056-clarify-cross-agent/patch-2026-05-22..27 共 9 个 + commit 747dcae），表现各异：下游 done 行盖过新一轮、反问者重跑拿到空 prompt、External Feedback 块整块消失、run-history 行被折叠、cascade 被错误 skip、review 在更高 cci 下永不 dispatch、stale directive='stop' 污染 review-iterate 重跑导致 <workflow-clarify> 协议块被 drop。
- **测试网为什么没拦住**：其中 7 个根因完全相同：clarifyIteration 与 crossClarifyIteration 两个独立计数器互相错位，任一 codepath（mint / inherit / freshness / cutoff / dispatch / cascade / prompt-render gate）漏镜像就漏一处行为。每个 patch 都各自带了专属测试文件（cross-clarify-designer-retry-index.test.ts / review-dispatch-prefers-clarify-rerun.test.ts / clarify-stop-directive-scoped-to-clarify-rerun.test.ts 等），但测试锁的都是「这一个 codepath 在 cci 维度也做对了」，**没有任何测试能表达「所有 codepath 必须在两个维度上对称」**这条元规则。RFC-058 已经合了 DB 和 prompt 层仍不够，4 个 patch 在合表之后照样发生。
- **当时补的防护**：migration 0033 把 cci 列折入 clarifyIteration，字段层合一；两条分支的 gate 表达式合并为公共变量 isClarifyRerun（scheduler.ts:1390）；扩 cross-clarify-stop-directive-scoped-to-cci-rerun.test.ts 的源码文本守门 pattern 接受新旧任一形态，不许 silent drop gate。
- **是否上升为通用机制**：**上升为机制**（消除维度本身），但过程说明了「只合一半」的代价：RFC-058 合了表和 prompt 层，仍继续出血 4 次；只有合到字段层才止住。留下的 gate 守卫仍是**源码文本断言**（grep isClarifyRerun 或旧字面量），行为层未防护——若某天 gate 表达式被重构成等价的别名形态而语义写错，文本锁会假绿。

### `design/RFC-052-review-retry-cascade-stuck/proposal.md:5-40` — 线上 task 01KS1N8WVZWE8FTR4K9WSETRNW：用户 approve v5 后自动冒出内容相同的 v6，再 approve 后任务永久卡死 awaiting_review 且 UI 再无任何待决策 doc_versio

- **发现者**：user-report　**根因类别**：`happy-path-only`
- **现象**：线上 task 01KS1N8WVZWE8FTR4K9WSETRNW：用户 approve v5 后自动冒出内容相同的 v6，再 approve 后任务永久卡死 awaiting_review 且 UI 再无任何待决策 doc_version。DB 实测 v5/v6 都是 approved、node_run finished_at 停在 v5 时刻。
- **测试网为什么没拦住**：三重 happy-path-only：(1) retryNode 的 cascade 一视同仁给所有下游 mint retry 占位行，测试从没构造过「review/clarify/output 这类非进程节点被级联」的场景；(2) dispatchReviewNode 用 Array.find 取第一行，而 scheduler 用 isFresherNodeRun——**两套挑选器不一致**，但没有任何测试同时驱动这两条路径；(3) 第二次 approve 撞 node_run_outputs 的 PRIMARY KEY(node_run_id, port_name) 抛异常，status=done 的 update 未执行——「重复 approve」这条错误路径根本没测。而 doc_version 已先一步被改成 approved（review.ts:1080-1096 早于 outputs insert），形成半提交。
- **当时补的防护**：4 个新测试：review-dispatch-terminal-state.test.ts（done 行不被复位）、review-dispatch-row-selection.test.ts（用 freshness 挑选器）、retry-node-no-review-cascade.test.ts（非进程节点不被 mint）、review-approve-idempotent.test.ts（重复 approve 幂等）。
- **是否上升为通用机制**：这次只修了 instance——RFC-053 proposal.md 开篇即承认这一点并去修「产生 instance 的温床」。四条测试都是单点回归锁，没有覆盖「任意顺序触发 approve/iterate/reject/retry/cancel 后 invariant 是否成立」的组合面。

### `design/RFC-053-node-run-lifecycle-hardening/proposal.md:10-32` — 不是单个 bug，是 RFC-052 事后分析出的 6 类结构风险：status 是无状态机的裸字段（7-8 处可直写、done→awaiting_review 无人拦）、同 nodeId 多行被三套挑选器解读、跨 kind 普适操作硬编码

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：不是单个 bug，是 RFC-052 事后分析出的 6 类结构风险：status 是无状态机的裸字段（7-8 处可直写、done→awaiting_review 无人拦）、同 nodeId 多行被三套挑选器解读、跨 kind 普适操作硬编码不走 handler 表、review/clarify 的双层状态无 invariant、关键路径 fire-and-forget、以及缺跨模块一致性测试。
- **测试网为什么没拦住**：proposal.md 自己把第 6 条列为风险源：「单测都是沿着已知路径走，缺『无论你按啥顺序触发 approve/iterate/reject/retry/cancel，下面这些 invariant 是否始终成立』的 property-based 测试」。这是本次审计里最精确的自我诊断——测试网厚度高但**形状**全是路径式，不是不变量式。
- **当时补的防护**：G1 transitionNodeRunStatus 单一写入口 + 非法转移抛 IllegalNodeRunTransition；G2 每个 NodeKind 必须显式声明 onRetryCascade/onEnforceLimits/onOrphanReap/onGc/onShutdown，TypeScript exhaustiveness 编译期强制新 kind 必填；G3 doc_versions↔node_runs / clarify_sessions↔node_runs 双层 invariant 启动全扫 + 每小时增量；G4 stuck-task detector；G5 重构前先把全 bug 区行为锁成可执行 baseline。
- **是否上升为通用机制**：**明确上升为通用机制**，且是本仓最成功的一次：编译期 exhaustiveness（新增 NodeKind 不填 handler 就编不过）是结构上不可能再犯的那一档，远强于任何测试。后续 RFC-097 又把同一招用到任务级（CAS + 转移表 + s14 守卫禁止直写）。但 G3 的 invariant 扫描是**运行期检测**不是防御——它只能在坏数据产生后报警（RFC-057 背景里三次线上事故正是被扫到了却只能开 SQL shell 手改）。

### `design/RFC-004-input-port-contract/proposal.md:9-30` — 线上 task 01KRNJXKNSXR8C1DHSCCCWHDD4：用户在画布上拖 input(requirement) → agent 两个节点、点 Launch，30s 后失败 no <workflow-output> envelop

- **发现者**：user-report　**根因类别**：`contract-drift`
- **现象**：线上 task 01KRNJXKNSXR8C1DHSCCCWHDD4：用户在画布上拖 input(requirement) → agent 两个节点、点 Launch，30s 后失败 no <workflow-output> envelope found in stdout。新用户第一次用 Launch 就撞上。
- **测试网为什么没拦住**：典型 contract-drift：设计文档、scheduler 运行时（scheduler.ts:319 硬编码 portName='out'）、backend 测试 fixture（scheduler.test.ts:125 也是 'out'）站一边；validator（workflow.validator.ts:134 用 inputKey）、画布 handle label（WorkflowCanvas.tsx:608）、RFC-003 的 catch-all 默认 wiring 站另一边。**测试 fixture 与画布实际产出的形态不符**，所以「从画布建工作流再启动」这条 happy path 一条测试都没有——proposal.md:12 原话「这条路径没有任何已有测试覆盖」。此外编辑器从不维护 definition.inputs[]，launcher 因此渲染不出表单字段，同样零覆盖。
- **当时补的防护**：packages/backend/tests/input-port-contract.test.ts（已存在），顶部注释锁明「Locks in port-name = inputKey contract. If this goes red, check scheduler.ts:319 and workflow.validator.ts:134 in lock-step. Originated RFC-004 / failed task 01KRNJXKNSXR8C1DHSCCCWHDD4」；scheduler.test.ts 三处 fixture 改为 inputKey；validator 新增 input-key-not-declared 硬规则 + input-orphan-declared warning；前端新增 sync-input-defs / input-inspector / launcher-renders-from-input-node / canvas-edit-old-workflow 四个测试文件。
- **是否上升为通用机制**：部分上升：validator 规则 input-key-not-declared 是结构性的（契约不一致会被启动前拦下）。但「测试 fixture 必须与画布真实产出同形」这条元教训没有机制化——仓库里 fixture 手写、画布产出由 nodePalette/canvas-connect 生成，两者仍是两份独立事实，任何新节点类型都可能重演同样的 fixture 漂移。

### `design/RFC-193-port-artifact-archival/proposal.md:8-31` — 线上断链：git/loop wrapper 内的 review 节点读不到上游 agent 写的文件（多文档模式落占位 body、单文档模式直接 review-source-resolve-failed，属死锁级必然失败）。用户同时问「怎么

- **发现者**：user-report　**根因类别**：`cross-module-seam`
- **现象**：线上断链：git/loop wrapper 内的 review 节点读不到上游 agent 写的文件（多文档模式落占位 body、单文档模式直接 review-source-resolve-failed，属死锁级必然失败）。用户同时问「怎么根治，以后肯定还会出现很多，包括其他 agent 读这个 agent 的输出」。
- **测试网为什么没拦住**：RFC-130 引入节点级隔离 worktree 后，path 类端口入库的路径字符串变成**悬挂指针**——兑现它需要每个消费方各自重建根/时刻/可见性三个隐含维度。排查一次性确认了**五类断链**（review.ts:471/658 恒用 task.worktreePath、runner.ts:1369 以节点 iso 为根校验、worktreeFiles.ts:28 只认主 worktree、下游 agent 读 gitignored 文件、fanout 按 list<path> 分片）。测试没拦住是因为每个消费方都被单独测过、各自 happy path 全绿；缺的是「路径解析只有一个入口」这条不变式，而且 wrapper 内 review 这个拓扑（validator 甚至推荐，workflow.validator.ts:880）从未被端到端跑过。
- **当时补的防护**：archive-at-emit：产出即固化归档；新增 rfc193-port-artifacts.test.ts / rfc193-port-artifacts-api.test.ts / rfc193-wrapper-review.test.ts / rfc193-force-include.test.ts（后端）、rfc193-artifact-preview-source.test.ts（前端）、rfc193-kind-items-and-nested-guard.test.ts（shared）。必写 case 含 wrapper 内 review 主回归（现状红）、gitignored 文件跨节点传播、二进制往返、portName 含 ../ 的 containment、两阶段无孤儿。
- **是否上升为通用机制**：**上升为机制**：G5 明确「路径解析收敛到单一读取原语 + 源码级文本锁，新消费方无法再自己拼根」。但兜底那一半仍是**源码文本锁**——它能防「新代码里出现自己拼根的字面量」，防不了「用别的写法拼出等价的错根」。断链清单会不会继续变长，取决于文本锁的 pattern 覆盖面。

### `design/RFC-202-lifecycle-exits-terminal-sweep/proposal.md:11-22` — 六组同主题问题：多文档评审上游产出空列表（审计零发现，本是成功态）导致任务永久卡死 awaiting_review 且四个入口全不可见；awaiting_human/awaiting_review 既不能取消也不能删除；daemon 正常重

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：六组同主题问题：多文档评审上游产出空列表（审计零发现，本是成功态）导致任务永久卡死 awaiting_review 且四个入口全不可见；awaiting_human/awaiting_review 既不能取消也不能删除；daemon 正常重启把在跑任务错标为「已取消」且写 daemon-shutdown 与 autoResume 只认的 daemon-restart 对不上；resumeTask 失败被吞（HTTP 200 + ok:false，前端当成功静默关窗）；删工作流不检查定时任务引用；本机实测收件箱 17 条反问几乎全部来自死任务，含等待 23 天的僵尸轮。
- **测试网为什么没拦住**：整类是 happy-path-only 的极端形态——生命周期只设计并测试了「往前走」的路，没有设计「退出/放弃/善后」的路，所以既没有实现也没有测试。空列表评审、零发现审计、daemon 优雅关停、resumeTask 失败三条路由、终态任务的 open 轮——每一条都是「正常情况不会走到」的分支。daemon-shutdown / daemon-restart 这对字符串不匹配尤其典型：两处各写各的字面量，没有共享常量也没有测试跨这两处断言。
- **当时补的防护**：packages/backend/tests/rfc202-lifecycle-exits.test.ts / rfc202-empty-review-auto-approve.test.ts / rfc202-source-locks.test.ts；空列表两条路径回归锁、cancelTask allowedFrom 对齐共享转移表、三路由 resume 失败可见、deleteWorkflow 409 引用保护、终态清场口径对历史行也生效。
- **是否上升为通用机制**：只在本 RFC 列举的六处补齐，且其中一层仍叫 rfc202-source-locks.test.ts（源码文本锁）。真正通用的那条——「所有等待态都必须有出口」「所有 fire-and-forget 的 resumeTask 失败都必须上浮」——没有做成可执行的穷举断言（比如「转移表里每个非终态都必须至少有一条到 canceled 的边」这类表驱动测试）。同类会复发在任何新增的等待态上。

### `design/RFC-051-inbox-route-remount-and-anchor-rehype/proposal.md:9-45` — 两个稳定可复现的用户报告 bug：(1) 收件箱里点开反问 A 再点 B，B 的问题列表整块空白；(2) 点评审 A→B→再回 A，页面崩溃 NotFoundError: Failed to execute 'removeChild'，白屏

- **发现者**：user-report　**根因类别**：`harness-cannot-express`
- **现象**：两个稳定可复现的用户报告 bug：(1) 收件箱里点开反问 A 再点 B，B 的问题列表整块空白；(2) 点评审 A→B→再回 A，页面崩溃 NotFoundError: Failed to execute 'removeChild'，白屏。已有用户工单提到「review iterate 后页面忽然白屏，刷新就好」——同一条 stack。
- **测试网为什么没拦住**：两条同根：TanStack Router 在同一路由不同 params 之间**默认不卸载组件**，而两个详情页的初始化都隐含「一次挂载 = 一个 nodeRunId」的假设（clarify.detail.tsx:80-128 的 draftLoaded 一次性闸门；reviews.detail.tsx:512-523 在 useLayoutEffect 里直接 mutate Prose 渲染出的 DOM）。测试全是「挂载一次 → 断言」，从没有测试在同一个 render tree 里改变路由 param 再断言——测试架子表达不了「路由复用组件」这个前提。review 那条更隐蔽：refetchInterval:8000 拉到新版本、或 iterate 后版本号 bump 都会触发同一条 removeChild 崩溃，与跨条目导航无关。
- **当时补的防护**：clarify 侧在 nodeRunId 变化时复位 answers/draftLoaded/initialFocusedRef；review 侧把锚点高亮从外部 DOM mutation 搬进本地 rehype 插件由 React 自己管理。测试落在 packages/frontend/tests/reviews-detail-anchor-rehype.test.tsx / prose-anchors-prop.test.tsx / wrap-anchors-in-dom.test.ts / anchor.test.ts。
- **是否上升为通用机制**：review 那一半**上升为机制**（消除外部 DOM mutation 这个类别，React 接管后 refetch 路径同一类崩溃一并消失）；clarify 那一半是单点复位——proposal.md 非目标里明写「不在本 RFC 给 TanStack Router 加全局 key={nodeRunId} 路由重挂载策略，仅对 clarify-detail 这一处做最小复位」。任何未来「同路由不同 params 复用组件」的详情页都会重犯 clarify 那半边。

### `design/RFC-093-db-tx-sync/proposal.md:7-16` — 5 处 db.transaction(async tx => …) 是**装饰性**的：bun:sqlite 的 Database.transaction 是同步包装，async 回调在第一个 await 处把 pending promis

- **发现者**：self-audit　**根因类别**：`duplicated-impl-drift`
- **现象**：5 处 db.transaction(async tx => …) 是**装饰性**的：bun:sqlite 的 Database.transaction 是同步包装，async 回调在第一个 await 处把 pending promise 还给包装器、包装器即刻 COMMIT，await 之后的语句逐条 autocommit、事后抛错不回滚。API 形态像安全的，实际零原子性。memory.ts:5-10 的头注释还声称靠该事务防 half-promoted（错误信念）。
- **测试网为什么没拦住**：这是**已经出过事故还复发**的一类：RFC-052 的 approve 半提交事故正是此类（lifecycleRepair/options-R2.ts:4-7 有记载），但 RFC-052 之后 review.ts:505 又新写了一处。原因是当时的修法是修那一处的具体半提交，没有从结构上封死「写出 .transaction(async」这个动作。clarify.ts:385-387 甚至有注释明写 verified——知识在注释里，不在编译器/测试里。
- **当时补的防护**：dbTxSync(db, tx => …) 同步事务原语：**类型层拒绝 async 回调**（返回 Promise 的回调直接编译错误）+ 运行时兜底（回调返回 Promise → 抛错并回滚）；5 处全部改写；packages/backend/tests/scheduler-audit-s10-async-transaction-decorative.test.ts 的守卫层翻转为「src 内 .transaction(async 零命中」；新增 rfc093-db-tx-sync.test.ts 含 @ts-expect-error 编译期拒绝断言 + review.ts 三步序列的红绿对照复制品。
- **是否上升为通用机制**：**上升为通用机制**，而且用对了最强那一档：类型层拒绝（编译不过）+ 零命中文本守卫双保险。proposal 非目标里明确「不加 ESLint 规则——仓内先例用源码文本守卫」，所以第二层仍是 grep 性质；但因为第一层是类型系统，绕过需要刻意，风险可接受。

### `design/RFC-103-drift-security-quickfix/proposal.md:17-24` — 一批已咬人的漂移：maxConcurrentNodes 全生产路径未接线（恒走默认 4，StartTaskDeps 连该字段都没有）；commitPush 只在 JSON start 传，resume/repair/retry/multip

- **发现者**：self-audit　**根因类别**：`wire-field-drop`
- **现象**：一批已咬人的漂移：maxConcurrentNodes 全生产路径未接线（恒走默认 4，StartTaskDeps 连该字段都没有）；commitPush 只在 JSON start 传，resume/repair/retry/multipart start 全不传、retryNode 内部 runTask 也不透传；opencode token 计量缺约 15×（accumulateTokens 读扁平 cache_creation/cache_read，真实输出是嵌套 cache:{read,write}，导致 max_total_tokens 限额失效）；fanout 用裸 .split('\n') 绕过单一事实源 splitListItems，含换行的文档被静默裂成多分片且任务照样 green；校验器与 prompt.ts 各维护一份 builtin 变量 Set，校验器漏 __repos__ 导致合法 launch 被误报阻止。
- **测试网为什么没拦住**：全部是 wire-field-drop / duplicated-impl-drift：字段在 schema 里、在设置页里、在一条入口里都对，只是**其余入口没接线**；或者同一份知识（builtin 变量集、list 切分规则、token 字段形状）被两处各写一份然后漂移。测试都按单入口写，没有任何「五个启动入口必须透传同一组 options」的表驱动断言；token 那条更是外部契约（opencode 输出形状）从未被真实样本验证；fanout 误裂**不产生任何失败信号**（任务照样 green），行为层无 oracle 可断言。
- **当时补的防护**：修法明确是 **service 层 plumbing**（给 deps/options 加 maxConcurrentNodes + 补 retryNode commitPush 透传）+ **5 个入口全覆盖**测试，而不是纯 route 层补齐；fanout 收敛回 splitListItems 单一事实源；校验器与 prompt.ts 的 builtin 变量集合并。
- **是否上升为通用机制**：「5 个入口全覆盖」是穷举而非机制——新增第 6 个入口仍会漏。用户 memory 里已记录同型复发（reference_launch_body_helper_whitelist：buildLaunchBody 白名单 DROP extras，autoCommitPush/workingBranch/collaboratorUserIds 被丢，commit c29d063 才补 stampLaunchExtras）。这说明「多入口共享 options」这条缝在本仓至少咬过两次，且至今没有一条「所有入口必须走同一个 options builder」的结构约束。

### `design/RFC-194-agent-port-editor-ux/proposal.md:32` — 用户 2026-07-15 反馈「代理的编辑页面，配置端口的那个页面很难用」。实测出六类问题（名字像输入框却不能编辑、添加入口不可发现、类型控件被挤成工具条、输入/输出关系说不清、<Field> 包住导致 a11y 语义错误、已批准的 de

- **发现者**：user-report　**根因类别**：`text-assertion-only`
- **现象**：用户 2026-07-15 反馈「代理的编辑页面，配置端口的那个页面很难用」。实测出六类问题（名字像输入框却不能编辑、添加入口不可发现、类型控件被挤成工具条、输入/输出关系说不清、<Field> 包住导致 a11y 语义错误、已批准的 description 字段有 schema 无 UI）。
- **测试网为什么没拦住**：第 7 条是本次审计最干净的**假绿**样本：现有防溢出测试断言 CSS 里约束了 .inputs-editor__kind / .outputs-editor__kind，**但 DOM 根本没有挂这两个 class**——测试只匹配死 CSS 文本，没有验证真实布局，所以恒绿且零价值。我用 grep 在 packages/frontend/src 与 packages/frontend/tests 里搜这两个 class 名，现在**零命中**（随本 RFC 一并退役），侧面确认了它当年只存在于 styles.css 与那条文本断言里。
- **当时补的防护**：端口编辑器整体重构为逐端口卡片 + 共享 Dialog；e2e/agent-port-editor.spec.ts 提供真实浏览器路径覆盖；重命名迁移 outputs/outputKinds/outputWrapperPortNames 三份状态、重复名阻断页面级保存等落成行为断言。
- **是否上升为通用机制**：只补了这一处。同型的「CSS 里有规则 + 测试断言该规则存在 + DOM 从来没挂过那个选择器」在本仓是可复现的模式（RFC-206 的四处补丁是同一病理的另一面）。真正的通用解应是「任何针对某 class 的 CSS 文本断言，必须同时断言该 class 在某个组件的渲染输出里出现」——这条没有被机制化。

### `design/RFC-073-subagent-permission-question-deadlock/proposal.md:5-24` — 线上（另一台机器）task 卡死：worker 的 opencode 子进程不退出，框架停在 await child.exited 直到 30 分钟 node-timeout 才 SIGTERM 标 failed，且监控无告警（stuck_

- **发现者**：user-report　**根因类别**：`contract-drift`
- **现象**：线上（另一台机器）task 卡死：worker 的 opencode 子进程不退出，框架停在 await child.exited 直到 30 分钟 node-timeout 才 SIGTERM 标 failed，且监控无告警（stuck_task_detector 的 S3 要求所有 node_run 都 terminal，而此时仍是 running）。
- **测试网为什么没拦住**：根因全在**外部依赖的真实行为**，本仓测试面完全触不到：opencode permission 默认裁决是 ask（permission/evaluate.ts:14）；框架注入的 agent.<name>.permission 默认 {} 且没注入全局 permission，只靠 CLI flag --dangerously-skip-permissions；而那个 flag 的应答 loop 有 if (permission.sessionID !== sessionID) continue（cli/cmd/run.ts:708）——**只应答根 session，跳过所有 subagent 子 session**，且完全没有 question.asked 分支。框架在 opencode run --format json 这条路径下 stdin:'ignore'，结构上没有反向通道。这类断言在落 RFC 前只能靠读 opencode 源码验证（CLAUDE.md 的强制自取规则正是为此），任何本仓单测都无法表达。另一层是监控盲区：detector 的 S3 规则条件恰好把这种形态排除在外。
- **当时补的防护**：改用 multica 生产验证过的手段——注入 OPENCODE_PERMISSION={"*":"allow"} 让 evaluate 阶段就放行所有 session（含任意层 subagent）、根本不发 permission.asked；并禁用 opencode 内置 question 工具。G5 明确「用测试锁住回归（注入形态 + 顺序 + clarify 仍可用）」。
- **是否上升为通用机制**：只针对 permission/question 两条。「框架对 opencode 行为的断言必须回源码验证」这条已经写进 CLAUDE.md（opencode 源码自取规则），算是文档层的通用机制，但**没有可执行守卫**——没有任何测试会在 opencode 升级后自动发现「我们依赖的那条 evaluate 默认值/那个 sessionID 过滤改了」。同类风险对每一条 OPENCODE_* 注入、退出码、stdout 协议假设都存在。

### `design/RFC-078-review-round-start-time/proposal.md:9-38` — 真实任务 01KT1HDYV6RA8EJGY5BSE20MH9：review 节点 rev_cbkatx 的「开始时间」比它最终评审的 agent run 早约 25 小时，UI 显示「时长 25 小时」；rev_5h9xpz 的某行 st

- **发现者**：user-report　**根因类别**：`ui-visual-or-layout`
- **现象**：真实任务 01KT1HDYV6RA8EJGY5BSE20MH9：review 节点 rev_cbkatx 的「开始时间」比它最终评审的 agent run 早约 25 小时，UI 显示「时长 25 小时」；rev_5h9xpz 的某行 started_at 紧跟在**兄弟节点**完成 +179ms 之后，而它评审的是另一个早 7 分钟完成的节点；因为 getTaskNodeRuns 按 started_at 排序（task.ts:1380），错锚的 review 行在时间线里还排到错误的早位置。
- **测试网为什么没拦住**：proposal 明写「调度本身没有 bug，复用同一行 review 也是有意设计，问题纯粹在展示层用错了时间锚点」。这类缺陷天然逃逸：所有后端断言（状态机、doc_version、consumed_upstream_runs_json 重指）全绿，因为数据本身正确；错的是**语义映射**——同一列 started_at 对 agent 节点是算力跨度、对 review 节点是槽位首开时刻且永不重盖（review.ts:543）。没有任何测试断言「UI 展示的时间锚点对每类 kind 语义正确」，而这也确实不是纯函数容易表达的东西。RFC-076 的完成事件驱动派发（scheduler.ts:633 Promise.race）让 started_at 盖在「谁唤醒了调度器」那一 tick，进一步把锚点随机化。
- **当时补的防护**：展示层改用「本轮评审针对的内容何时产出」（当前待审 doc_version 的产出时刻）作为锚点；时长改为明确标注的「等待人工决定时长」或不再以算力口径展示。
- **是否上升为通用机制**：只补 review 这一类节点。「同一 DB 列对不同 NodeKind 语义不同」这个模式在 finished_at（review 只在 approve 时盖、reject/iterate 不盖）上同样成立，而且 RFC-053 的 handler 表本可以承载「每个 kind 声明自己的时间语义」——但没接上去。任何新 kind（clarify、fanout 子行、workgroup host 轮）都可能重演同样的展示错锚。

### `design/RFC-058-clarify-sessions-unification/proposal.md:24-31` — RFC-056 §6 引入的 historyCutoffClarifyIteration 老化规则只 wired 到 buildClarifyPromptContext，**buildQuestionerCrossClarifyContex

- **发现者**：self-audit　**根因类别**：`duplicated-impl-drift`
- **现象**：RFC-056 §6 引入的 historyCutoffClarifyIteration 老化规则只 wired 到 buildClarifyPromptContext，**buildQuestionerCrossClarifyContext 没接 cutoff**——cross-clarify 反问者侧的 Q&A 在重跑时仍然全量注入历史，违反本应 GENERAL 的规则。scheduler.ts:1347-1371 的代码注释自己写着「this block generalises [aging] to every rerun trigger」，但代码物理上没有 GENERAL 入口。
- **测试网为什么没拦住**：self-clarify 与 cross-clarify 在 DB 表 / service / prompt 注入 / 前端 DTO 四层都是完全平行的两套（clarify_sessions vs cross_clarify_sessions、clarify.ts vs crossClarify.ts、buildClarifyPromptContext vs buildQuestionerCrossClarifyContext、ClarifySession vs CrossClarifySession）。测试也镜像成两套，self 那套绿并不能说明 cross 那套接了同一条规则。**注释声称 GENERAL、代码只覆盖一支**是最阴险的形态——读代码的人会相信注释。
- **当时补的防护**：migration 0031 硬切合表为 clarify_rounds（kind discriminator）；service 合并为单一 clarify.ts；抽出 computeHistoryCutoff / applyAgingCutoff 两个公共原语作为**所有 Q&A 注入路径的唯一 cutoff 入口**；migration test 覆盖空库/仅 self/仅 cross/混合/字段值字节级映射。
- **是否上升为通用机制**：**上升为机制**（把 GENERAL 规则做成真的只有一个函数入口），但只合到了数据 + prompt 层。RFC-064 的证据显示这不够：合表之后仍有 4 个同根 patch 发生，直到 RFC-064 把字段层（两个计数器）也合掉才止血。教训是「抽出公共原语」若不同时消灭产生分叉的那个维度，漏镜像还会继续。

### `design/RFC-156-system-agents-settings-tab/proposal.md:19-25` — 两个真实能力缺口：(1) RFC-130 引入的 merge agent 的 mergeAgentRuntime **从未获得任何 UI**，用户只能手改配置文件；(2) ConfigPatchSchema 只为 commitPushRun

- **发现者**：self-audit　**根因类别**：`wire-field-drop`
- **现象**：两个真实能力缺口：(1) RFC-130 引入的 merge agent 的 mergeAgentRuntime **从未获得任何 UI**，用户只能手改配置文件；(2) ConfigPatchSchema 只为 commitPushRuntime / memoryDistillRuntime 扩了 .nullable()，**漏了 mergeAgentRuntime**——即使补了 UI，「继承（全局默认）」发的 null 也会被 schema 拒；(3) RFC-117 D7 的 runtime-only 窄例外只做了后端，前端唯一入口 agents.detail.tsx 保存发的是整份 draft，落到 builtin 行必 403 builtin-readonly——即经 /agents 详情页编辑内置 merger 的 runtime **当前根本保存不了**。
- **测试网为什么没拦住**：典型的 wire-field-drop + 半截落地：后端 resolveInternalAgentRuntime 统一解析四个内置 agent 的 runtime，测试覆盖后端解析逻辑全绿；但「这个字段有没有到达用户」不在任何测试的断言面内。schema 的 .nullable() 漏了一个字段——测试只对已有的两个字段断言了 null 清除，没有一条「所有 *Runtime 字段必须一致地支持 null」的表驱动断言。RFC-117 D7 那条更典型：后端开了窄例外并测了，前端从没有调用方走那条路径，注释里预告的「settings picker」直到 RFC-156 才存在。
- **当时补的防护**：新增「系统 Agent」设置页签统一收纳四个内置 framework agent 的 runtime + 专属配置；补 mergeAgentRuntime 的选择器与 ConfigPatchSchema 的 .nullable()；融合卡以 runtime-only PATCH 真正打通 RFC-117 D7 的前端半截。
- **是否上升为通用机制**：只补齐当前这四个。缺的通用机制是「每个 config runtime 字段必须在某个设置页可达」的清单守卫——加第五个内置 agent 时同样会漏 UI 和 .nullable()。仓库对「后端能力有没有前端入口」这条完全没有自动化口径。

### `design/RFC-175-task-relaunch-param-prefill/proposal.md:7-17` — 用户反馈「工作组任务的再次启动需要按当前任务默认填任务参数，不能只是新建一个空任务」。工作组任务的「再次启动」深链只带 { kind:'workgroup' }——**连工作组名都没带**，落到一个几乎空白的向导。

- **发现者**：user-report　**根因类别**：`wire-field-drop`
- **现象**：用户反馈「工作组任务的再次启动需要按当前任务默认填任务参数，不能只是新建一个空任务」。工作组任务的「再次启动」深链只带 { kind:'workgroup' }——**连工作组名都没带**，落到一个几乎空白的向导。
- **测试网为什么没拦住**：根因是 DTO 形状导致的作用域省略：向导的工作组深链按名键控（/tasks/new?workgroup=<name>），而任务详情 DTO（TaskSchema）只有 workgroupId 没有 workgroupName——workgroupName 只在**列表** TaskSummarySchema 上（packages/shared/src/schemas/task.ts:275）。同步 <Link> 只能拿 tk 上的字段，没有名字可传。RFC-165 当时明确写了「v1 只预填主体」，所以这是**有意的已知缺口**而非漏测；但缺口本身没有任何可见性——没有测试或 lint 会指出「这个深链参数集是三 kind 里最贫瘠的一个」，用户撞上前谁都不会注意到工作组是孤岛。
- **当时补的防护**：新增纯函数 taskToLaunchPayload(task) 产出与 scheduled_tasks.launchPayload 同形的 payload，直接喂现成 payloadToWizardSeed；后端 TaskSchema 增 workgroupName + goal 两枚派生投影（从 workgroupConfigJson 派生，零 migration）；测试策略含 §6.1 三 kind × 五种 spaceKind 逐字段断言、§6.3 round-trip、§6.10 源码锁（tasks.detail.tsx 工作组 relaunch 不再出现裸 { kind:'workgroup' }）。
- **是否上升为通用机制**：**部分上升**：把 relaunch 与 ?editScheduled= 收敛到同一条 seed 管线（抽 applyWizardSeed），消除了「两个入口各写一套预填」的分叉。但「详情 DTO 与列表 DTO 字段集不对称」这条根因没有机制化——TaskSchema 与 TaskSummarySchema 仍是两份手写字段清单，下一个只在 Summary 上的字段还会以同样方式让某个深链变贫瘠。

### `design/RFC-057-diagnose-repair-actions/proposal.md:12-18` — 本月线上多次事故都只能开 SQL shell 救：2026-05-22 task 01KS86DPCSERV7S41GQA5Y81RN 因 dispatchReviewNode 在 interrupted review 行上尝试 park-

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：本月线上多次事故都只能开 SQL shell 救：2026-05-22 task 01KS86DPCSERV7S41GQA5Y81RN 因 dispatchReviewNode 在 interrupted review 行上尝试 park-review 抛 IllegalNodeRunTransition、runner 静默吞掉异常，task 永远卡在 running（lifecycle.stuck 扫到了 findings=3，但 UI 只给一行 JSON）；2026-05-19 task 01KS1N8WVZWE8FTR4K9WSETRNW 撞 RFC-052 bug，靠一次性脚本 scripts/fixup-rfc052-stuck-review.ts 救活。
- **测试网为什么没拦住**：这条不是「测试没拦住某个 bug」，而是**RFC-053 的诊断机制本身只读不动**——invariant 扫描与 stuck detector 能发现坏数据，却把修复留给 ad-hoc SQL。更值得注意的是第一起事故里 runner **静默吞掉** IllegalNodeRunTransition：RFC-053 建的状态机守卫正确地拒绝了非法转移，但拒绝信号被 catch 掉，于是守卫从「拦截」退化成「静默卡死」。守卫本身没有配套的「守卫触发必须可见」断言。
- **当时补的防护**：12 条诊断规则（R1/R2/C1/T1/T2/T3/U1/CR-1/S1/S2/S3/S4）各至少 1 个 typed 白名单修复选项（静态声明的 preflight + apply，无自由 SQL）、强制人工二次确认、新表 lifecycle_repair_audit 全量留痕、修复后即时复扫并推 WS 更新 banner。e2e 有 diagnose-repair.spec.ts / lifecycle-diagnose.spec.ts。
- **是否上升为通用机制**：**上升为机制**：把「每发现一种 wedge 就攒一个一次性脚本」换成 typed、可审计、可复扫的修复表，且规则集与 detector 共用同一套编号，新增规则必须配修复选项。但「守卫抛的异常被 catch 吞掉」这条元问题只在这一处被发现，没有做成通用检查（例如禁止裸 catch 吞 IllegalNodeRunTransition 的守卫）。

### `design/RFC-008-markdown-prose-premium/proposal.md:5-11` — 用户反馈「markdown 渲染的太丑了」：review 详情页的 MarkdownView 输出注入 .markdown-view 容器，而 styles.css 里**根本没有 .markdown-view 规则**，浏览器默认样式接管

- **发现者**：user-report　**根因类别**：`ui-visual-or-layout`
- **现象**：用户反馈「markdown 渲染的太丑了」：review 详情页的 MarkdownView 输出注入 .markdown-view 容器，而 styles.css 里**根本没有 .markdown-view 规则**，浏览器默认样式接管——标题字体丑、段落无间距、列表无内缩、表格/blockquote/hr 全部裸奔；同时 MarkdownEditor 用的是自家几十行的极简渲染器，不支持 GFM 表格/引用/链接/任务列表。
- **测试网为什么没拦住**：两条：(1) 视觉缺陷在 jsdom 下不可断言——「有没有 CSS 规则」这件事没有任何测试会问，渲染函数返回的 HTML 字符串正确、DOMPurify 正确、组件挂载正确，全绿；(2) 存在两套平行 markdown 管线（review 详情页一套、编辑器预览一套），各自测各自的，没有任何断言要求两者能力一致，于是「渲染只在 review 页才像样」的错位长期存在也没人发现。
- **当时补的防护**：收敛为单一 <Prose> React 组件供 review 详情页与 agent/skill 编辑器预览共用（样式自然同步）；验收标准第 6 条要求 12 条 prose-* 测试按 capability 分文件锁（仓库现存 prose-anchors-prop.test.tsx / prose-headings-anchor.test.tsx 等即此系列）。
- **是否上升为通用机制**：**部分上升**：消灭了「两套渲染管线」这个类别，是正确的方向。但视觉层本身仍无守卫——直到 RFC-206 才第一次引入真实布局引擎的几何断言。仓库对 UI 的兜底一直是 e2e/visual-regression.spec.ts 的截图基线，而按用户 memory（reference_visual_baseline_settings_default_tab）它只截默认页签，覆盖面本身就有洞。


## A2 — git 历史里的修复 / 回归 / revert 串

在 1948 个 commit 里，845 个含 fix、334 个提到「回归」、215 个提到「漏」、14 个 revert —— 修复密度极高，说明这个仓的测试网虽厚，但**逃逸是持续发生的常态**。我逐个 `git show` 了 30+ 个真·生产 bug 修复，归纳出六条主线。\n\n**1. 最高频的逃逸形态是「门在测试里从不激活」（env-gated-or-skipped）。** 冠军案例是 27479fa4：RFC-170 可用性门在真实 daemon 启动数秒即开，而单测环境从不跑 boot-verify，于是 ZIP 导入新建技能在测试里恒绿、线上 100% 失败（\"skill disappeared right after insert\"）。commit message 自陈「单测因门从不激活而全绿,线上必现」。同族的还有 d9c7c377（git≥2.38 启动门写在 design 里、纯函数写好了、生产零消费方，连带 RFC-034 submodule 能力缓存在生产恒 null）。\n\n**2. 第二大类是「同一语义 N 份实现，测试只锁了一份」（duplicated-impl-drift）。** c84ff79f 三个 SKILL.md reader 只修了一个，另两口仍能 `SKILL.md -> ~/.ssh/id_rsa` 读宿主文件；68decf45 回合号有四份推导 + 路由四处硬编码 `round: 0` + schema `.default(0)` 静默兜底；f5a6785e 校验器与渲染器两份 `{{ port }}` 正则漂移；f04c94ed 一个 `globalSem.acquire()` 站点从三个正确兄弟的队形里漂出去，直接把整个 daemon 卡死（用户原话「整个系统都卡死了，只能重启解决」）。\n\n**3. 源码文本断言确实在关键位置替代了行为验证。** 最刺眼的是 d7059d76（opencode PWD 事故）——守卫 `opencode-spawn-pwd-env.test.ts` 顶部自陈 \"This test source-greps every opencode spawn site\"，纯 grep，PWD 设成错值一样绿；它已被 RFC-111 / RFC-117 两次重构追着改锚点。c29d063c 更直接点名根因：「旧 launch 字段测试**只断言源码 spread、从不验证落到 wire**，这正是丢字段一直没被发现的根因」——三个启动字段（workingBranch / autoCommitPush / collaboratorUserIds）因此在三条路径上被静默禁用，而且是**同一个坑第二次**（RFC-125 先抓到 deferredQuestionDispatch 同款丢弃）。\n\n**4. 「A 改完 B 立刻修 A」的连续串很多，且都是 CI 而非测试设计抓到的。** bda0d4fb→2cb0e1ff（安全门打红 4 个存量夹具 + 源码扫描器 lexer 把错误文案里的散文 \" as a \" 当 TS 断言）、10544aed→0da9cc0b（读取根一改，symlink-containment 断言漂移到非读取路径 —— **安全测试还在但看错了地方**，比变红更危险）、4181a862→01808a50（多人树上回退时丢失 human 成员入协作者的合并逻辑，修复 commit 零测试，只有 engine 回归锁变红才暴露）。\n\n**5. 夹具选取遮蔽了跨模块字段语义漂移。** `tasks.repo_url` 自 RFC-054 起脱敏落库、`cached_repos.url` 明文，公有仓恰好相等 → 所有夹具用公有仓 → 私有仓的 memory repo scope 被**静默丢弃**（33fe7061）、relaunch 恒认证失败（6fb34d10）。同一根因**同一天被独立发现两次**，正说明当时补的是单点。\n\n**6. 少数修复至今无防护。** 我实测 grep 验证：6fb34d10（relaunch 改按 cachedRepoId）commit 里零测试文件；`packages/frontend/tests/task-wizard-builders.test.ts:355` 的 repo 夹具构造器签名是 `(repoUrl, baseBranch)`，**根本没有 cachedRepoId 字段**；全 `packages/frontend/tests` 里 cachedRepoId 只作为别的测试的占位 null 出现，没有一条断言 relaunch 会用它 —— `task-wizard.ts:358-362` 目前裸奔。同类无测试修复还有 6cf21dd9（关系图连线飘在节点外，纯视觉）、4df1cb56（卡片标题出框）。\n\n**反面（做得好的）值得单独记：** f04c94ed 写了**表级不变式**覆盖所有 `globalSem.acquire()` 站点而非钉死行号（并显式豁免 resolve-only 的 `*.acquire()`），68decf45 建了回合账本单一事实源 + 唯一写入闸口 + 删掉 schema default 让「忘记传」变成硬错误 + **变异测试实证**（回退旧推导即 3 红），96ddc3a3 为了让生产 QueryClient 默认值可断言而专门把它抽成 `lib/query-client.ts`，337bdef5 发现 jsdom 与 WebKit 同样不实现 click-focus 因而把 nightly-only 的 e2e 红降级成每 PR 必跑的 vitest 真锁。这四条是本仓「补防护」的正确形态样板。\n\n**跨 OS / 跨 runner 遮蔽单独提示：** 86670a9c 的进程级全局计数器污染只在 ubuntu+coverage 红（bun 本地按文件隔离模块注册表、macOS 也绿），337bdef5 只在非阻塞的 webkit nightly 红，78ef35dd 要靠 e2e rerun 才抓到。这三条说明现有 CI 矩阵里存在「唯一能发现某类 bug 的通道恰好不 gate 合并 / 本地不可复现」的结构性盲区。\n\n**revert 群像（未计入 20 条，但同属逃逸信号）：** fc266784 整体回退 RFC-061 PR-A（含 2400+ 行测试一并删除）、f52ef2e1 架构 pivot 回退 RFC-167 独立资源、7b1206ae→433f5c18 一天内 revert 又 reapply 同一文档 commit、a1dc79d2 `git add <整文件>` 把并发会话的 styles.css 改动误推上 main 导致 vitest 红（这条直接催生了 CLAUDE.md 里的多人协作规则）、64fb209b 按用户要求恢复被误删的他人 re-export。这一组指向的不是测试网缺口，而是**共享 working tree 的提交纪律缺口**。

### `27479fa4` — RFC-170 技能可用性门（gate）在真实 daemon 启动数秒后即激活；ZIP 导入的「新建技能」分支走裸 INSERT，落 schema 默认 versionState='legacy-unbackfilled'、无 v1 快照、

- **发现者**：user-report　**根因类别**：`env-gated-or-skipped`
- **现象**：RFC-170 技能可用性门（gate）在真实 daemon 启动数秒后即激活；ZIP 导入的「新建技能」分支走裸 INSERT，落 schema 默认 versionState='legacy-unbackfilled'、无 v1 快照、未 boot-verified，随后被 gated getSkill 回读隐藏 —— 生产上「新建技能插入后立刻消失」，ZIP 导入新建 100% 失败。
- **测试网为什么没拦住**：本仓最典型的一类逃逸：**门在单测里从不激活**。可用性门的激活依赖 boot-verify 后台重扫，单测环境从不跑该流程，于是 gated getSkill 在测试里恒等于裸读，ZIP create 分支的 legacy 行完全读得出来，全套 skill-zip 测试恒绿；线上 daemon 跑几秒门就开，必现。commit message 原话：「单测因门从不激活而全绿,线上必现」。另一层：ZIP create 与 POST /api/skills 是两条独立写路径（insertManagedRow/writeCandidate 直写 vs reserve→快照→ready 漏斗），只有后者有测试。
- **当时补的防护**：新增 packages/backend/tests/skill-zip-boot-gate.test.ts（334 行 / 8 例），**在门激活状态下**跑 zip create 全形态、漏斗回滚、占名冲突不碰占用者文件、husk 清理 + 端到端重导、隔离恢复与仍损坏不恢复。生产侧把 create 收编进共享原语 createManagedSkillWithFiles，删除旧直写路径。
- **是否上升为通用机制**：部分上升为机制：抽出 createManagedSkillWithFiles 让两条写路径同源，属结构性去重；backfillLegacySkillVersions 从 cli/start.ts 内联循环抽成可测服务函数也是通用化。但「门激活」本身仍是**这一个测试文件自己搭的**，没有成为全局 fixture —— 其他任何被 gate 包裹的读路径（getSkill/listSkills/skillVersion 读）如果还有裸写入口，同类问题会原样复发。

### `96ddc3a3` — TanStack Query 默认 networkMode:'online'，onlineManager 只跟随 window 的 online/offline 事件（不读 navigator.onLine）。macOS Wi-Fi 抖动 

- **发现者**：user-report　**根因类别**：`harness-cannot-express`
- **现象**：TanStack Query 默认 networkMode:'online'，onlineManager 只跟随 window 的 online/offline 事件（不读 navigator.onLine）。macOS Wi-Fi 抖动 / VPN 切换 / 睡眠唤醒抛 offline 后，所有 mutation 挂在 status:'pending' —— 不发请求、不报错、不超时。点「创建代理」永久停在「创建中…」，fieldset 冻结，Network 面板零请求；且恢复还要求 focusManager.isFocused()，后台标签页网络回来仍卡死。daemon 在 127.0.0.1，这个信号与 API 可达性毫无关系。
- **测试网为什么没拦住**：**生产 QueryClient 的默认值在测试里根本不是可断言面**：client 在 main.tsx 里内联 new 出来、一 import 就渲染到 #root，所有既有前端测试各自 new 一个 QueryClient（通常还显式关 retry），于是测的永远是测试自己的 client 配置，生产默认值零覆盖。这是 harness 表达能力问题，不是「忘了写」。
- **当时补的防护**：把 client 抽成 packages/frontend/src/lib/query-client.ts（**为了让它成为可断言面而抽**），queries+mutations 一并改 networkMode:'always'；新增 packages/frontend/tests/query-client-network-mode.test.tsx（153 行）：离线状态下驱动真实 /agents/new 路由 + 真实生产 client，断言 POST 确实发出且路由落到新代理（修复前 posted 为空数组）。
- **是否上升为通用机制**：抽出可断言的单例是通用化的正确形态——今后任何 QueryClient 全局默认（retry/staleTime/gcTime/throwOnError）都能被同一测试面覆盖。但目前只锁了 networkMode 这一条属性，没有「生产 client 的关键默认必须全部被断言」的表级不变式；换个默认项出错仍会裸奔。

### `f04c94ed` — 用户 2026-07-20 报「整个系统都卡死了，只能重启解决」。两处调用点错用：(1) workgroup host-node 的 finally 把 releaseGlobal() 排在 await discardNodeIso 之后，

- **发现者**：user-report　**根因类别**：`cross-module-seam`
- **现象**：用户 2026-07-20 报「整个系统都卡死了，只能重启解决」。两处调用点错用：(1) workgroup host-node 的 finally 把 releaseGlobal() 排在 await discardNodeIso 之后，而 discardNodeIso→runGit 全程无 timeout，git worktree remove 撞上残留 index.lock 即永久挂起 → permit 永不归还；globalSem 是 daemon 级共享（WeakMap keyed by DbClient），泄满后全 daemon 所有任务停在 acquire()，stuckTaskDetector 只写告警、autoRepair 默认关 —— 无自愈。(2) await persistIsoBase(...) 裸露在 acquire 与保护它的 try/finally 之间，而 transitionMergeState 抛异常是有文档且被 rfc144-merge-state-cas 锁定的行为。
- **测试网为什么没拦住**：两条都不是原语有 bug，而是**调用点从三个正确兄弟的队形里漂移出去了**——同一文件里另有三处写法正确。没有任何测试表达「finally 内必须先 release 再 await 清理」这条跨调用点的排序契约，单个调用点的行为测试也测不出来（要造出 git 永久挂起才会暴露）。另外全部 git 调用无 timeout 上界，属于「不可能失败」的隐含假设，从未被证伪测试。
- **当时补的防护**：packages/backend/tests/rfc208-unbounded-git-and-permits.test.ts（188 行）两层：行为层用 git -c 'alias.awhang=!sleep 30' 造确定性挂起（本地、不依赖网络、! 别名经 shell 起孙进程），断言限时返回 + pgrep 验证孙进程真被杀，并加耗时断言防修复前假通过；生产侧 runGit 加可选 timeoutMs（复用 util/opencode.ts 的 detached + 杀整个进程组模式），discardNodeIso 无条件限时 60s，7 个调用点全部受益。
- **是否上升为通用机制**：**这次真的上升为通用机制**，是全仓最好的范例之一：结构层写了两条表级不变式覆盖**所有** globalSem.acquire() 站点而非钉死行号（rfc208 test:138 'no rejectable await sits between globalSem.acquire() and its guarding try'，并显式豁免 *.acquire()，因为 Semaphore.acquire 的 promise 是 resolve-only）。缺口：不变式只覆盖 globalSem，其他信号量/锁（taskSem、flock、WeakMap 池 ref）没有同款队形检查；且这是源码 lexer 扫描，遇到跨文件抽函数就会失效。

### `6faca0ab` — 21 个路由测试给 server deps 传 configPath: ''，loadConfig('') 走「写默认配置」分支，tmp 落在 dirname('') === '.'（bun test 的 cwd 即仓库根），随后 rena

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：21 个路由测试给 server deps 传 configPath: ''，loadConfig('') 走「写默认配置」分支，tmp 落在 dirname('') === '.'（bun test 的 cwd 即仓库根），随后 renameSync(tmp, '') 抛 ENOENT，tmp 永久遗留。自 2026-05-23 起每次跑测试泄 ~40 个，累计 11,493 个文件 / 45MB 堆在仓库根目录。
- **测试网为什么没拦住**：完全没有针对空/非法 configPath 的测试——loadConfig 只有 happy path 覆盖。更微妙的是：**泄漏本身没有任何断言面**，测试跑完不检查 cwd 是否多出文件，所以 21 个测试全绿地泄了两个月。saveConfigRaw 的 rename 失败分支也从未被构造过（原子写的失败清理路径零覆盖）。
- **当时补的防护**：config/index.ts 加 assertConfigPath（空/全空白 path 在任何文件系统副作用前抛错）+ saveConfigRaw rename 失败时 best-effort unlink tmp 后再抛，并导出 saveConfigRaw 供测试锁定该路径。config.test.ts 新增 describe：loadConfig('')/applyConfigPatch('') 快速失败且 **cwd 零新增 tmp**、空白 path 同样拒绝、rename 失败（目标为目录）后 tmp 已被清理、正常保存不留 tmp。
- **是否上升为通用机制**：只补了 config 这一条。「测试跑完不得在 cwd 留下文件」这条通用不变式没有落成全局 afterAll 守卫，任何其他写临时文件的服务（skill zip、worktree、iso、session capture）都可能重演同款静默泄漏，且同样无人察觉。

### `bda0d4fb` — 7 路并行权限审计一次挖出 5 个可直接修的洞：P0 /api/worktree-files/:taskId/* 从无 canViewTask（任何登录 actor 拿 taskId 就能读他人私有任务 worktree）且 Bun.fil

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：7 路并行权限审计一次挖出 5 个可直接修的洞：P0 /api/worktree-files/:taskId/* 从无 canViewTask（任何登录 actor 拿 taskId 就能读他人私有任务 worktree）且 Bun.file 跟随 symlink 无 realpath（root daemon 下读宿主任意文件）；P0 OIDC postLoginRedirect 开放重定向（把新签发 session token 拼进无校验的外部 URL fragment）；P1 /api/repos refs|files 无路径白名单可枚举宿主任意 git 仓库；P1 retryNode 先 CAS 后校验归属（畸形/跨任务 nodeRunId 先把 done 任务 CAS 成 pending 并清完成元数据再 404）；P1 workgroup 中途 addMembers 不落 task_collaborators（加了人打不开 room）。
- **测试网为什么没拦住**：典型的 happy-path-only：这些端点都有功能测试（能读到文件、能重试节点、能加成员），但**没有一条负向 ACL 用例**——「非成员访问应 403」「跨任务 id 应先 404 再不改状态」「symlink 逃逸应拒」这类用例整体缺席。worktree-files 是后加的端点，写它时没有对齐任务面已有的 canViewTask 契约（没有任何机制强制新端点接入 ACL）。retryNode 的守卫顺序 bug 更隐蔽：happy path 下 CAS 与校验顺序无差别，只有畸形输入才暴露。
- **当时补的防护**：5 个新回归测试文件，均红→绿：worktree-files-acl.test.ts(187)、repos-path-allowlist.test.ts(94)、retry-node-guard-order.test.ts(82)、oidc-redirect-sanitize.test.ts(58)、rfc164-workgroup-room.test.ts(+49)。生产侧补 canViewTask + realpath 包含校验、startFlow 源头 sanitize（只留同源相对路径）、isKnownRepoPath 约束到 cached_repos.localPath、归属校验挪到 CAS 前、同事务 insert collaborator。
- **是否上升为通用机制**：逐洞补测，**未上升为机制**。仓里已有 API 契约总册（RFC-054 W1-2 全端点 × {coverage 守卫, 401 gate, happy schema}），但那只锁「有没有 401 门」，不锁「有没有资源级 ACL 门」。新增任何路由仍可以只过 401 就上线，worktree-files 这类「新端点漏接 canViewTask」会原样复发。cached_repos 明文凭据 URL 泄漏（P0-3）当时甚至被推迟（后由 26d7c966/RFC-204 处理）。

### `2cb0e1ff` — 上一条 bda0d4fb 推上 main 后立刻 5 红：repos.test.ts 4 红（套件临时仓库未注册进 cached_repos，全部请求被新白名单门以 repo-path-unknown 弹回）；routes-no-cast.

- **发现者**：ci　**根因类别**：`text-assertion-only`
- **现象**：上一条 bda0d4fb 推上 main 后立刻 5 红：repos.test.ts 4 红（套件临时仓库未注册进 cached_repos，全部请求被新白名单门以 repo-path-unknown 弹回）；routes-no-cast.test.ts 1 红（扫描器误报——workgroupTasks.ts 错误文案 'cannot add the system user as a member' 里的散文 " as a " 被 lexer 当成 TS 断言，因为 lexer 只剥注释不剥字符串）。
- **测试网为什么没拦住**：这是「A 改完 B 立刻修 A」的教科书串，两个失效各自代表一类：(1) **安全门与既有测试夹具的耦合没人建模**——加一道全局门必然把所有未注册夹具的存量测试打红，而这只能等 CI 跑完才知道；(2) **源码文本扫描器的 lexer 太粗**，把字符串字面量里的散文当代码，属于源码文本断言这一整类兜底测试的固有假阳性风险。
- **当时补的防护**：repos.test.ts beforeEach 把套件 temp 根注册为 mirror，四条用例继续穿过安全门锻炼端点自身行为（门的反向用例由 repos-path-allowlist.test.ts 锁定）；routes-no-cast.test.ts 的 lexer 根因修复——单/双引号字符串内容置空（纯数据，杜绝散文误报），模板字符串保留内容（${} 插值可携带真 cast，置空会致盲）。不改 bda0d4fb 任何生产行。
- **是否上升为通用机制**：lexer 修复是通用的（一次修好所有源码扫描器共用的 tokenize 逻辑，且刻意区分模板字符串以免致盲）。但夹具侧只修了 repos.test.ts 一处；没有「新增全局门时必须扫描存量夹具」的流程或工具，下一道门会重演。

### `78ef35dd` — fetch 边界把真实网络失败打标为 ApiError(status 0, 'network-unreachable') 后，useWorkflowEditorDraft.failureFromError 按 instanceof ApiE

- **发现者**：ci　**根因类别**：`mock-too-deep`
- **现象**：fetch 边界把真实网络失败打标为 ApiError(status 0, 'network-unreachable') 后，useWorkflowEditorDraft.failureFromError 按 instanceof ApiError 一律归为 kind:'http' 的确定性失败。RFC-199 弱网语义要求 status 0（请求没有得到 HTTP 结论，保存可能已落地）必须与裸 TypeError 一样走 transport 丢失 → offline + reconcile，而不是直接判「保存失败」。
- **测试网为什么没拦住**：**mock 打在了错误的层**：单测注入的是裸 TypeError，而生产链路里 fetch 边界会先把它「打标」成 ApiError(0)，真实打标形状在单测里零覆盖。commit message 原话：「此前只注入裸 TypeError，真实打标形状零覆盖，故单测未拦住」。只有 e2e（rfc199-save-reliability.spec.ts，且要 CI e2e rerun 才抓到，run 29555048439 shard 3/4）走完整链路才暴露。
- **当时补的防护**：生产侧改为 status !== 0 才归 http；use-workflow-editor-draft.test.tsx 新增「打标形状（ApiError status 0）注入 → offline+reconciling」回归锁（+32 行）。
- **是否上升为通用机制**：作者做了**全库同类判定盘查**（确认其余分类点均为 status∈[400,500) / 特定 code 判定，status 0 走 false 分支与改动前一致，无同类回归）——这是良好的横向验证，但没有落成可执行的守卫。「错误分类测试必须注入生产打标形状而非原始异常」这条没有机制强制，其他 hook 换个人写还会照旧注入裸 Error。

### `d9c7c377` — 真实环境事故：宿主 git<2.38 时**每个任务都要等 agent 跑完之后**才死在 merge-back-failed（pre-2.38 的 git merge-tree 不解析任何选项，--write-tree 直接吐老式 usa

- **发现者**：user-report　**根因类别**：`contract-drift`
- **现象**：真实环境事故：宿主 git<2.38 时**每个任务都要等 agent 跑完之后**才死在 merge-back-failed（pre-2.38 的 git merge-tree 不解析任何选项，--write-tree 直接吐老式 usage）。design.md §5.2/D7 早已拍板「低于 2.38 启动即拒」，但 supportsMergeTreeWriteTree 零生产消费方、detectGitCapabilities 启动零调用——连带 RFC-034 的 submodule 能力缓存在生产恒 null。
- **测试网为什么没拦住**：**纯函数有测、接线没有**：能力探测函数本身写好了也可能有覆盖，但从来没有一条测试断言「start.ts 会调用它并据此拒启」。design 文档写了决策、代码只落了一半，测试网只覆盖了落地那一半。doctor 的 git 门槛还停在 2.5.0，与 design 的 2.38.0 漂移，也无人比对。
- **当时补的防护**：start.ts 4b 启动探测 git + mergeTreeGateError 硬门拒启（同 opencode 门），顺带激活 RFC-034 能力缓存；doctor 门槛 2.5.0→2.38.0 且判定抽纯函数 evaluateGitCheck 供测试；detectGitCapabilities spawn 失败不再抛。回归 rfc130-git-version-gate.test.ts（115 行）：纯函数矩阵 + doctor 口径 + **start/doctor 接线源码锁** + 真 PATH git 探针。本机用假 git 2.34.1 shim 实证拒启 exit 1。
- **是否上升为通用机制**：只补了 git 这一条门。**接线部分是源码文本断言**（source-lock 断言 start.ts 里出现调用），行为层没有「启动时门确实拒绝」的进程级测试——重构挪个位置就可能既绕过门又绕过锁。更广的问题（design 决策 vs 实现的「零消费方」检测）完全没有机制；同类「函数写了没接线」在 RFC-034 submodule 能力缓存上其实已经并发存在，是这次顺带发现的。

### `33fe7061` — memoryInject 与 memoryDistillScheduler 都用 cached_repos.url == tasks.repo_url 解析记忆的 repo scope。但 tasks.repo_url 自 RFC-054 

- **发现者**：self-audit　**根因类别**：`contract-drift`
- **现象**：memoryInject 与 memoryDistillScheduler 都用 cached_repos.url == tasks.repo_url 解析记忆的 repo scope。但 tasks.repo_url 自 RFC-054 W3-4 起就是**脱敏**落库（插入走 redactGitUrl），而 cached_repos.url 是明文——对任何带凭据的私有仓这个 join 永远不成立，repo 维度的记忆被**静默丢弃**。
- **测试网为什么没拦住**：**测试夹具只用公有仓 URL**，而公有仓恰好脱敏前后相等，所以 join 成立、测试全绿。这是 happy-path-only 的一个精确变体：夹具选取的数据恰好落在两个字段相等的那个特例上，把跨模块的字段语义漂移（一列脱敏、另一列明文）完全遮住。而且这是**静默丢弃**——没有报错、没有日志，用户只会觉得「记忆好像没生效」。
- **当时补的防护**：改为按 tasks.cached_repo_id 直取。两处契约测试更新为新口径并写明原因；新增「私有仓（脱敏 repo_url）仍能解析 repo scope」回归——这条在改动前是红的；另加「无缓存镜像 → 无 repo scope」。
- **是否上升为通用机制**：只修了 memory 这两处。「凡是与 tasks.repo_url 做等值比较的地方都是错的」这条没有落成扫描守卫；同一天的 6fb34d10 就是同款漏（relaunch 也用 repo_url）——**同一根因在同一天被发现两次**，正说明当时补的是单点。RFC-204 T7 还要清空 url 列，届时公有仓也会退化成用 '' 匹配任意行，是同一根因的第三次。

### `6fb34d10` — 「重新启动此任务」对私有仓一直是坏的：task.repos[].repoUrl 自 RFC-054 W3-4 起是脱敏值，relaunch 把 https&#58;//***@host/... 当来源发出去，认证必然失败。commit messag

- **发现者**：self-audit　**根因类别**：`wire-field-drop`
- **现象**：「重新启动此任务」对私有仓一直是坏的：task.repos[].repoUrl 自 RFC-054 W3-4 起是脱敏值，relaunch 把 https&#58;//***@host/... 当来源发出去，认证必然失败。commit message 原话：「它从来就不是一个可用的 relaunch 来源」。
- **测试网为什么没拦住**：与 33fe7061 同根因（脱敏列被当明文用），同样被公有仓夹具遮蔽。我实际 grep 验证过：packages/frontend/tests/task-wizard-builders.test.ts:355 的 repo 夹具构造器签名是 `(repoUrl: string | null, baseBranch = 'main')`，**根本没有 cachedRepoId 字段**，全文件对 relaunch 来源的断言只覆盖 repoUrl 分支。
- **当时补的防护**：**这次修复没有加任何测试**——commit 只改了 packages/frontend/src/lib/task-wizard.ts（+16/-5），零测试文件。新逻辑（task-wizard.ts:358-362 优先用 cachedRepoId、无 id 回退 repoUrl）目前处于完全无防护状态。
- **是否上升为通用机制**：既没有单点防护也没有通用机制。我 grep 过 packages/frontend/tests 全量：cachedRepoId 只出现在 task-detail-tabs / batch-import-dialog / rfc152 等**别的**测试的夹具里当占位 null，没有一条断言 relaunch 会用它。这条修复只要被后续重构碰一下就会静默回退，且回退后仍然只有私有仓用户能发现。

### `0da9cc0b` — 自己的 10544aed（readSkillContent 改读版本快照 skillReadRoot）把既有的 symlink-containment 测试打红（macOS/ubuntu Test job 双红）：旧测试在 LIVE SKI

- **发现者**：ci　**根因类别**：`contract-drift`
- **现象**：自己的 10544aed（readSkillContent 改读版本快照 skillReadRoot）把既有的 symlink-containment 测试打红（macOS/ubuntu Test job 双红）：旧测试在 LIVE SKILL.md 植入逃逸 symlink 断言 readSkillContent 抛错，但读取路径已改成快照（干净），不再读 live 那份，故不抛。
- **测试网为什么没拦住**：这条不是「测试没拦住 bug」，而是「**安全测试的断言点漂移到了非读取路径**」——测试还在，但它监视的位置已经不是生产实际读的位置了，等于安全防护静默失效。这类失效比测试变红更危险：如果重构时顺手把断言改成「不抛」而不是搬到新路径，逃逸检查就永久废了。
- **当时补的防护**：把 symlink 植入到实际读取路径（versions/v1/files/SKILL.md）——realpathInside containment 仍须拒绝（防御被篡改/损坏的快照）；**并新增反向用例**：篡改 LIVE symlink 被 IGNORED（读干净快照、无泄漏、无错），锁住 G1-1 改进本身。
- **是否上升为通用机制**：只修了这一个测试文件的两条断言。没有「安全 containment 断言必须钉在生产实际读取路径上」的机制（比如让测试从生产代码导出的路径解析函数取路径，而不是自己拼路径）——下次读取根再变一次，同样会出现「测试还在但看错地方」。

### `c84ff79f` — RFC-170 设计门第 4 轮指出：G3-1 的 symlink 越界修复**只修了 readSkillFile，漏了两个同类 SKILL.md reader**——readSkillContent（GET /api/skills/:na

- **发现者**：codex-review　**根因类别**：`duplicated-impl-drift`
- **现象**：RFC-170 设计门第 4 轮指出：G3-1 的 symlink 越界修复**只修了 readSkillFile，漏了两个同类 SKILL.md reader**——readSkillContent（GET /api/skills/:name/content，skill.ts:259）与历史版本内容（GET /api/skills/:name/versions/:v/content，skillVersion.ts:423）。公开/共享 external skill 的 `SKILL.md -> ~/.ssh/id_rsa` 经这两口仍可读宿主任意文件。
- **测试网为什么没拦住**：**同一语义存在三份实现，测试只锁了其中一份**。修复 G3-1 时只给 readSkillFile 加了 realpathInside，回归测试自然也只覆盖那一个入口；另外两个 reader 各自裸 readFileSync，从未被 containment 测试触及。要发现它得主动枚举「所有 SKILL.md 的读取入口」，这是审计动作而非测试能自动做到的。
- **当时补的防护**：两处 readFileSync 前用 realpathInside 解析+containment（同 readSkillFile）；skill-file-symlink-containment.test.ts 加 readSkillContent 逃逸 symlink 拒（+11 行）。
- **是否上升为通用机制**：**只补了这一条**，且补得不完整：测试只加了 readSkillContent 一个入口，历史版本 content 那一口连测试都没加。也没有任何表级不变式说「skill 目录下的所有 readFileSync 必须先过 realpathInside」。同类问题会复发在：新增的任何 skill 文件读接口、以及结构完全对称的 workgroup/worktree-files 文件读取面（后者确实在 bda0d4fb 里被独立发现了同款 symlink 洞，佐证这是全局缺失而非单点）。

### `d7059d76` — opencode 1.14.51 上游 commit 7f2b5ee8c 把 run.ts 的 root 解析从 process.cwd() 改成 process.env.PWD ?? process.cwd()。Bun.spawn 的 c

- **发现者**：user-report　**根因类别**：`contract-drift`
- **现象**：opencode 1.14.51 上游 commit 7f2b5ee8c 把 run.ts 的 root 解析从 process.cwd() 改成 process.env.PWD ?? process.cwd()。Bun.spawn 的 cwd: 只改 child 的 process.cwd()，PWD 沿用 daemon 启动 shell 的目录。两者不一致时 opencode 加载 TWO Instances、session 落到 PWD 那一个、SSE 订阅拿不到事件 —— daemon stdout 收到 0 条 JSON、每个 run「exit 0 + no envelope」失败、SessionTab 全白，而 session 其实完整跑完并落进了 ~/.local/share/opencode/opencode.db。
- **测试网为什么没拦住**：**外部依赖的行为契约变更，本地测试面完全够不着**：这是被驱动的 CLI 的内部 root 解析逻辑，没有任何单测能在不真起 opencode 进程的前提下发现。而且失败形态极具迷惑性——exit code 0、agent 实际跑完、只是事件流走丢，看起来像「envelope 格式问题」。
- **当时补的防护**：runner.ts + memoryDistiller.ts 两处 Bun.spawn 显式设 PWD: cwd；MAX_OPENCODE_VERSION_EXCLUSIVE 1.14.0→1.16.0；新增 tests/opencode-spawn-pwd-env.test.ts（78 行）。
- **是否上升为通用机制**：守卫本身**是纯源码文本断言**（文件顶部注释自陈：'This test source-greps every opencode spawn site to lock the contract'），它 grep 每个 spawn 站点必须含 `PWD: <cwd-expr>`。行为层零覆盖：如果 PWD 被设成了错的值、或 opencode 又改一次解析规则，这个锁一样绿。它已经被重构追着改过两次（注释里记着 RFC-111 PR-A 把 env 块挪进 runtime/opencode/spawn.ts、RFC-117 memoryDistiller 改走 driver），每次重构都得手工更新锚点——正是 text-assertion-only 的脆弱性写照。真正的通用机制（起真 opencode 子进程验证事件流）到 RFC-186 的 5c54abc7 才出现，且只覆盖 workgroup。

### `c29d063c` — buildLaunchBody / buildLaunchBodyMultiRepo 按显式白名单重建 POST /api/tasks 请求体，丢掉 workingBranch / autoCommitPush / collaborator

- **发现者**：codex-review　**根因类别**：`text-assertion-only`
- **现象**：buildLaunchBody / buildLaunchBodyMultiRepo 按显式白名单重建 POST /api/tasks 请求体，丢掉 workingBranch / autoCommitPush / collaboratorUserIds 三个 launchCommon 字段 → RFC-075（working branch + 完成后自动提交推送）和 RFC-036（协作者）在「单仓无上传 + 多仓 + url+上传(V2)」三条启动路径上被**静默禁用**；只有 path+uploads 路径因 buildLaunchFormData verbatim spread 幸免。
- **测试网为什么没拦住**：commit message 直接点名根因：「旧 launch 字段测试**只断言源码 spread、从不验证落到 wire**，这正是丢字段一直没被发现的根因」。也就是说这些字段有测试，但测的是「源文件里出现了 ...launchCommon 这个写法」，而不是「HTTP body 里真有这个 key」。helper 内部的白名单重建把 spread 结果又过滤了一遍，源码断言完全看不见。
- **当时补的防护**：LaunchCommonPayload 声明三个可选字段；抽 stampLaunchExtras(out, common)（同时覆盖 RFC-125 的 deferredQuestionDispatch），在 path / url / multi-repo 三个 helper 分支统一调用；新增 launch-body-field-propagation.test.ts（67 行）**wire 级**回归锁。
- **是否上升为通用机制**：抽 stampLaunchExtras 是真正的通用化（三分支单一盖章点），wire 级断言也是正确的测试面升级。但仍是「加一个字段就要记得改 stampLaunchExtras」的约定，没有断言「launchCommon 的每个 key 都必须出现在 wire 上」的**穷举**不变式。事实上这个坑先被 RFC-125 Codex impl-gate 抓到（deferredQuestionDispatch 同款丢弃）、又在这里重演一次，说明单点修复没止住。

### `337bdef5` — 未保存守卫弹窗点「留下」后焦点落到 <body>：WebKit 点 <a>/<button> 不给焦点、还把原焦点 blur 掉，activeElement 直接变 <body>；UnsavedChangesGuard 的 Dialog 开

- **发现者**：ci　**根因类别**：`ui-visual-or-layout`
- **现象**：未保存守卫弹窗点「留下」后焦点落到 <body>：WebKit 点 <a>/<button> 不给焦点、还把原焦点 blur 掉，activeElement 直接变 <body>；UnsavedChangesGuard 的 Dialog 开时把 <body> 当「前一个焦点」捕获，关闭时 body.focus() 是 no-op —— 键盘用户被扔回文档顶部。是真 a11y bug，不是测试问题。
- **测试网为什么没拦住**：抓到它的是 **e2e-webkit-nightly**（v0.15.0 发布 commit 5e07cf62 的 macOS shard 3/4，原跑+retry 连挂两次），而 webkit nightly **不 gate 合并**、只在夜间跑；ubuntu webkit 同分片绿、chromium 全绿。也就是说这个 bug 只有一条非阻塞的、跨 OS 表现不一致的通道能发现。更刺眼的是 Dialog.tsx:35-45 的注释**早就预言了这个坑**（"Safari/WebKit doesn't focus <button> on mouse click ... close-time focus restoration becomes a no-op"），同文件 recoverCompactDetailFocus 的 resize 路径已有 `active === document.body` 的 WebKit 兼容判断——只是 back 这条点击路径没按该契约接线。契约写在注释里而不是测试里，等于没写。
- **当时补的防护**：ResourceSplitPage.tsx 里导航发起方在 TanStack Link 自身 router click 之前同步 focus 自己（沿用 AppShell.tsx:86 prepareMobileNavigation 的 focusStableTrigger 同款模式）；resource-split-page.test.tsx +25 行。**关键洞察**：jsdom 与 WebKit 同样不实现 click-focus，所以 vitest 就是真锁（每次 PR 都跑），不必依赖只在 nightly 跑的 e2e。已验红绿：抽掉 focus 调用后新用例单红。
- **是否上升为通用机制**：只修了 back 这一条点击路径。commit 自己承认**已知同类残留未动**：卡片 <Link> 无 onClick，同一机制下点卡片触发守卫再「留下」，webkit 同样丢焦点，且「无用例覆盖」。没有把「所有触发路由守卫的导航发起方都必须 focusStableTrigger」变成不变式。

### `86670a9c` — CI ubuntu（--coverage）连红三次（b153f40b / 395618af / 6a3e6d55）：rfc108-recovery-events 断言 recoveryCountersSnapshot()['auto-res

- **发现者**：ci　**根因类别**：`shared-tree-process`
- **现象**：CI ubuntu（--coverage）连红三次（b153f40b / 395618af / 6a3e6d55）：rfc108-recovery-events 断言 recoveryCountersSnapshot()['auto-resume'] 应为 1，实收 2。
- **测试网为什么没拦住**：recoveryCountersSnapshot() 是**进程级全局**，而四个套件会驱动真实 auto-resume（rfc108-auto-resume〔已 reset〕/ rfc167-dw-e2e / rfc186-workgroup-e2e / rfc187-clarify-continuation-revival），其中三个跑完不复位。rfc108 那条断言只有 afterEach 没有 beforeEach，于是「精确计数」实际**依赖测试文件顺序**——新增一个测试文件改变顺序就踩响这颗既存地雷。而且**本地复现不出来**：bun 本地按文件隔离模块注册表，CI 的 ubuntu+coverage 跑法共享注册表，前一个文件泄漏的计数会被后一个看见；macOS 侧同样绿。这是「本地绿 / 单 OS 绿 / 只有特定 runner 配置红」的三重遮蔽。
- **当时补的防护**：① 根治：rfc108-recovery-events 两个 describe 补 beforeEach(reset)，计数从此表示「本条测试自己做了什么」，与之前跑过什么无关，对未来任何新增 auto-resume 套件免疫；② 自律：作者自己的两个套件补 afterEach reset。
- **是否上升为通用机制**：①确实是通用化（把顺序依赖从断言里去掉，而不是给新套件打补丁）。但只针对 recoveryCounters 这一个全局；仓里其他进程级可变全局（模块注册表、WeakMap 池、activeTasks、semaphore snapshot）没有同款体检，而且**没有任何机制在本地复现 CI 的共享注册表跑法**——下一个进程级全局照样会以「只在 ubuntu+coverage 红」的形态逃出去。作者也明确没碰非本人文件的 rfc167-dw-e2e / rfc165-agent-launch（多人树纪律使然），残渣仍在。

### `68decf45` — 用户实报「自由讨论里第 x 回合的轮次总是跳，并且中间一直穿插第 0 回合」。三缺陷叠加 + 一个前端放大器：(1) fc 的「回合号」其实是 max_rounds 预算计数器（成员 run 累计行数），3 人并发就 +3，所以 0→3→5

- **发现者**：user-report　**根因类别**：`duplicated-impl-drift`
- **现象**：用户实报「自由讨论里第 x 回合的轮次总是跳，并且中间一直穿插第 0 回合」。三缺陷叠加 + 一个前端放大器：(1) fc 的「回合号」其实是 max_rounds 预算计数器（成员 run 累计行数），3 人并发就 +3，所以 0→3→5→8 地跳；(2) 并发轮攥着过期快照写库，fc 首轮全员规划产出永远写 round 0；(3) 路由**四处硬编码 round: 0**，且 schema 有 .default(0)，省略也静默写 0；(4) 前端只要 round 变化就画分隔线，包括回退。
- **测试网为什么没拦住**：回合号没有**单一事实源**：引擎推导一套、消息写入一套、房间聚合一套、路由再硬编码一套，四份实现各自都有测试、各自都绿，但它们对「回合」的语义根本不一致。schema 的 .default(0) 让「忘记传 round」在类型层和测试层都毫无痕迹（省略即静默写 0）。而且症状是并发下的累积漂移，单条用例（单成员、串行）永远看不出来。
- **当时补的防护**：新增 services/workgroupRounds.ts 作为回合账本**单一事实源**（引擎/消息写入/房间聚合三方共用，顺带在派生层排除已被取代的被杀反问续跑行）；新增 services/workgroupMessages.ts 的 buildRoomMessageRow 作为**唯一写入闸口**，round 必填无默认，postMessage 的 round 改可选（省略即写入时刻账本读数）；leaderRoundOf 退役，改读权威列 node_runs.wg_round；前端分隔线判据由「变化」改单调水位线。新测试 35 例，含新旧口径互 oracle、lw+fc 双 rider 红→绿、**变异测试实证**（回到旧推导即 3 红）。
- **是否上升为通用机制**：**上升为通用机制**，是本仓质量最高的一次收口：单一事实源 + 唯一写入闸口 + 去掉 schema default（让「忘记传」变成编译期/校验期错误而非静默 0）+ 变异测试证明守卫真有牙。残余风险：闸口是约定而非强制，仍可绕过 buildRoomMessageRow 直接 insert（没有表级扫描守卫禁止裸 insert wg_messages），同类「散射写点」问题在其他状态列（merge_state 曾有裸直写、由 RFC-144 收口）上反复出现，说明这是全仓的结构性倾向。

### `9874fffd` — 用户要求实际启动工作组任务验证 fan-out，三次真实任务迭代（生产 daemon + opencode/glm-5.2）暴露两个普适弱模型协议缺陷：① member 照抄 roster 展示格式写 "@writer"（roster 块渲

- **发现者**：user-report　**根因类别**：`happy-path-only`
- **现象**：用户要求实际启动工作组任务验证 fan-out，三次真实任务迭代（生产 daemon + opencode/glm-5.2）暴露两个普适弱模型协议缺陷：① member 照抄 roster 展示格式写 "@writer"（roster 块渲染为 `- @writer`）→ unknown-member 整 port 拒、白烧协议重试；② 模型自创 <wg_output><wg_assignments> 标签结构 → envelope-missing **一击杀任务**（信封缺失不走协议重试，与端口内容错误的重试通道不对称）。
- **测试网为什么没拦住**：**测试夹具喂的都是格式完美的模型输出**，从来没有「模型照抄展示格式」「模型自创标签」这类真实弱模型行为的样本。更结构性的是第②点：重试通道的**不对称性**（端口内容错误可重试、信封缺失不可重试）没有任何测试表达——要发现它必须有一条端到端跑真模型的链路，而当时没有。这是 mock 层选得太干净的典型：所有协议解析测试都在解析「我们自己写的正确样例」。
- **当时补的防护**：WgMemberRefSchema 管道剥 @ 前缀（roster 与 fan-out-dup 校验均在裸名上）+ 协议 bare-name 提示；ENVELOPE_RULES 加字面信封形状示例（反例点名 <wg_output>）；WorkgroupHostRunResult 透传结构化 failureCode（RFC-145 ratchet——绝不按 errorMessage 文本路由），leader/assignment 两个 turn driver 对 envelope-missing 走 malformed-retry 通道。rfc185-leader-fanout.test.ts +108 行：@ 宽容三态、信封示例三角色文案锁、envelope-missing 两级重试集成（红→绿）。
- **是否上升为通用机制**：部分通用：failureCode 结构化透传是全局 ratchet（禁止按 errorMessage 文本路由），@ 剥前缀落在 schema 管道上因而对所有成员引用生效。但「模型输出畸形形态」的样本库仍是逐案添加——下一种弱模型花样（比如 XML 属性、markdown 包裹信封）照样得靠线上烧一次才知道。真实子进程 e2e 直到 5c54abc7（RFC-186 PR-1）才建立，且只锁首条 leader→worker→done 链。

### `15c3b088` — 用户 2026-07-15 线上事故：loop wrapper 内的 writer→review 链路，review 拿到的 doc_version body 是**占位符而非真实文件内容**，导致死锁。根因是 scopeRoot 语义缺失

- **发现者**：user-report　**根因类别**：`cross-module-seam`
- **现象**：用户 2026-07-15 线上事故：loop wrapper 内的 writer→review 链路，review 拿到的 doc_version body 是**占位符而非真实文件内容**，导致死锁。根因是 scopeRoot 语义缺失——顶层任务用 task worktree，而 git/loop 的 innerState 应该用 wrapperIso.containerPath，review 的产物读取没有按 wrapper run 谱系推导根路径。
- **测试网为什么没拦住**：**跨模块缝**：review 派发、wrapper 隔离、端口产物归档三个模块各自有测试，但「wrapper 内部的 review 节点该从哪个根读产物」这个组合从未被构造过。13 个既有 review 测试全部跑在顶层 scope 下（task.worktreePath 恰好正确），wrapper 嵌套的 review 是空白象限。
- **当时补的防护**：SchedulerState.scopeRoot 显式建模（顶层=task worktree；git/loop innerState=wrapperIso.containerPath）；dispatchReviewNode 改走 readPortArtifact（归档优先、scopeRoot 仅存量回退、占位兜底）；**task 参数从 review 路径彻底删除、task.worktreePath 在 review.ts 清零并加 AC-7 源码锁**；新增 rfc193-wrapper-review.test.ts（253 行）主回归：loop 内 writer→review 单/多文档 doc_version body = 真实文件内容（即用户事故场景，修复前占位死锁）；13 个既有 review 测试适配 scopeRoot 后 74/74 绿。
- **是否上升为通用机制**：较好地通用化：删掉 task 参数并加源码锁，让「review 不得再摸 task.worktreePath」成为结构性禁令而非约定（这比只修读取逻辑强）。但该禁令的执行者仍是**源码文本断言**（AC-7 source lock），且 scopeRoot 的正确推导只在 review 一条路径上被验证——其他在 wrapper 内运行的节点类型（clarify、fan-out 聚合、commit-push）是否都拿到正确 scopeRoot，没有对称测试。

### `f5a6785e` — 三个 live bug 一并修：① P0 buildOptionalDualProtocolBlock 把**字面** FORMAT_PLACEHOLDER / RULES_PLACEHOLDER 当内容输出（本该插值 CLARIFY_FO

- **发现者**：user-report　**根因类别**：`duplicated-impl-drift`
- **现象**：三个 live bug 一并修：① P0 buildOptionalDualProtocolBlock 把**字面** FORMAT_PLACEHOLDER / RULES_PLACEHOLDER 当内容输出（本该插值 CLARIFY_FORMAT_EXAMPLE / CLARIFY_STRUCTURAL_RULES）→ optional 反问节点首轮拿不到 clarify 格式 → clarify-questions-malformed → 烧完重试预算 fail；② {{ port }} 带空格的 ref 过了校验却渲染成字面占位符（渲染器 shared/prompt.ts + 前端 promptRefs.tsx 正则与校验器不一致）；③ workgroup message-turn 指令中英夹杂 'start任务 work'。
- **测试网为什么没拦住**：①属于「测试断言的是结构不是内容」：协议块拼装有测试，但只验证块存在/顺序，没有 golden 快照能看出块里躺着字面 'FORMAT_PLACEHOLDER' 字符串。②是**校验器与渲染器两份正则漂移**——校验器容忍 `{{ port }}` 的空格、渲染器不容忍，两边各有测试各自绿，没有任何测试用同一份输入同时喂两边（这正是 duplicated-impl-drift 的定义）。③中英夹杂纯粹没有断言面。
- **当时补的防护**：三处生产修复 + 逐条补断言：protocol.test.ts(+18)、rfc165-optional-clarify.test.ts(+18)、canvas-missing-refs.test.ts(+13)，以及**新增源码守卫** workgroup-message-turn-ascii-directive.test.ts(30 行) 锁 message-turn 指令必须纯 ASCII。同时落档 RFC-200（prompt 注入边界完整档：输入围栏 + 锚点消毒 + 信封 per-run nonce）。
- **是否上升为通用机制**：基本是**单点补丁**：三个 bug 三处断言，没有「所有协议块必须过 golden 快照矩阵」的机制（虽然仓里 60ab9182 曾为 prompt 建过 golden 矩阵 + 零生产者防回潮，说明机制存在但 optional 分支没纳入），也没有「校验器与渲染器共用同一份 ref 正则」的单一事实源收口——两份正则仍分居 shared/prompt.ts 与 promptRefs.tsx，下次再改一边还会漂移。ASCII 守卫是源码文本断言，只覆盖 message-turn 一个字符串。


## A3 — 既有 8 份审计报告的未闭环项

对六份既有审计逐份核对代码现状后的结论：**这个仓的审计闭环率异常高，绝大多数被写下来的缺陷真的被执行掉了**——RFC-054 三波 20 个 PR 的交付物全部在仓（e2e/visual-regression、integration-opencode.yml、security-fuzz、upgrade-rolling、api-contract、dependency-cruiser、tests/perf 全部存在，chaos 也在 CI 里以 RUN_CHAOS=1 真跑，ci.yml:146）；scheduler-audit 28 条确认问题除自陈 deferred 项外由 RFC-092~098 根治；flag-audit 六大 P0 中 merge_state（RFC-144）、failure_code（RFC-145）、runtime driver（RFC-143）、系统通道端口（shared/systemChannelPorts.ts）、Segmented/TabBar 原语、W0 死旗标批次都已落地；2026-07-16 UX 审计的 P0 与 18 条 P1 里，F-0/F-1/F-5/F-6/F-7/F-8/F-10/F-11/F-12/F-13/F-14/F-15/F-16/F-17/F-18 经逐条查证均已修复（RFC-202/203/206/208 等）。因此**真正的逃逸是少而集中的 12 条**，且高度同型：①报告自己标注为 deferred、收官时被列为例外的项（S-18 fanout 部分容忍、gap5 节点侧锚点行）——它们的"防护"是 characterization 测试（锁住缺陷、附 FLIP 指引），行为层等于未防护；②dedup-audit §3「已经咬人的 9 项漂移」里仍有 5 项在原地（prior-done-generation scope 三份、cross-clarify 截断警告丢弃、redactPushError 窄脱敏、resume deps 漏 subagentLiveCapture、IDB 双 version），它们的共同形态是"公共原语已存在但被绕过"，而唯一防护往往是源码文本断言（subagent-live-capture-source.test.ts 自述"don't exercise behavior"）；③被后续 RFC 明确写进"非目标"、指向一个从未立项的后续 RFC 的项（R2 mutation 静默 → "留 RFC-B"，plan.md 里 RFC-B 只在那一行非目标中出现过）；④注释充当契约载体而实现早已漂移（sumTaskTokens 的 fan-out 镜像、allowTerminal 的 fixup-only）——这类今天不出错，但下一个照注释改代码的人会立刻引爆。最便宜的补救按性价比排序：把 4 处手搓 resume deps 收成 resumeTaskBestEffort、redactPushError 改成 redactSensitiveString 薄包装、给 allowTerminal 加 ratchet 计数守卫、把 WS `?since` 重放接上归档 JSONL 回退——全是几十行的机械改动，却各自堵住一类静默失败。

### `design/scheduler-audit-2026-06-10.md §S-18/S-21（收官段明列 deferred）` — 审计已识别的缺陷：wrapper-fanout 任一 shard 失败即整个 wrapper failed（scheduler.ts:4635-4642 `failedShards.length > 0`），跳过聚合与 outlet 写入；

- **发现者**：self-audit　**根因类别**：`contract-drift`
- **现象**：审计已识别的缺陷：wrapper-fanout 任一 shard 失败即整个 wrapper failed（scheduler.ts:4635-4642 `failedShards.length > 0`），跳过聚合与 outlet 写入；RFC-060 设计承诺的「只聚合 done shard + 全失败才 failed + 自动 errors 端口」至今未实现。50 shard 里 49 成功 1 超时 ⇒ 全部成功结果对下游不可见；按 design.md 接 errors 端口搭图的用户会发现该端口不存在。
- **测试网为什么没拦住**：报告原文：「无任何『部分 shard 失败』测试」，且既有 fanout 测试只跑全成功路径，fail-all 语义从未被任何断言表达过——设计文档与实现的分歧没有任何一层可执行检查去发现。
- **当时补的防护**：补了 characterization 测试 packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts（锁现状 fail-all，文件头带 FLIP 指引），并在 design/design.md:778-787 显式写下「v1 部分容忍 + errors port 为 deferred」。
- **是否上升为通用机制**：只做了单点「锁现状 + 文档降级」，没有上升为机制：design.md 内部仍自相矛盾——:681 讲 errors port 编辑器如何标灰、:765 讲空 errors port 也 ready、:1271 仍写「即便部分 shard failed 父节点也转 done」，与 :785-787 的 deferred 声明并存，没有任何测试或 lint 检查文档-实现一致性。grep 过：`failedShards`（src 命中 4，全在 scheduler.ts 同一分支）、`errors port`/`errorsPort`/`FANOUT_ERRORS_PORT`（shared/backend 生产码 0 命中）、tests 目录 `partial toleran`/`部分容忍`（0 命中，只有 s18 那一份现状锁）。同类问题会复发在任何「设计承诺 → v1 降级」的位置（design.md §6.5 pre_diff 也曾同型）。

### `design/scheduler-audit-2026-06-10.md §⑥ 缺口5（后半）` — 审计已识别的缺陷：`reapOrphanRuns` 的 node_runs 查询是全库 `status IN ('running','pending')`（services/orphans.ts:44-50），不 join 任务状态。合法暂

- **发现者**：self-audit　**根因类别**：`contract-drift`
- **现象**：审计已识别的缺陷：`reapOrphanRuns` 的 node_runs 查询是全库 `status IN ('running','pending')`（services/orphans.ts:44-50），不 join 任务状态。合法暂停中的任务（awaiting_human / awaiting_review）名下的 pending 锚点行——正是用户答完 clarify/review 后调度器要复用的幂等派发锚点——会在 daemon 重启时被翻成 interrupted。
- **测试网为什么没拦住**：报告根因：shared/node-kind-behavior.ts 自述的 leave-alone 保证「只靠查询只选 running/pending」隐式成立——该保证按【行状态】成立、按【任务状态】不成立，没有任何测试从任务状态维度进入过这个查询。
- **当时补的防护**：packages/backend/tests/scheduler-audit-gap5-orphan-reap-task-status.test.ts:110 —— 明确标注为 CURRENT-BEHAVIOR LOCK：断言 awaiting_human 任务的 pending 锚点行**被**收割成 interrupted，并在断言旁写好 FLIP 指引（修好后应保持 pending、ReapResult.runs 归零）。同文件另一半锁住 RFC-097 已修的任务侧不对称。
- **是否上升为通用机制**：半闭环：任务侧（gap5 前半）已由 RFC-097 真修（orphans.ts:38-50 注释 + rfc097-pending-orphan-reap.test.ts），节点侧至今是「锁住缺陷」而非防护，且被标注为与 S-1 修法强耦合、留待 WP-1/WP-2——而 WP-1/WP-2 已于 2026-06-12 宣布收官，这一半没人回来收。grep 过：`reapOrphanRuns`（tests 8 文件）、`awaiting_human` + orphans（仅 gap5 那一份）、`ReapResult`、`leave-alone`。同类复发点：任何「全库按行状态扫描」的后台任务（gc/limits/stuckTaskDetector）都可能踩到「行状态合法但任务状态语境非法」。

### `design/scheduler-audit-2026-06-10.md §⑥-2（限额 token 统计注释失真）` — 审计已识别的缺陷：services/limits.ts:101-110 `sumTaskTokens` 的注释声称「Only count parent runs（fan-out 子行的 tok_total 已由 runFanOutNode 

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：审计已识别的缺陷：services/limits.ts:101-110 `sumTaskTokens` 的注释声称「Only count parent runs（fan-out 子行的 tok_total 已由 runFanOutNode 聚合镜像进 parent，P-4-05）」，但 (a) 全仓 `tokTotal` 唯一写点仍是 runner.ts，scheduler.ts 内 0 命中，镜像根本不存在；(b) 查询 where 只有 `eq(nodeRuns.taskId, taskId)`，没有任何 parent-null 过滤，实际是全行求和。今天恰好因为「没有镜像」而结果正确，任何人照注释补上镜像即刻 token 双计、任务被提前误杀。
- **测试网为什么没拦住**：报告根因归为 R7「知识载体腐化：注释失真」——注释是唯一的契约载体，而 limits.test.ts:100-126 的 token 用例只造两条顶层 node_run（60+80>100），既没有 fan-out 子行、也没有 parent-null 维度，无法区分「按父行计」与「按全部行计」两种实现。
- **当时补的防护**：无。审计把它列在「完整性批评补查点」里（未经对抗核实一档），收官段也没把它列进已根治项。
- **是否上升为通用机制**：完全未闭环：注释仍在原地（limits.ts:102-103），没有任何测试把「fan-out 子行只被计一次」表达成断言。grep 过：`sumTaskTokens`（src 1 定义 1 调用、tests 0 直接命中）、`maxTotalTokens`（tests 命中 limits.test.ts 等，全是顶层行）、`task-token-limit-exceeded`、`tokTotal:`（src 仅 runner/task/schema 三处）。修法应是「先补一条带 parent/child 行的红测把真实语义钉死，再删或改注释」，而不是照注释补镜像。

### `design/scheduler-audit-2026-06-10.md §⑥-7（WS 重连补齐 vs 事件归档）` — 审计已识别的缺陷：`/ws/tasks/{id}?since=N` 的断线重放只查 DB 行（packages/backend/src/ws/registry.ts:287-304，`node_run_events` join nodeRu

- **发现者**：self-audit　**根因类别**：`cross-module-seam`
- **现象**：审计已识别的缺陷：`/ws/tasks/{id}?since=N` 的断线重放只查 DB 行（packages/backend/src/ws/registry.ts:287-304，`node_run_events` join nodeRuns），而 eventsArchive 每小时把最旧事件写成 JSONL 并 `db.delete(nodeRunEvents)`（services/eventsArchive.ts:124/150）。长任务（>1h、大输出）断线重连后 since 重放必然断档，hello 帧只回显 since、不声明截断，前端静默缺事件。
- **测试网为什么没拦住**：报告根因：「归档与重放的契约应补查」——两条读同一游标的路径分属两个模块，REST 侧 `getNodeRunEvents` 有 JSONL 回退（events-archive.test.ts:155/169/183 三条用例锁住），WS 侧从未与归档一起测过。ws.test.ts:299 的 `?since=N` 用例只在未归档的新鲜数据上跑，属最顺的那条路径。
- **当时补的防护**：无（审计把它列在完整性批评补查点，收官段未提）。
- **是否上升为通用机制**：未闭环，且缝还在扩大：同一语义（read events after cursor）现在有两份实现，只有一份接了归档回退。grep 过：`readArchivedEvents`（src 命中 eventsArchive.ts + getNodeRunEvents，ws/registry.ts **0 命中**）、`replayTaskEvents`（tests 4 文件，全无归档场景）、`archiveEvents`（tests 仅 events-archive.test.ts）、`since`（ws.test.ts:299 单条）。正解是把「游标读事件」收敛成一个函数供 REST/WS 共用，或至少在 hello 帧里声明 truncated。

### `design/dedup-audit-2026-06-13.md §3.1 prior-done-generation-node-run-order（high，附录 A #1）` — 审计已识别的缺陷：「已完成 clarify generation 的计数/排序」三处副本用不同 scope-key，至今未收敛。后端 `priorDoneGenerationsForRun`（services/scheduler.ts:68

- **发现者**：self-audit　**根因类别**：`duplicated-impl-drift`
- **现象**：审计已识别的缺陷：「已完成 clarify generation 的计数/排序」三处副本用不同 scope-key，至今未收敛。后端 `priorDoneGenerationsForRun`（services/scheduler.ts:6834-6855）按 (taskId,nodeId,iteration,shardKey) + parent-null + done，**不含 reviewIteration**；前端 `clarifyRoundForRun`（lib/node-history.ts:62-75）与 `findFirstAttemptSibling`（lib/injected-memories-card.ts:106-107）都**含** reviewIteration。对 review 迭代过的节点，UI 显示的轮次与调度器的 clarifyGeneration/session 复用锚点会算出不同的数。
- **测试网为什么没拦住**：报告根因：三处注释都自称「mirror priorDoneGenerationsForRun」，靠注释而非共享代码维持一致；每侧都有自己的测试且都通过，没有任何测试跨越前后端这道缝去比对同一输入的结果。
- **当时补的防护**：无共享落点。审计建议的 `packages/shared/src/nodeRunOrder.ts` 至今不存在（ls 确认无此文件）。
- **是否上升为通用机制**：未闭环，只有各写各的单侧测试：前端 node-history-split.test.ts / session-attempts-picker.test.tsx，后端 rerun-prior-output-*.test.ts；两侧断言互不引用。grep 过：`priorDoneGenerationsForRun`、`clarifyRoundForRun`（前端 4 处消费）、`nodeRunOrder`（0 命中）、`reviewIteration` + shardKey 组合。修法必须先定 canonical scope（reviewIteration 进不进）再下沉 shared 纯函数，否则每加一个语境维度（RFC-172 shardKey、RFC-189 wgRound…）都会再分叉一次。

### `design/dedup-audit-2026-06-13.md §3.2 clarify-rounds-dual-write` — 审计已识别的缺陷：cross-clarify 写 clarify_rounds 时硬编码 `truncationWarningsJson: null`（services/crossClarify.ts:245），紧接着 :253-258 把

- **发现者**：self-audit　**根因类别**：`wire-field-drop`
- **现象**：审计已识别的缺陷：cross-clarify 写 clarify_rounds 时硬编码 `truncationWarningsJson: null`（services/crossClarify.ts:245），紧接着 :253-258 把真实的截断警告只 `log.warn` 后丢弃；self 路径（services/clarify.ts:183/197/224）则完整落库。前端 routes/clarify.detail.tsx 会渲染 truncationWarnings ⇒ cross 通道的「问题/选项被截断」提示对用户永久不可见。
- **测试网为什么没拦住**：报告根因：self/cross 各写一份 insert/update，没有共享 mapper；一致性只由人肉对照维持。现有 cross-clarify-dual-write-consistency.test.ts:185 甚至把「cross 表没有 truncation_warnings_json 列」写成注释当作既定事实，等于把丢弃行为记录成预期。
- **当时补的防护**：无——两侧一致性测试（clarify-dual-write-consistency.test.ts:141 有 truncationWarningsJson 字段对，cross 版没有）恰好绕开了这个字段。
- **是否上升为通用机制**：未闭环，也没有上升为机制：审计建议的 `services/clarifyRounds.ts` insertClarifyRound/updateClarifyRoundAnswered mapper 未落地，字段丢弃仍靠调用点自觉。grep 过：`truncationWarningsJson`（src 命中 clarify.ts/crossClarify.ts/clarifyRounds.ts/schema.ts）、`truncationWarnings`（tests 命中 clarify 侧 3 文件，cross 侧 0）、`options-capped`。同类复发点：任何「self/cross 双写同一张表」的新字段（answeredBy、directive…）。

### `design/dedup-audit-2026-06-13.md §3.3 git-url-credential-redaction` — 审计已识别的缺陷：`redactPushError`（services/commitPush.ts:307-313）只用一条正则脱掉 `scheme://user:token@host`，漏 `Authorization: Bearer …

- **发现者**：self-audit　**根因类别**：`duplicated-impl-drift`
- **现象**：审计已识别的缺陷：`redactPushError`（services/commitPush.ts:307-313）只用一条正则脱掉 `scheme://user:token@host`，漏 `Authorization: Bearer …` / `token=` / `password=` 等形状；而 util/redact.ts:44-66 的 `redactSensitiveString` 是它的严格超集（HEADER_BEARER_RE + SENSITIVE_KV_RE + URI_USERINFO_RE）。git push stderr 真实会回显这些 ⇒ 凭据落进 task.pushError 并透到前端。
- **测试网为什么没拦住**：两份脱敏实现各自有测试，窄的那份只测自己覆盖的那一种形状：packages/backend/tests/commit-push-core.test.ts:260-272 只有「strips url credentials」+「caps length」两条，没有任何 Bearer/token=/password= 负例。测试跟着实现走，实现漏什么测试就漏什么。
- **当时补的防护**：无（既没有把 redactPushError 改成 redactSensitiveString 的薄包装，也没有给它补形状矩阵）。
- **是否上升为通用机制**：未闭环，且仓内其他出口都已经收敛到超集（repoCredentials.ts:84/247、pluginInstaller.ts:226、mcpProbe.ts:238/245/259 全走 redactSensitiveString），只剩 commitPush 这一条 git 输出通道用私有窄实现——典型「公共原语已存在但被绕过」。注：commitPush.ts 当前工作树有并发 session 的未提改动，判定基于 `git show HEAD:` 的版本。grep 过：`redactPushError`（src 1 定义 + commitPushRunner 6 调用；tests 1 文件）、`redactSensitiveString`、`Bearer`/`password=`（tests 命中的都是别的域）。

### `design/dedup-audit-2026-06-13.md §3.6 后半（best-effort resume 漏 subagentLiveCapture）` — 审计已识别的缺陷：out-of-band 的 resume 调用点各自手搓 resumeTask deps，都不带 `subagentLiveCapture` ⇒ RFC-048 子代理实时捕获在这些恢复路径上静默缺失。现存 4 处：rou

- **发现者**：self-audit　**根因类别**：`text-assertion-only`
- **现象**：审计已识别的缺陷：out-of-band 的 resume 调用点各自手搓 resumeTask deps，都不带 `subagentLiveCapture` ⇒ RFC-048 子代理实时捕获在这些恢复路径上静默缺失。现存 4 处：routes/clarify.ts:386-392、routes/reviews.ts:248-256、routes/workgroupTasks.ts:167-175、routes/taskQuestions.ts（同型）；只有 routes/tasks.ts 走 `resolveSubagentLiveCapture`（:391/454/468/500/537/987）。
- **测试网为什么没拦住**：报告根因：「best-effort resume 块 3 份，且都没传 subagentLiveCapture」——deps 组装是 4 份手抄而非一个 `resumeTaskBestEffort` 共享函数。更关键的是 RFC-048 的兜底测试 packages/backend/tests/subagent-live-capture-source.test.ts 开篇自述「These tests don't exercise behavior; they pin down the file layout」——纯源码文本断言，只钉 runner.ts 里的 poller 调用形状，对「谁没把这个 dep 传进来」完全不敏感。
- **当时补的防护**：半个：RFC-143 PR-5 把 §3.6 的**前半**（resolveOpencodeCmd 五份路由本地副本）收敛进 util/opencode.ts（routes/clarify.ts:24-25 注释留证），后半的 deps 组装没动。
- **是否上升为通用机制**：未闭环，且防护形态是最弱的一档（源码文本断言 + 单向 passthrough 测试 scheduler-subagent-live-capture-passthrough.test.ts 只覆盖 scheduler→runner 这一跳）。grep 过：`resolveSubagentLiveCapture`（src 仅 routes/tasks.ts + startTaskDeps.ts）、`subagentLiveCapture`（4 处 resume deps 全部 0 命中）、`resumeTask(`（routes 层 7 个调用点）、tests `subagentLiveCapture`（7 文件，无一覆盖 clarify/review/workgroup resume 入口）。正解是审计建议的 `resumeTaskBestEffort` 单点，让漏传在类型层不可表达。

### `design/dedup-audit-2026-06-13.md §3.9 idb-draft-store-facade` — 审计已识别的缺陷：clarify 与 review 两个草稿存储对**同一个 IndexedDB 库** `agent-workflow-drafts` 用了不同 version 且各持一个 dbPromise 单例——lib/clarif

- **发现者**：self-audit　**根因类别**：`duplicated-impl-drift`
- **现象**：审计已识别的缺陷：clarify 与 review 两个草稿存储对**同一个 IndexedDB 库** `agent-workflow-drafts` 用了不同 version 且各持一个 dbPromise 单例——lib/clarify/draftStore.ts:16-18（VERSION 2）vs lib/review/draftStore.ts:9-11（VERSION 1）。两条连接 + 版本竞争：低版本连接在高版本已升级的库上 open 会拿到 VersionError，草稿静默存不进去。
- **测试网为什么没拦住**：两个 store 各自被单独测（且只有 clarify 一侧有测试文件 packages/frontend/tests/clarify-draft-store.test.ts），happy-dom/fake-indexeddb 环境里每个测试文件独立起库，天然不会让两个 store 在同一个库上碰面——测试的隔离性恰好掩盖了「共享同一个 DB_NAME」这个耦合事实。
- **当时补的防护**：无。审计建议的 `packages/frontend/src/lib/idbKv.ts`（单连接 + 单 version + store 注册表）不存在（ls 确认）。
- **是否上升为通用机制**：未闭环，且更弱：review 侧连单侧测试都没有。grep 过：`agent-workflow-drafts`（src 2 处、tests 1 处）、`idbKv`（0 命中）、`review-drafts` / `clarify-drafts`（各 1 处 src）、tests 目录 `draftStore`（仅 clarify 一份）。任何第三个功能再加一个 store（版本 3）会同时打断前两个。

### `design/dedup-audit-2026-06-13.md §3.5/§4.2 zod-parse-or-throw-422（与 RFC-203 的接缝）` — 审计已识别的缺陷：422 校验失败仍有三种 detail 形状并存，`util/errors.ts` 至今没有 `parseOrThrow`（grep 0 命中；导出仍只有 DomainError 家族 + errorHandler）。后果

- **发现者**：self-audit　**根因类别**：`wire-field-drop`
- **现象**：审计已识别的缺陷：422 校验失败仍有三种 detail 形状并存，`util/errors.ts` 至今没有 `parseOrThrow`（grep 0 命中；导出仍只有 DomainError 家族 + errorHandler）。后果被 RFC-203 放大成一个新的静默丢弃：ErrorDetails.tsx:61-101 只认 `details.issues` 数组，而 routes/taskFeedback.ts:36、routes/memories.ts:96/141/168/181 五处发的是 `parsed.error.format()` 的 `{_errors: […]}` 树 —— 全仓（src+tests）`_errors` 0 命中 ⇒ 这五个入口的校验详情在 UI 上渲染为空白。
- **测试网为什么没拦住**：dedup 报告根因：「422 被写了 ~39 处、三种 detail 形状」，一致性只靠多数派习惯。RFC-203 按「六形状富渲染」实现，形状清单来自盘点而非类型——少数派形状既不在渲染器里，也没有一条测试用 `.format()` 树喂过 ErrorDetails（rfc203-error-details.test.tsx 只覆盖 issues 数组等已支持形状）。
- **当时补的防护**：RFC-203 落了 ErrorDetails 六形状渲染 + 校验 issue 词条 65 条，把**多数派**形状接了线。
- **是否上升为通用机制**：只补了多数派这一条，没有把「后端 detail 形状」上升为共享契约：后端仍可自由 `.format()`，前端渲染器 fail-safe 地渲染空。grep 过：`parseOrThrow`（0 命中）、`.format()`（routes 5 处）、`_errors`（生产码/测试 0 命中）、`ErrorDetails`（前端 6 处消费 + 2 测试文件）、`safeParse`（routes 约 20 文件 80+ 处）。同类会复发在任何新 route 直接 `throw new ValidationError(code, msg, 自定义 payload)` 的地方。

### `design/ux-functional-audit-2026-07-16.md §1 R2（mutation 失败静默）` — 审计已识别的缺陷：大量 useMutation 只有 `onSuccess: invalidate`，失败零反馈；QueryClient 也无全局 MutationCache onError 兜底。RFC-203 把它明确列为**非目标**

- **发现者**：self-audit　**根因类别**：`happy-path-only`
- **现象**：审计已识别的缺陷：大量 useMutation 只有 `onSuccess: invalidate`，失败零反馈；QueryClient 也无全局 MutationCache onError 兜底。RFC-203 把它明确列为**非目标**「MutationCache/toast（留 RFC-B）」，而 RFC-B 至今未立项（design/plan.md 全文 `RFC-B` 仅出现在 RFC-203 那一行的非目标里）。实证残留：components/memory/MemoryAllList.tsx 的 archive/unarchive/delete 三个 mutation 全无错误渲染（文件内只有 list.error 走 ErrorBanner，:234/:242）。
- **测试网为什么没拦住**：报告根因 R2：失败呈现不是任何组件的显式契约，前端测试普遍只 mock 200 响应——packages/frontend/tests/memory-all-list.test.tsx 全部用例都返回成功体（:178「Archive → Confirm POSTs /archive」等），没有一条 mock 非 2xx 去断言「用户能看到失败」。
- **当时补的防护**：个案层面补了不少（ReviewDocPane.tsx:616/728/813 三个评论 mutation、McpInventoryPanel.tsx:170 探测错误、repos.tsx:180-183 刷新/删除、RFC-202 的修复弹窗 ok:false 不关窗），但都是逐点修。
- **是否上升为通用机制**：没有上升为通用机制：全仓 `MutationCache` 0 命中，也没有「新 mutation 必须有失败呈现」的 lint/源码守卫。grep 过：`MutationCache`（0）、`onError`（组件层零散）、`ErrorBanner` + mutation 组合（部分页面有部分没有）、tests 中的非 2xx mock（memory 面板 0）。同类问题必然继续复发在下一批新增的资源操作按钮上——审计给的正解（全局兜底 + review 检查项）恰恰是最便宜且没人执行的那一条。

### `design/flag-audit-2026-07-07.md §5.6 allowTerminal 语义漂移` — 审计已识别的缺陷：`setNodeRunStatus` 的 `allowTerminal` 文档注释（services/lifecycle.ts:156）写着「Set true ONLY for fixup scripts — never 

- **发现者**：self-audit　**根因类别**：`contract-drift`
- **现象**：审计已识别的缺陷：`setNodeRunStatus` 的 `allowTerminal` 文档注释（services/lifecycle.ts:156）写着「Set true ONLY for fixup scripts — never in normal flows」，实际全仓 21 处 `allowTerminal: true`，其中 scheduler.ts:931/4124/4371/4946/5367/5985、review.ts:2501/2781、task.ts:2208/2720 都是正常业务流。真实缺口是转移表缺 `revive`/`rearm` 事件，逼得 wrapper 复用行续跑 / fanout 原地重跑绕过高阶 API 直接用这个逃生舱。
- **测试网为什么没拦住**：RFC-053 三件套（转移表 + CAS + 直写守卫）防的是「不走 API 直写 DB」，对「走 API 但打开逃生舱」零约束；逃生舱的使用纪律只由一行注释承载，没有任何计数守卫或白名单测试，多加一处调用不会让任何测试变红。
- **当时补的防护**：无——W0 快赢批次收了同报告 §3 的死旗标（revokePats 删除、claudeCodeEnabled 删除、TERMINAL_TASK_STATUSES 改名、fanoutSourceSync 删除、AclPanel 改用 Segmented 等，均已核实落地），但 §5.6 这条没进任何批次。
- **是否上升为通用机制**：未闭环。可低成本上的通用防护正是本仓已验证的形态：给 allowTerminal 调用点加 ratchet 计数守卫（同 s14 直写守卫），或把 revive/rearm 补进事件 ADT 让正常流迁回具名转移、逃生舱回归 fixup-only。grep 过：`allowTerminal`（src 21 处 true + lifecycle.ts 定义；tests 7 文件但都是用它构造场景、无一断言调用点集合）、`transitionNodeRunStatus`、`TERMINAL_NODE_RUN_STATUSES`、`rearm`/`revive`（事件 ADT 0 命中）。


## A4 — STATE.md / plan.md 自陈的「已知未防护」

本仓的「自陈未防护」清单质量两极分化。**好的一面**：大部分 STATE.md 里写下的「遗留 / deferred」后来真的被补上了（RFC-083 T13 grammar 内嵌、RFC-080 parametric kind、RFC-204 T7 url_enc 封存、RFC-127/174 实现、权限审计 P0 worktree-files 门），而且最危险的两类缺口（fan-out 部分容忍未实现、焦点环裁剪）都配了**负向行为锁**或**硬失败几何审计**，属于「已知风险 + 已上守卫」。**坏的一面**集中在三处：① **索引本身不可信**——`design/plan.md` RFC 状态列与 `STATE.md` 遗留段大面积滞后（至少 4 个标 Draft/In Progress 的 RFC 已交付、RFC-204「剩余」段列的四项其实已 Done），导致「作者自陈的未完成清单」不能当 backlog 用，真正没人跟进的项被淹没在噪音里；② **产品规格与实现公开矛盾**——`CLAUDE.md:138` / `design/proposal.md:203/375/682` 至今把 fan-out 自动 `errors` port + 部分容忍写成已交付特性，而 `design/design.md:783-786` 明写 v1 未实现，这是唯一一条「文档会主动误导下一个 session」的漂移；③ **一批测试在真实开发路径上从不执行**——5 个 `RUN_*` 门控套件 + 3 个 nightly workflow 只在 `schedule`/`pull_request` 触发，而本仓强制 main-only 开发（永远没有 PR），加上 `e2e`→`build-binary`→`test-backend` 的串行依赖让任一 backend 分片红就整体 skip 掉 Playwright + 单二进制 smoke（作者自己在 STATE.md:13 记下了这次踩坑）。另有两类结构性盲区：单二进制内嵌 grammar 只有源码文本断言（测试文件自己承认「unit 测不到、binary smoke 也测不到」），以及 RFC-134 登记的 reopen↔echo「强制耦合点」是纯散文、零机械守卫。

### `STATE.md:5 / STATE.md:13 / design/plan.md:232（RFC-206 焦点环裁剪一次性根治）` — 输入框/页签在获得焦点时焦点环被外层 overflow 容器裁掉（/repos 批量导入输入框上边被切、/agents 高级输入框左右被切）。作者原话：这是用户报告的**第五次**同类复发，此前被分别 patch 了四次（.dialog__

- **发现者**：user-report　**根因类别**：`ui-visual-or-layout`
- **现象**：输入框/页签在获得焦点时焦点环被外层 overflow 容器裁掉（/repos 批量导入输入框上边被切、/agents 高级输入框左右被切）。作者原话：这是用户报告的**第五次**同类复发，此前被分别 patch 了四次（.dialog__body / .fuse-dialog / .workgroup-room / .page--editor > .form-grid），每次只补被报的那一个轴，换个轴又复发。
- **测试网为什么没拦住**：作者自陈原文：「jsdom 无布局引擎、现存相关测试全是源码文本断言，物理上测不到『被切』」。既有 `packages/frontend/tests/dialog-body-focus-outline-clip.test.ts` 与 `focus-ring-inset.test.ts:29-30` 都是对 `styles.css` 做 ruleBody 正则匹配，只能证明「某条 CSS 规则写了什么」，不能证明「渲染出来没被裁」。我 grep 过 focus-visible / outline-offset / --focus-ring / .form-input / dialog__body 五个角度，vitest 侧确实没有任何一条能观测几何。
- **当时补的防护**：`e2e/focus-ring-clip.spec.ts` —— Playwright + CDP `CSS.forcePseudoState` 强制 :focus-visible 后逐控件实测几何裁剪；基线白名单 `KNOWN_CLIPS`（:673）现为**空 Map**、审计处于硬失败模式；外加 `packages/frontend/tests/focus-ring-inset.test.ts` 静态锁 SCROLL_FLUSH 分类表。
- **是否上升为通用机制**：**已上升为通用机制，是本仓最好的一次防护泛化**：修法从 O(容器数) 改成 O(1)（满宽控件用 `--focus-ring-offset-inset` 把环画进自身 border box），覆盖 21 条列表/新建路由 + agent 5 页签 + 编辑器 + 任务详情 9 个 tab + 3 个弹窗，且带「覆盖门」（每个面必须实测到非零控件数，第二批曾靠它抓出 fixture 静默失效造成的假绿）。**但两个尾巴仍开着**：(a) 实现门 Codex review 因配额耗尽至 2026-07-25 未跑（plan.md T8 登记补跑步骤）；(b) 作者推送当天 CI（run 29731969225）因 backend 分片全红而 skip 掉 e2e，守卫「尚未在 CI 里真正跑过」——我查了 `gh run list`，此后 6bce0745/f8fe0454 等多次 CI 全绿，e2e job 已实际执行过，该条已自愈但 STATE.md 未回写。

### `packages/backend/tests/structural-diff-embed-guard.test.ts:1-33（RFC-083 T13 grammar 单二进制内嵌）` — STATE.md:333 原始遗留：「grammar wasm 单二进制内嵌（T13，编译后二进制调用端点会因 createRequire 解析 node_modules 失败；dev/CI 可用）」——即结构化 diff 在 dev/CI

- **发现者**：self-audit　**根因类别**：`text-assertion-only`
- **现象**：STATE.md:333 原始遗留：「grammar wasm 单二进制内嵌（T13，编译后二进制调用端点会因 createRequire 解析 node_modules 失败；dev/CI 可用）」——即结构化 diff 在 dev/CI 全绿，但发布出去的单二进制一调用就挂。T13 后来已实现（`grammars.ts:19/37/53` 走 `IS_EMBEDDED` + `GRAMMAR_FILES` bunfs 路径）。
- **测试网为什么没拦住**：测试文件自己在头注释里承认：「These lock wiring that the unit tests can't observe (the embed only materializes during `bun build --compile`) and that the binary smoke can't either (it runs `version`, not a structural diff)」。三条断言全是 `readFileSync` + 正则（`expect(src).toMatch(/GRAMMAR_FILES/)` 等）。我 grep 了 GRAMMAR_FILES / IS_EMBEDDED / grammarFilePath / runtimeWasmPath / tree-sitter-wasms 五个角度，全仓没有任何一条断言在 `IS_EMBEDDED=true` 分支下实际解析过一个文件；`packages/backend/tests/embed.test.ts:19` 反过来只断言 dev 下 `IS_EMBEDDED === false`。
- **当时补的防护**：仅 3 条源码文本断言 + 1 条「不许引入 native node-tree-sitter」的负向文本断言。
- **是否上升为通用机制**：**只补了这一条，没有上升为机制**。CI 的 `build-binary` job 只跑 `"$bin" version` 与 `"$bin" doctor`（.github/workflows/ci.yml:445-450），doctor 只覆盖 opencode PATH / git 探针 / IS_EMBEDDED-aware migrations，**完全不碰 structural diff**。同类问题会复发在任何「只在编译后二进制里走另一条分支」的代码上——目前已知同形的至少有 `opencode-plugin/index.ts:21` 的 `PLUGIN_FILES` 与 `server.ts:238` 的 IS_EMBEDDED 静态资源分支。通用修法应是在 binary smoke 里加一条真正触发 embedded 资产的端点调用（例如对一个 fixture 仓跑一次 structural-diff），而不是再加文本断言。

### `.github/workflows/ci.yml:388 / :473-474（e2e 与单二进制 smoke 的依赖拓扑）+ STATE.md:13` — backend 测试分片任一红 → `build-binary` (needs: [lint, test-backend, test-frontend]) 不跑 → `e2e` (needs: build-binary) 也不跑。结果是「别

- **发现者**：self-audit　**根因类别**：`env-gated-or-skipped`
- **现象**：backend 测试分片任一红 → `build-binary` (needs: [lint, test-backend, test-frontend]) 不跑 → `e2e` (needs: build-binary) 也不跑。结果是「别人的红」会静默吞掉「我的 e2e 守卫」，作者在 RFC-206 收官时正好踩到：他的几何守卫和单二进制 smoke 都被 skip，CI 结果里看不出「守卫没跑」和「守卫跑了没发现问题」的区别。
- **测试网为什么没拦住**：这不是测试缺失，是 CI 拓扑缺失 signal。我 grep 了 ci.yml 的 needs / if: / continue-on-error 三个角度：`e2e` 与 `build-binary` 都没有 `if: always()`，也没有任何「守卫必须实际执行过」的 required-check 断言。`packages/backend/tests/test-suite-policy.test.ts` 管住了「测试被 skip」，但管不住「整个 job 被 skip」。
- **当时补的防护**：无。作者只在 STATE.md:13 用 ⚠️ 记了一笔，并做了 bisect 归属（红项属并发 session 的 `7ee8df92`，RFC-207 删 `autonomous` 时漏改三个测试文件）。
- **是否上升为通用机制**：**完全没有防护，只补了这一次的归因说明**。这个仓是多人共享 `main`（memory: shared-ref CI attribution / no-amend on shared tree），并发 session 的红是常态而非例外，所以「我的 e2e 守卫被别人的红吞掉」会规律性复发。可行的通用修法：给 `e2e` / `build-binary` 加 `if: always()` 或至少把 e2e 从 backend 分片的 needs 里解耦（e2e 只真正依赖 build-binary 产物，不依赖 backend 单测结果）。

### `CLAUDE.md:138 + design/proposal.md:203/204/375/682 vs design/design.md:777-786（fan-out 自动 errors port / 部分容忍）` — 产品规格文档至今宣称多进程节点「Auto `errors` port on parent」「节点不算 failed，成功部分按字典序聚合，失败信息聚合到自动追加的 errors port」；实际实现是 **fail-all-after-jo

- **发现者**：self-audit　**根因类别**：`contract-drift`
- **现象**：产品规格文档至今宣称多进程节点「Auto `errors` port on parent」「节点不算 failed，成功部分按字典序聚合，失败信息聚合到自动追加的 errors port」；实际实现是 **fail-all-after-join**——只要有一个 shard 失败，父节点直接 failed、跳过聚合、不写任何 outlet、errors port 根本不产出。`design/design.md:783-786` 明写「在 v1 未实现……本文其他位置对自动 errors port 的描述在落地前均属 deferred」，deferred 去向是 WP-6b，而 WP-6b 所属的 RFC-098 已标完成，errors port 并未随之落地。
- **测试网为什么没拦住**：这次**没有漏**——`packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts:156` 有一条正面锁：「1 of 3 shards fails → wrapper fail-all, no aggregation, **no errors port**, done outputs invisible downstream」，:299 直接 `expect(wrapperOuts.find(o => o.portName === 'errors')).toBeUndefined()`，且 :292-293 写明「修复后翻转：'final' 出现，且 errors port 携带失败清单」。我 grep 了 errors port / 部分容忍 / fail-all-after-join / shardKey 四个角度确认这是全仓唯一的相关断言。真正的逃逸不在测试层，在**文档层**：CLAUDE.md 是每个新 session 的第一入口，它写的是未实现的语义。
- **当时补的防护**：s18/s19 行为锁（负向断言 + 翻转说明），加 design.md §6.3 的 deferred 声明块。
- **是否上升为通用机制**：**代码侧防护是通用且优秀的（锁住了当前语义并写明未来翻转点），文档侧完全没同步**。design.md 自己都点名「本文其他位置对自动 errors port 的描述均属 deferred」，却没有人去改 CLAUDE.md:138 和 proposal.md:203/375/682。同类风险：任何按 CLAUDE.md 摘要写代码/写 RFC 的新 session 都会假设 errors port 存在。修法是让 s18 测试顺带加一条对 CLAUDE.md/proposal.md 的源码文本反向断言（这正是本仓已有的 grep 锁范式），或直接改文档。

### `design/RFC-134-reassign-asker-echo/design.md:122/146 + packages/backend/src/db/schema.ts:2253（reopen ↔ echo 强制耦合点）` — 尚未发生，是登记在案的**未来定时炸弹**。RFC-134 的 echo（回执）条目通过 origin 轮 `answers_json` **live 读取** Q&A；之所以安全，唯一前提是「reopen（打回）在当前代码不存在，下发后答

- **发现者**：codex-review　**根因类别**：`contract-drift`
- **现象**：尚未发生，是登记在案的**未来定时炸弹**。RFC-134 的 echo（回执）条目通过 origin 轮 `answers_json` **live 读取** Q&A；之所以安全，唯一前提是「reopen（打回）在当前代码不存在，下发后答案与承接目标均不可变」。design.md:146 原文：「**强制耦合点**（Codex F2）：打回若就地改 answers_json / 改承接目标，必须同步规定 echo 的重排队（trigger 置 NULL）与『改回提问节点即删 echo』规则，否则回执静默送旧答案 / 同题双渲染。本 RFC 在此登记，实现打回者须引用本行」。
- **测试网为什么没拦住**：没有任何机械守卫。我 grep 了 reopen / reopenTaskQuestion / reopen_count / 'echo' 四个角度：`reopenTaskQuestion` 全仓零命中；`reopen_count` 列在 schema.ts:2253 已建但休眠（`clarifySeal.ts:34` 注明 stay dormant）；`'echo'` roleKind 在 `rfc120-task-questions-service.test.ts:489` 只有一条「不该产生 echo」的负向断言，`rfc120-task-questions-route.test.ts` 覆盖 RFC-134 正向路径，但**没有一条测试锁住「answers_json 变更时 echo 必须重排队」**——因为触发它的功能还不存在，测试无从表达。
- **当时补的防护**：只有 design.md §7 末行的一行散文登记（「实现打回者须引用本行」）。
- **是否上升为通用机制**：**只补了这一条散文，没有任何机制**。一句写在 RFC-134 design.md 里的话，指望未来某个写 reopen 的 session 会先去翻 RFC-134——这在本仓 210+ 个 RFC 的规模下基本等于没有。同类形态（休眠列 + 未来耦合承诺）在本仓还有 `prior_answer_snapshot_json`。可行的通用修法：给休眠列加一条「任何对 task_questions.answers_json 的 UPDATE 写点必须同时处理 echo」的源码写点棘轮（本仓已有大量同型「写点白名单/棘轮」测试，如 setTaskStatus 的 s14 守卫）。

### `packages/backend/tests/test-suite-policy.test.ts:40-58 / :80-103（RUN_* 环境门控套件）+ .github/workflows/integration-opencode.yml:10-12` — 5 个后端/e2e 套件在本地 `bun test` 下**恒不执行**：`git-repo-cache-submodule` / `worktree-submodule-init` / `mcp-probe-{http,stdio}-in

- **发现者**：self-audit　**根因类别**：`env-gated-or-skipped`
- **现象**：5 个后端/e2e 套件在本地 `bun test` 下**恒不执行**：`git-repo-cache-submodule` / `worktree-submodule-init` / `mcp-probe-{http,stdio}-integration`（RUN_GIT_NETWORK）、`chaos-scenarios`（RUN_CHAOS）、`opencode-live.integration`（RUN_OPENCODE_INTEGRATION）、`e2e/visual-regression`（RUN_VISUAL_REGRESSION）。其中 opencode-live 是**双条件**：`SKIP = !RUN_INTEGRATION || !AUTH_AVAILABLE`（opencode-live.integration.test.ts:41-56），而 workflow 头注释直言「If unconfigured the workflow stays green — the gate tests pass and the LLM tests skip. That's the desired graceful-degrade behaviour」——即凭据没配时整个 opencode 漂移探测器**永久静默绿**。
- **测试网为什么没拦住**：门控本身是有意设计（本地 `bun test` 要是可信绿信号），且有元守卫 `test-suite-policy.test.ts:268-281` 强制每个 RUN_* 开关必须在 CI 里有具体激活点。真正的缺口是**触发时机**：`integration-opencode.yml:33-44`、`git-protocols-e2e.yml:22-33`、`visual-regression-nightly.yml:24-46` 三个 workflow 只有 `schedule` + `workflow_dispatch` + `pull_request(paths)` 三种触发，**没有 `push`**；而本仓（per user memory「Main-branch-only development」）强制直接在 `main` 上开发、从不开 PR，所以 `pull_request` 路径过滤那条腿**永远不会触发**，只剩每天固定时刻的 cron —— 与具体提交完全解耦，改坏了要等到第二天、且不知道归属哪个 commit。
- **当时补的防护**：`test-suite-policy.test.ts` 的两条元断言：`ALLOWED_SKIP_COUNTS` 精确清单（新增/删除 skip 必须改这张表）+ `REQUIRED_GATE_ACTIVATIONS` 逐字符 marker 校验（每个 RUN_* 必须在某个 workflow/package.json 里被置 1）。各套件还各带一条 gate-sanity 自检（`expect(!RUN_X).toBe(process.env.RUN_X !== '1')`）。
- **是否上升为通用机制**：**防护本身是全仓通用机制且质量很高**（AST 解析而非 grep、`only`/`todo`/`fixme`/`fail`/`fit`/`xit` 全禁、skip 计数精确到文件+修饰符）。**但它有两个盲区**：① `TEST_ROOTS`（:15-20）只扫 `packages/{backend,shared,frontend}/tests` 和 `e2e`，**不扫 `packages/frontend/src`**（那里有 3 个测试文件：`features/tasks/__tests__/task-questions-overflow.test.ts`、`task-workflow-cell-overflow.test.ts`、`features/clarify/__tests__/clarify-title-overflow.test.ts`，我已确认当前无 skip/only，但新增的会逃逸）也不扫 `tests/perf`；② 它只验「开关在某个 workflow 里被置 1」，不验「那个 workflow 在本仓真实开发路径上会被触发」——`pull_request` marker 照样能让断言通过。

### `e2e/git-protocols.spec.ts:190（`test.describe.skip('RFC-054 W3-4 — SSH path (deploy-key, follow-up)')`）` — Git over SSH（deploy-key）克隆路径在 e2e 层从未验证过。skip 的理由写在 :30 的注释里：「scoped to a follow-up PR」。

- **发现者**：self-audit　**根因类别**：`env-gated-or-skipped`
- **现象**：Git over SSH（deploy-key）克隆路径在 e2e 层从未验证过。skip 的理由写在 :30 的注释里：「scoped to a follow-up PR」。
- **测试网为什么没拦住**：作者主动 skip 并登记进 `ALLOWED_SKIP_COUNTS['e2e/git-protocols.spec.ts#skip'] = 2`。我 grep 了 ssh / deploy-key / RFC-054 W3-4 / git-protocols 四个角度：全仓没有第二处 SSH clone 的行为覆盖，且承诺的 follow-up PR 在 STATE.md / plan.md 里都找不到对应条目——**这条属于「忘了就再也没人管」**。同一文件 :56 还有一条 `test.skip(SKIP, 'gitea fixture not configured')`，意味着 fixture 没起来时整个 HTTPS 腿也静默跳过。
- **当时补的防护**：无功能守卫；只有 `test-suite-policy.test.ts` 的计数锁保证这个 skip 不会被偷偷再加一个。
- **是否上升为通用机制**：只补了单点（计数锁）。计数锁能防「新增 skip」，防不了「已有 skip 永远不被兑现」——`ALLOWED_SKIP_COUNTS` 里没有任何「到期日 / 关联 issue / owner」字段，一条 skip 一旦进表就永久合法。建议给该表的 value 从 `number` 升为 `{count, reason, trackingRef}`，让每条 skip 强制挂一个可追踪的 RFC/issue 锚点。

### `e2e/clarify.spec.ts:446-455（`test.describe.skip('RFC-023 clarify e2e — agent-multi shard fanout (deferred to RFC-060 PR-D2 per-shard clarify)')`）` — 一段永久死的 e2e 骨架：注释说 agent-multi 已在 RFC-060 PR-E 被删除，per-shard clarify 从 PR-D 推迟到 PR-D2，「the runner-side per-shard clarify 

- **发现者**：self-audit　**根因类别**：`env-gated-or-skipped`
- **现象**：一段永久死的 e2e 骨架：注释说 agent-multi 已在 RFC-060 PR-E 被删除，per-shard clarify 从 PR-D 推迟到 PR-D2，「the runner-side per-shard clarify mint isn't wired yet. Revive (rewrite for wrapper-fanout + agent-single inner) when PR-D2 lands per-shard clarify (RFC-060 D.T5)」。
- **测试网为什么没拦住**：**这条其实是误报风险最高的一条，我做了反向核实**：per-shard clarify 后来已经实现了——`packages/backend/src/services/clarify.ts:174/451/468-470` 有 `sourceShardKey` 维度，我 grep `sourceShardKey` 命中 **35 个后端测试文件**（scheduler-clarify-dispatch / routes-cross-clarify / rfc128-p1-per-question-seal 等）。所以行为层是有防护的。**真正未兑现的是 plan.md 里点名的两件事**：`design/RFC-060-fanout-as-wrapper/plan.md:206-211` 承诺的 `packages/backend/tests/clarify-in-fanout.test.ts`（≥6 case，self + cross）**文件不存在**（`ls` 确认），以及这段 e2e 从未被重写。
- **当时补的防护**：间接被 35 个 shardKey 相关单测覆盖；e2e 层无。
- **是否上升为通用机制**：属于「已知风险已接受但清单没回写」：功能补上了、单测补上了，但 plan.md 的验收清单（D.T5 指名的测试文件）和 e2e skip 都还停在旧状态。危害是**读者会以为这块没测**（我第一眼也这么判断），反过来也可能让下一个人以为「反正 skip 着，改坏了没人知道」。修法：删掉这段死 describe（agent-multi 已不存在，重写它是伪任务），并把 plan.md D.T5 的验收行改指向真正承接覆盖的文件。

### `design/plan.md:148/152/178/194/200/225/227（RFC 索引「状态」列）+ STATE.md:75-81（RFC-204「剩余」段）` — 「作者自陈的未完成清单」本身不可信，两个方向都错。**标 Draft 实际已交付**：RFC-127「Draft（待批准 + Codex 设计 gate）」但 `packages/shared/src/task-questions.ts:1

- **发现者**：self-audit　**根因类别**：`contract-drift`
- **现象**：「作者自陈的未完成清单」本身不可信，两个方向都错。**标 Draft 实际已交付**：RFC-127「Draft（待批准 + Codex 设计 gate）」但 `packages/shared/src/task-questions.ts:18/171` 已有 `canReassign` 且注释写「RFC-127 T4 起任意角色」+ `packages/shared/tests/task-questions-reassign.test.ts` 存在；RFC-174「Draft（Codex 设计门待跑 + 用户批准）」但 `WorkgroupRoom.tsx:117/272` + `lib/workgroup-room.ts:488` + `workgroup-room.test.tsx:613-616` 全部落地。**STATE.md 反向滞后**：STATE.md:75-81 把 RFC-204 的 T5/T7/T8尾/T9 列为「剩余」，但 `services/repoCredentials.ts:115` 的 `ensureCredentialsSealed` 已接进 `cli/start.ts:387` / `cli/backup.ts:21` / `routes/backup.ts:13`，`schema.ts:677` 的 `url_enc` 已落，plan.md:230 已标 Done。
- **测试网为什么没拦住**：文档一致性无任何自动校验。我 grep 了 Draft / In Progress / Superseded / Reserved 四个状态词 + 逐条到代码里反查实现，才分辨出哪些是真开着。CLAUDE.md「RFC workflow §2/§4」要求 RFC 完工时把状态改 Done 并同步 STATE.md，但这一步纯靠人工，没有任何 CI 检查（`.github/workflows/ci.yml` 的 `docs` job 只跑 lychee 链接检查）。
- **当时补的防护**：无。
- **是否上升为通用机制**：**完全没有防护**。这是本次审计里最影响「逃逸考古」本身可行性的一条：因为索引不可信，真正没人跟进的项（RFC-205 沙箱、git-protocols SSH、arch-audit §3 候选项）被埋在一堆「其实已经做完了但没回写」的假阳性里。可行的通用修法：加一条 docs 测试，对每个标 Draft/Reserved 的 RFC 目录做「其 plan.md 里点名的关键标识符不得在 `packages/*/src` 中命中」的反向断言（本仓已有大量同型源码棘轮）。

### `design/plan.md:231（RFC-205 运行时沙箱，状态 Reserved）+ STATE.md:66/81（RFC-204 deferred）` — 凭据对 task agent 的**真实边界至今不存在**。plan.md:231 自己写明：「运行时沙箱：把 agent 进程与 `~/.agent-workflow`（secret.key / db.sqlite / 镜像 origin

- **发现者**：self-audit　**根因类别**：`harness-cannot-express`
- **现象**：凭据对 task agent 的**真实边界至今不存在**。plan.md:231 自己写明：「运行时沙箱：把 agent 进程与 `~/.agent-workflow`（secret.key / db.sqlite / 镜像 origin / worktree）做 FS/UID 隔离，才是『把凭据从 task agent 手里隔离』（RFC-204 P0-b）的真边界——加密+origin 清洗因 agent 同 UID 可直读 key 而无效」。也就是说 RFC-204 做的 `url_enc` 封装只挡住了 wire 面和日志面，挡不住 agent 进程本身：它和 daemon 同 UID，`cat ~/.agent-workflow/secret.key` 就能解密。
- **测试网为什么没拦住**：这不是测试能拦的形态——威胁模型是「被编排的 LLM agent 主动读同 UID 下的文件」，任何单测/e2e 都跑在同一个信任域里，无从表达「agent 不应该能读到 secret.key」。我 grep 了 secret.key / secretKeyFile / sandbox / UID 四个角度：`Paths.secretKeyFile` 在 `cli/start.ts:387` 与 `cli/backup.ts:21` 直接被读，没有任何 FS 隔离层。
- **当时补的防护**：RFC-204 侧的补偿性防护：`CachedRepoSchema` 删明文 url、`localPath` 出线脱敏、`redactGitUrl` 补 query token 脱敏、`ensureCredentialsSealed` 幂等封存 + 备份前 gate + WAL 物理抹除。
- **是否上升为通用机制**：补偿防护是通用的（覆盖 wire/日志/备份三条出口），**但根因边界只是登记了一个编号，三件套都没写**（「Reserved（编号预留，三件套待启）」）。同类会复发在任何「daemon 持有的凭据 / token / OIDC client secret」上——agent 进程能读整个 `~/.agent-workflow`。另有两条同批 deferred 也无人跟进：`0099` drop 空的 `cached_repos.url` 列（`schema.ts:672-675` 注明「Dropping the column is deferred to 0099」）与「R2 共享镜像凭据复用隔离」。

### `STATE.md:121（RFC-182 遗留：「房间明暗视觉走查待用户实测」）+ e2e/visual-regression.spec.ts-snapshots/（62 张基线）` — 工作组聊天室（RFC-182 统一回合卡 / 执行记录 / presence 四态，涉及大量新增状态色与 chip）的明暗双主题视觉从未被自动化验证，作者把它挂成「待用户实测」。

- **发现者**：self-audit　**根因类别**：`ui-visual-or-layout`
- **现象**：工作组聊天室（RFC-182 统一回合卡 / 执行记录 / presence 四态，涉及大量新增状态色与 chip）的明暗双主题视觉从未被自动化验证，作者把它挂成「待用户实测」。
- **测试网为什么没拦住**：视觉套件里根本没有这个面。我逐张列了 `e2e/visual-regression.spec.ts-snapshots/` 的 62 个 png 并 grep 了 `toHaveScreenshot(` 的全部调用点（:465-721）：覆盖 auth/agents/workflows/repos/memory/settings/onboarding/homepage/tasks/inbox×3/mobile×5/workflow-editor×5，**没有任何 workgroup-room 快照**；spec 里 :325-340 虽然 mock 了 `/api/workgroup-tasks/:id/room`，但那是给 dynamic-workflow-preview 用的，不产出房间截图。另外整套 visual 本身是 `RUN_VISUAL_REGRESSION=1` opt-in + nightly-only（见上一条），即使加了也不在 PR/push 门上。
- **当时补的防护**：无视觉守卫；行为层有 `packages/frontend/tests/workgroup-room.test.tsx`（含 RFC-174/RFC-209 用例）与 `workgroup-room-lib.test.ts`，但都是 jsdom/happy-dom，不测像素与主题。
- **是否上升为通用机制**：只补了行为，没补视觉。而且暗色主题在整套 visual 基线里只有 2 个面有（`inbox-populated-dark` 与 `workflow-editor-1280-inspector-dark`），其余 30 个面**只有 light 基线** —— 暗色回归在全站范围内基本是裸奔状态。这与 memory 里记录的「frontend visual verify via minimal repro」习惯（靠人工起 http server + chrome 截图）一致：本仓的暗色验证事实上依赖人，不依赖 CI。

### `STATE.md:291（RFC-101 记忆→技能融合，「v1 未覆盖：真实 opencode 端到端」）` — 融合链路（内置 aw-skill-merger agent / aw-skill-fusion 工作流 / 强制反问 / 临时 git 仓 preCreatedWorktree 播种 / approve 原子升版）在框架侧全绿，但作者自陈「

- **发现者**：self-audit　**根因类别**：`mock-too-deep`
- **现象**：融合链路（内置 aw-skill-merger agent / aw-skill-fusion 工作流 / 强制反问 / 临时 git 仓 preCreatedWorktree 播种 / approve 原子升版）在框架侧全绿，但作者自陈「agent 实际 clarify→编辑→manifest 行为未在真 opencode 跑」。
- **测试网为什么没拦住**：全链路用 stub opencode 验证。我 grep 了 stubOpencode / aw-skill-merger / fusion / manifest 四个角度：融合测试走的是 e2e harness 的 stub 二进制，真 opencode 只在 `packages/backend/tests/integration-opencode/opencode-live.integration.test.ts` 里出现，而那套是 `RUN_OPENCODE_INTEGRATION=1 && AUTH_AVAILABLE` 双门 + nightly-only，且其用例只覆盖 `--version` 解析、JSON event 流形状、envelope 解析——**不含融合链路**。所以「agent 真的会照我们的协议编辑 manifest 吗」这个问题，全仓零覆盖。
- **当时补的防护**：框架侧 stub 全验（PR-A/B/C 三批 + Codex 全量复审 7 项修 6）。第 7 项「restore 回融合版不重新融合」被记为已知限制（design §10 OQ-6）。
- **是否上升为通用机制**：**这是全仓性的结构缺口，不止 RFC-101**：`design/plan.md:122` 也写着「未覆盖：真实 opencode 端到端（框架侧 stub 全验）」。整个平台的核心价值是驱动真实 opencode 进程，而唯一的真 opencode 套件只覆盖三条最基础的协议断言、还是 nightly+需凭据。任何「agent 在我们的 prompt 协议下实际会怎么做」的假设（envelope 格式、反问样例注入、manifest 编辑、skill 发现顺序）都只被 stub 验证过。

### `design/arch-audit-2026-06-23/00-CODEX-CROSSCHECK.md:47/59/70 + STATE.md:287（RFC-103「v1 未覆盖」）` — 架构审计的 Codex 交叉核验挖出一批 High 级问题，被作者显式移出 RFC-103 scope 并登记为「候选后续 RFC」，至今没有 RFC 编号也没有 owner：① cross-clarify 消费 stamp 未按 `loo

- **发现者**：codex-review　**根因类别**：`no-test-at-all`
- **现象**：架构审计的 Codex 交叉核验挖出一批 High 级问题，被作者显式移出 RFC-103 scope 并登记为「候选后续 RFC」，至今没有 RFC 编号也没有 owner：① cross-clarify 消费 stamp 未按 `loopIter` 隔离（`clarifyRounds.ts:132/159` 写时标记同节点所有 loop_iter 的 answered，读路径按 loopIter 过滤 → 后续轮次 External Feedback 被提前老化丢失，High 正确性）；② 完整 user prompt 走 argv，长 prompt 会 **E2BIG 启动失败**（`runner.ts:633-690` / `memoryDistiller.ts:615-707`，High）；③ GC 删可恢复 worktree；④ copy/paste wrapper 数据破坏；⑤ 融合资源 shadow + 审批 ACL。
- **测试网为什么没拦住**：问题是审计发现的、不是测试发现的，且移出 scope 后没有任何测试被写下来把它们钉红。我 grep 了 E2BIG / argv / loopIter / clarifyRounds 四个角度，后端测试目录里没有任何一条断言长 prompt 的 argv 边界，也没有 loop_iter 维度的 clarify 老化用例。
- **当时补的防护**：无。仅 `00-CODEX-CROSSCHECK.md §3` 的一份列表 + STATE.md:287 的一行「见该文件（候选后续 RFC）」。
- **是否上升为通用机制**：**典型的「忘了就再也没人管」**：一份 2026-06-23 的审计报告，rank 1 那批（RFC-103）做完了，剩下的挂在一个不在 plan.md RFC 索引里、不在 STATE.md 未完成表里的 markdown 小节里。其中 argv E2BIG 是**用户可触发的启动失败**（长 prompt / 大 diff 注入就会撞），性质上比很多已经立了 RFC 的项更急。本仓有 8 份这类 audit 报告（arch/dedup/flag/scheduler/ux/ux-functional/workgroup-e2e/permission），每份都带各自的 backlog，彼此不互通、也不进统一 backlog。

### `STATE.md:57（RFC-210 递归 submodule 隔离，「剩余未折入（已登记，实现前需处理）」）` — 进行中 RFC 的自陈待处理项：`gitlinkFailureMode:'warn'` 应改成 pre-flight（否则「父撤子不撤」的混合半态）；`runIsoWorktreeGc` 的池 ref 兜底应**反向扫描**（扫池 ref 

- **发现者**：self-audit　**根因类别**：`cross-module-seam`
- **现象**：进行中 RFC 的自陈待处理项：`gitlinkFailureMode:'warn'` 应改成 pre-flight（否则「父撤子不撤」的混合半态）；`runIsoWorktreeGc` 的池 ref 兜底应**反向扫描**（扫池 ref → 查 tasks 表判终态，否则容器已删时 ref 永久泄漏）；父仓层与子仓层 resolve-iso 的并存关系未定义；`deleteCachedRepo` 的 `force` 后门会让所有活动 worktree 的 alternates 同时悬空。
- **测试网为什么没拦住**：尚未实现到那一步——`gitlinkFailureMode` 我 grep 了 `packages/backend/src` / `packages/shared/src` / `packages/backend/tests` 三处，零命中，说明确实还没落代码。这条属于**正在进行中、登记完整**，不是逃逸。
- **当时补的防护**：尚无（PR-1 地基已上 main 且 CI 绿：`b9fdecd6` 池原语/G10 快照/性能门 + `e447fb58` 版本无关修复；T8/T10/T11/T11b 已实现待提交）。
- **是否上升为通用机制**：登记质量很高（含跨 git 版本行为差异的实测记录：`--reference` 在本机 2.50.1 是静默 no-op、CI runner 的 git 会挂上，作者按本机行为写死断言被 CI 打红 run 29738347309），属于「已知风险已接受、有明确 owner 正在处理」。**唯一值得盯的是它会不会像 RFC-204 那样：主体做完、STATE 标 Done、这五条尾巴留在正文里没人再读**——本次审计已确认 RFC-204 的「剩余」段就发生过这种情况（只是方向相反：做完了但没回写）。
