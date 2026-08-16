# RFC-306 工作流条件分支（端口级激活 / 不执行标记）—— 产品提案

> 状态：Draft（待用户批准后进入实现）
> 依赖：RFC-060（signal 控制流端口）、RFC-074/076/095/098（freshness / dispatch frontier）、
> RFC-042（envelope followup）、RFC-103（分片与端口解析）、RFC-253（script 节点）、
> RFC-294（后台目标架构，本 RFC 落 `task-execution` bounded context）

## 1. 背景

平台今天的工作流是**全图必达**的：`deriveFrontier` 只认「done ∧ fresh」为完成
（`packages/backend/src/services/scheduler.ts:2439-2471`），下游要跑必须其**全部**传递上游都完成
（`freshness.ts:92-105`）；一旦 scope 内还有节点没完成又没人可跑，就是
`scheduler stalled → task failed`（`dispatchFrontier.ts:421-465`）。因此：

- 无法表达「**审出问题才走修复链，没问题就直接结束**」这类最基本的条件流转；
- 作者只能把互斥逻辑塞进一个大节点的 prompt 里，或让下游 agent 拿到空输入后「自己判断什么都不做」
  —— 后者仍然真实启动了一个 runtime 子进程，既烧 token 又污染时间线，且「它到底做没做」不可判定；
- 图的**运行轨迹**（本次真正走了哪条路）在数据里根本不存在，只能靠人读每个节点的输出反推。

端口层面其实已经差一步就够用了：`node_run_outputs` 逐端口存内容，`signal` 端口 kind 早已定义为
「控制流专用、不携带数据」（`packages/shared/src/outputKinds/signal.ts`），画布也已经把控制流边画成灰虚线
（`packages/frontend/src/components/canvas/controlFlowEdge.ts`）。真正缺的是一个**明确的、可判定的
「这条分支本轮不执行」信号**，以及调度器对它的结算语义。

`node_runs.status` 枚举里的 `'skipped'` 从 RFC-095 起就存在但**全仓零 mint 点**，
`isDispatchable` 里明写着「谁要启用它，必须先在这里定义它的调度语义」
（`dispatchFrontier.ts:373-376`）。本 RFC 就是来兑现那句话的。

### 1.1 为什么不是「端口缺失即断链」

一个自然的想法是「agent 不输出某端口 ⇒ 该分支不跑」。本 RFC **不采用**，理由：

- 今天缺端口只是 `log.warn` + 补空串（`envelope.ts:443-446`、`runner.ts:1899-1904`），
  改判会让**所有存量工作流**的行为静默改变（agent 漏写端口从「空串照跑」变成「下游不跑」）；
- 「漏写」「模型跑飞」「输出被截断」与「我决定不走这条分支」在数据上完全同形，事故无法归因。

同理也**不采用**「整个 envelope 缺失 ⇒ 跳过下游」：agent 崩溃 / 超时 / 被 kill / 网关 5xx 全都是没
envelope，今天它们是 `envelope-missing` 硬失败 + 同 session 重问（`runner.ts:1883-1886`），
把它改成「正常的分支决策」等于把一整类真故障洗成正常终结。

**本 RFC 的信号是显式的**：端口照常输出，在端口标签上标 `active="false"`。

## 2. 目标 / 非目标

### 目标

- G1 —— 作者可以把某个输出端口声明为**分支端口**；agent / script 在运行时对它标 `active="false"`，
  该端口的**所有**出边不激活，下游子图不执行。
- G2 —— 不执行不是失败：被跳过的节点以 `skipped` 结算，任务照常 `done`。
- G3 —— 图的**运行轨迹**成为一等数据：哪些边未激活、哪些节点被跳过、每个分支决策的理由，
  都可查询、可在画布上直接看出来。
- G4 —— 分支可穿透容器边界（wrapper-loop / wrapper-git / wrapper-fanout / call-workflow / call-workgroup）。
- G5 —— 决策可被推翻：上游重跑产生新输出后，旧的跳过判定作废并按新输出重新评估。
- G6 —— **零存量行为变化**：不声明分支端口的工作流，跑法与今天逐字节一致。

### 非目标

- 不做「按值路由」的表达式引擎（`if port == 'x' then ...`）。分支判据由 agent / script 自己算，
  平台只认端口上的激活标记。需要确定性判据时用 script 节点算（RFC-304「选择器/分类/仲裁一律脚本」）。
- 不做边级条件（一个端口连三条边时只断其中一条）。粒度是端口级。
- 不做循环内的跨轮分支状态延续（每轮独立重算）。
- 不做「分支未走通就报警/兜底分支」这类 fallback 语义。
- 不引入新的节点种类（没有 `switch` / `if` 节点）；分支是**端口能力**，不是新节点。

## 3. 用户故事

- **US-1 代码审计**：审计 agent 声明 `issues`（分支）与 `all_clear`（分支）两个端口。发现问题时输出
  `issues` 并把 `all_clear` 标为不执行 → 只有修复链跑；干净时反过来 → 修复链整条 `skipped`，
  任务直接 `done`，时间线上清清楚楚写着「放行：未发现问题」。
- **US-2 确定性路由**：script 节点读上游 JSON 结论，按阈值决定激活 `escalate` 还是 `auto_merge`，
  AI 不参与路由（RFC-304 宪法②）。
- **US-3 分片各走各的**：20 个文件分片审计，只有 3 个分片输出了 `needs_fix`，聚合器只看到这 3 份，
  另外 17 个分片的修复链根本不启动。
- **US-4 循环提前收敛**：loop 内的判定节点在第 3 轮把 `need_more` 标为不执行，
  新增的 `port-inactive` 退出条件让循环当轮退出。
- **US-5 人工纠偏**：作者在任务详情看到 agent 关错了分支，对被跳过的节点点「仍然执行」，该链重新跑起来。

## 4. 产品行为规格

以下每条都对应第 6 节反问里用户的逐条拍板，编号 D1–D18。

### 4.1 线协议（D1 / D16）

```xml
<workflow-output>
  <port name="issues">发现 3 处越权读取…</port>
  <port name="all_clear" active="false">代码有 3 处需修复，不走放行链</port>
</workflow-output>
```

- 端口标签新增可选属性 `active`，取值 `"true"` / `"false"`（大小写不敏感）。
- **不写属性 = 激活**（D2）。`active="true"` 合法且是 no-op。
- `active="false"` 时端口内容**不作为数据传给下游**（下游本来就不跑），而是作为**决策理由**存档，
  在运行轨迹与端口详情里展示。理由可留空。
- 其他取值（`active="0"` / `active="no"` / 空）= 协议违规，见 4.4。

### 4.2 默认与存量兼容（D2）

| 写法                                     | 判定                                               |
| ---------------------------------------- | -------------------------------------------------- |
| 端口整个没出现在 envelope 里             | **激活**，值 `''`（与今天完全一致：warn + 空串）   |
| `<port name="x"></port>`                 | 激活，值 `''`                                      |
| `<port name="x">内容</port>`             | 激活，值为内容                                     |
| `<port name="x" active="false">…</port>` | **不激活**，内容存为决策理由                       |
| 整个 envelope 缺失                       | 不变：`failed(envelope-missing)` + 同 session 重问 |

存量工作流没有任何端口被声明为分支端口 ⇒ 运行时永远不会出现不激活端口 ⇒ 行为逐字节不变（G6）。

### 4.3 分支端口必须显式声明（D3）

- **agent**：`agent.md` frontmatter 新增 sidecar `branchPorts: [port, …]`（与 `outputKinds` /
  `outputWrapperPortNames` 同一条 `frontmatter_extra` 通路）。前端在**输出端口配置**里以开关呈现
  （`components/OutputsEditor.tsx` / `components/agent-ports/AgentPortDialog.tsx`）。
- **script**：`ScriptOutputPortSchema` 新增 `branch?: boolean`，脚本节点端口编辑器同样以开关呈现。
- 分支端口**可以同时携带数据**（激活时就是普通端口）；它与 `signal` kind 正交
  （signal 端口也可以是分支端口，此时它就是纯开关）。

### 4.4 越权标记 = 协议违规（D4）

端口没有被声明为分支端口，agent / script 却写了 `active="false"`：

- 节点 `failed`，`failure_code='branch-port-not-declared'`；
- 复用 RFC-042 的同 session followup（`decideEnvelopeFollowup`）重问一次，明确告诉它该端口不是分支端口；
- 重试用尽后节点硬失败。**绝不静默当激活处理**——否则 agent 以为关了分支、实际全跑，是最坏的一类错。

属性值非法（4.1 末条）同样按协议违规处理，`failure_code='branch-marker-malformed'`。

### 4.5 作用粒度：端口级（D5）

被标记的端口，其**全部**出边不激活。要按不同下游区分，就声明多个分支端口。

### 4.6 汇合语义（D6）

- 节点的入边中**至少一条激活** ⇒ 节点执行；未激活的那些输入在 prompt 模板里渲染为空串。
- 节点新增可选字段 `joinMode: 'any' | 'all'`，**默认 `'any'`**（OR）。切到 `'all'` 时任一入边未激活即跳过。
- 无入边的节点（input 节点、根 agent）永远激活。

### 4.7 跳过的传播与任务终态（D7 / D11）

- 判定为不执行的节点落一条 `node_runs.status='skipped'` 行（不启动任何进程），并继续向下游传播判定。
- `skipped` 是**已结算**：它不阻塞 scope 收敛，任务照常 `done`。
- 生命周期不变量 **T3**（`lifecycleInvariants.ts:407-431`：`task.status='done' ⟹ 每个 output 节点都有
done 运行`）放宽为 **done 或 skipped**。
- 被跳过的 output 节点不产出内容，详情页显示「未激活」。
- 全部分支都被关掉（所有 output 节点 skipped）时任务仍是 `done`——用户明确拍板不当失败。

### 4.8 容器边界继承（D9 / D17）

- **wrapper-loop**：出口端口绑定的内部源不激活 ⇒ 该出口端口向外也不激活。
- **wrapper-fanout**：见 4.10。
- **wrapper-git**：`git_diff` 由框架快照产生，恒激活（内部链全跳过时它就是一份空 diff，与今天一致）。
- **wrapper 自身被跳过**（其入边全不激活）：整个内部 scope 不进入运行，不落内部行。
- **call-workflow / call-workgroup**：子工作流里某个 output 节点被跳过 ⇒ 父任务里对应端口不激活，
  继续在父图传播。子工作流因此可以当作「可复用的分支判定器」。

### 4.9 循环（D14）

- 分支判定**逐轮独立重算**：第 1 轮走 A、第 2 轮走 B 完全合法。
- 新增退出条件 `port-inactive`：目标端口本轮不激活即退出。
- 既有退出条件遇到不激活端口：`port-empty` **成立**（无产出≈空，保护存量循环不会因为引入分支而跑到
  `exhausted`）；`port-not-empty` / `port-equals` / `port-count-lt` **不成立**。

### 4.10 分片（D13）

- 每个 shard 独立决策。
- **只有活跃分片参与聚合**：分片内相关端口不激活的，不作为空项进入聚合输入，而是根本不出现。
- 聚合器输出端口本身也可以是分支端口（分支可以从 fanout 里穿出去）。

### 4.11 人工节点（D15）

review / clarify 节点落在未激活链上时**跟随跳过**：不进待办、不发通知、不产生 `awaiting_*` 停留。

### 4.12 人工强制执行（D18）

任务详情里，被跳过的节点提供「仍然执行」入口（与现有单节点重试同一入口，下游按现有规则级联）。
强制执行 = 本次忽略「上游未激活」，未激活输入渲染为空串照跑；其下游仍按该节点**真实输出**重新判定。

### 4.13 决策可被推翻（D10）

`skipped` 行与 `done` 行走**完全对称**的 freshness 语义：上游产生更新的输出后，旧的 `skipped` 行变
stale，该节点被重新评估——原本被关掉的链可以重新激活并真正执行。review iterate / clarify 回答 /
单节点重试触发的重跑都自动享有这条。

### 4.14 前端（D12）

- **任务详情画布**＝运行轨迹：激活边正常、未激活边灰虚线、`skipped` 节点整体置灰；
- 节点表新增 `skipped` 状态 chip，并展示该节点/端口的决策理由；
- 设计期画布上分支端口有独立视觉标识（沿用 signal 端口的虚线 handle 语言）；
- 端口配置弹窗里的「分支端口」开关（4.3）。

## 5. 行为影响清单（存量语义变更，逐条呈用户确认）

本 RFC 整体是加法，但下列**存量语义**会被改动。按 CLAUDE.md §RFC workflow 第 7 条的精神逐条列出：

| #   | 变更点                                                                             | 影响面                                | 兼容性论证 / 防护                                                                                     |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| I-1 | `node_run_outputs` 增列 `active`，默认 1                                           | 全部端口读点                          | 默认 1 ⇒ 存量行与不写标记的新行都判激活；读点统一走一个 helper                                        |
| I-2 | `isDispatchable` 的 `skipped` 分支从「永不再调度」改为「stale 才重调度」           | 调度器                                | 今天零 mint 点，改动不可能影响存量数据（`dispatchFrontier.ts:373-376`）                               |
| I-3 | 上游源行挑选口径从 done-only 扩为 **done ∪ skipped**（`freshness.ts:183`、`:287`） | 输入解析、freshness、wrapper consumed | 没有 skipped 行的任务里两种口径等价，golden-lock 测试锁定                                             |
| I-4 | 不变量 T3 放宽为 done ∨ skipped                                                    | 后台巡检                              | 只放宽、不收紧；新增「done 任务的 output 节点不得为 failed/缺行」的等价强度断言                       |
| I-5 | envelope 端口标签允许属性                                                          | 解析器 + malformed 检测               | 无属性写法保持逐字节等价；malformed / 吸收检测同步扩展并补测                                          |
| I-6 | script 节点端口可带激活标记                                                        | script 执行                           | 「声明端口必须全部出现」的严格性**不变**（`scriptPorts.ts:67-73`）；关分支必须显式写 `active="false"` |
| I-7 | output 节点从「恒落虚拟 done 行」变为「可落 skipped 行」                           | 详情页、T3                            | 与 I-4 配套                                                                                           |
| I-8 | 新增 rerun cause `branch-skip`、退出条件 `port-inactive`、节点字段 `joinMode`      | 契约面                                | 均为可选新增；YAML 导入导出与工作流版本号照常处理                                                     |

## 6. 反问记录（五轮，逐条拍板）

- **R1-Q1 触发信号** → 用户否掉四个预设项，改为：「该接口明确标记为不执行，但**仍然输出 envelope、
  仍然有 port**，只是明确标记为不执行」⇒ **D1 显式标记**。
- **R1-Q2 汇合语义** → **D6** 默认 OR，节点可切 AND。
- **R1-Q3 终态** → **D7** 跳过 = 正常终结，任务 done。
- **R1-Q4 决策主体** → **D8** agent 与 script 都可以。
- **R2-Q1 线协议形态** → **D1** 端口属性 `active="false"`（明确接受扩展 envelope 解析器的代价）。
- **R2-Q2 默认值** → **D2** 未标记一律激活，含端口整体缺失，存量零变化。
- **R2-Q3 声明方式** → **D3**「配置 agent 输出或者 script 输出的端口的时候，需要有开关标记是否是分支端口」。
- **R2-Q4 粒度** → **D5** 端口级，断全部出边。
- **R3-Q1 wrapper 边界** → **D9** 继承，出口也不激活。
- **R3-Q2 重算** → **D10** 跳过可被推翻。
- **R3-Q3 不变量 T3** → **D11** 放宽为 done 或 skipped。
- **R3-Q4 前端** → **D12** 画布轨迹高亮 + 节点表。
- **R4-Q1 fanout** → **D13** 活跃分片才参与聚合。
- **R4-Q2 loop** → **D14** 逐轮重算 + 新增专用退出条件 `port-inactive`。
- **R4-Q3 人工节点** → **D15** 跟随跳过，不弹人工。
- **R4-Q4 理由** → **D16** 端口内容即理由（可选）。
- **R5-Q1 旧退出条件** → **D14'** `port-empty` 兼容未激活（成立），其余不成立。
- **R5-Q2 call 节点** → **D17** 继承，父端口也不激活。
- **R5-Q3 越权标记** → **D4** 硬失败 + 同 session 重问。
- **R5-Q4 人工干预** → **D18** 提供「仍然执行」。

## 7. 验收标准

- **AC-1**：agent 输出 `<port name="p" active="false">`，且 `p` 已声明为分支端口 ⇒ `p` 的所有出边不激活，
  其下游（含传递下游）落 `skipped` 行，任务收敛为 `done`。
- **AC-2**：同一工作流里另一条分支正常执行并产出，output 节点内容与今天一致。
- **AC-3**：未声明分支端口的工作流，端到端行为与本 RFC 前逐字节一致（golden lock）。
- **AC-4**：未声明分支端口却标 `active="false"` ⇒ `failed(branch-port-not-declared)` + 一次同 session 重问；
  属性值非法 ⇒ `failed(branch-marker-malformed)`。
- **AC-5**：`joinMode` 默认 any：两条入边一活一跳 ⇒ 节点执行，未激活输入渲染为空串；切 all ⇒ 节点跳过。
- **AC-6**：wrapper-loop / call-workflow / call-workgroup 的出口端口继承内部未激活状态，并在外层继续传播。
- **AC-7**：wrapper-fanout 中只有活跃分片进入聚合输入；未激活分片不以空项出现。
- **AC-8**：loop 逐轮重算；`port-inactive` 退出条件成立即退出；`port-empty` 在端口未激活时成立，
  `port-not-empty` / `port-equals` / `port-count-lt` 不成立。
- **AC-9**：review / clarify 落在未激活链上 ⇒ `skipped`，不产生任何待办、通知或 `awaiting_*` 停留。
- **AC-10**：上游重跑产生更新输出后，原 `skipped` 行变 stale 并被重新评估；原被关闭的链可以真正跑起来。
- **AC-11**：任务详情对 `skipped` 节点提供「仍然执行」，点击后该节点真实执行，下游按其输出重新判定。
- **AC-12**：`task.status='done'` 且存在 skipped output 节点时，不变量巡检无 finding；
  output 节点为 `failed` 或缺行时仍然报 finding。
- **AC-13**：画布上未激活边为灰虚线、`skipped` 节点置灰；节点表有 `skipped` 状态；决策理由可见；双语齐全。
- **AC-14**：端口配置弹窗可开关「分支端口」，保存后 YAML 导出/导入往返不丢。

## 7bis. 设计门（Codex，2026-08-16）结论与逐条处置

评审基线 `fbe9ac9f`，只审功能设计（按用户指示不做安全审计）。结论 **NOT-CLEAN：0 个 P0、9 个 P1、5 个 P2**，
每条都带可复现场景与源码锚点。逐条处置如下（编号沿用门的编号）：

| #     | 门的判定                                                                                                                                 | 处置                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | 节点已合入工作区的改动，在其转为 skipped 后不会被撤销：控制流说「没跑」，仓库里却有它的产物                                              | **呈用户拍板 → 不撤销**。「跳过」= 不再做新工作，不等于撤销已发生的工作（与重跑上游不会撤销已 push 的 commit 一致）。改为**显式呈现**：轨迹里 `hasEarlierProducedGeneration` 标出「此前产出仍在工作区」                   |
| P1-2  | 判定只看显式 edge，漏了 `review.inputSource` / `output.ports[].bind` 这两类隐式依赖 ⇒ 被关闭分支上的 review 仍会弹给人、output 仍落 done | **已修**：新增 `collectImplicitInboundRefs`，判定面与 `buildScopeUpstreams` 的依赖面对齐；AC-9 的 e2e 用例即锁这条                                                                                                        |
| P1-3  | 「分片内部是一个子 scope，各节点各自判定」写错了                                                                                         | **已改文档**：validator 只允许 fanout 内 `inner → aggregator`（`workflow.validator.ts` 的 `fanout-inner-chain-unsupported`），分片内**没有**可跳过的下游链。分支在 fanout 里的唯一形态是「分片端口被关 ⇒ 该分片不进聚合」 |
| P1-4  | `pickReusableShardRun` 是第三处 done-only 过滤，会从新 skipped 行后面捞回旧 shard 内容                                                   | **不可达，已写死边界**：分片行只由 `dispatchFanoutShard` 铸，**永不进入分支判定**，故不存在 skipped 分片行；D13 靠端口 `active=0` 实现，picker 无需改口径                                                                 |
| P1-5  | fanout 聚合器的分支输出提升到 wrapper outlet 时丢 `active` ⇒ 分支出不了 fanout                                                           | **已修**：outlet 提升读取聚合器端口行的 `active` 并透传                                                                                                                                                                   |
| P1-6  | call 的 outcome 契约三层（DB select → ExecutionOutcome → 父端插入）都没有 `active`                                                       | **已修**：三层全部带上；子工作流 output 节点 skipped 时按其**声明端口名**投影为 `active:false`，而不是让端口整个消失                                                                                                      |
| P1-7  | 同一次 `runScope` 内翻转 skipped 会被 node 级 dedup 拦住，误报 `scheduler stalled`                                                       | **已修**：为 stale skip 增加一次性释放，键为「使其变 stale 的上游 run id」，每个新上游代次只释放一次                                                                                                                      |
| P1-8  | 直接铸 skipped 违反行状态机，并会把既有 pending / awaiting 锚点留在新行后面                                                              | **已修**：`pending` 行**复用**（pending→skipped），`awaiting_*` 行先 `cancel-by-supersede` 再落 skip，其余情况才新铸                                                                                                      |
| P1-9  | `force_activated` 没有消费规则，会变成永久强制执行                                                                                       | **按构造即一次性**：标志只落在 retryNode 铸的 placeholder 上；判定读「最新行」，真正执行后铸的新行不带标志。已补文档与用例                                                                                                |
| P2-10 | T3 只扩 status 集合仍是「历史上存在过」，最新行 failed 时不报警                                                                          | **已修**：改为「每个 output 节点取最新 top-level 行，其状态必须 ∈ {done, skipped}」                                                                                                                                       |
| P2-11 | `active` 属性用文本搜索会命中 `data-active` 和别的属性值里的 `active='false'`                                                            | **已修**：改为逐属性 token 扫描；门给的两个反例已成为回归用例                                                                                                                                                             |
| P2-12 | plain clarify 被从「skipped」改成无行 no-op，且轨迹推不出置灰                                                                            | **保留无行**（`settlesWithoutRow` 是 C1/N6 既有契约，落行会破坏它），行为面不变（上游被跳过 ⇒ 无会话可开 ⇒ 天然 no-op）；轨迹置灰由服务端查询推导                                                                         |
| P2-13 | 平面 ID 集合无法表达 loop 逐轮 / fanout 分片的混合状态                                                                                   | **已改契约**：`BranchTrace` 的节点/边条目都带 `iteration`（展示口径 = 每节点最新已结算代次），fanout 另给 `shardActivation` 计数，不把「3/20 分片激活」压成一个布尔                                                       |
| P2-14 | 缺 `agent.branchPorts ⊆ outputs` 校验                                                                                                    | **已修**：create 与 update（按合并后的值）都校验；前端删除/重命名端口时同步维护该列表                                                                                                                                     |

## 8. 呈用户确认的开放项

- **Q-A（fanout 全不活跃）**：D13 只规定了「活跃分片才参与聚合」。当**所有**分片都不活跃时，
  当前设计是「聚合器仍然启动、拿到空输入跑一趟」。是否改为复用既有空源短路
  （`scheduler.ts:7906-7921`）直接把 wrapper 出口标为不激活、不启动聚合器？（第一轮问答里这是选项 3，
  未被选中，故此处按选项 1 实现并单列开放项。）
- **Q-B（git wrapper）**：内部链全跳过时 `git_diff` 是「激活的空 diff」。是否需要改成「不激活」？
  当前设计维持激活（与今天「没有改动」的表达一致）。
- **Q-C（强制执行的传染性）**：D18 的「仍然执行」只强制**被点的那个节点**，其下游按真实输出重新判定。
  是否需要一个「强制整条链」的变体？当前设计不提供。
- **Q-D（已合入改动不撤销）**：设计门 P1-1 呈报后用户拍板**不撤销**，轨迹显式标注。
  若日后需要「关闭分支即回滚该节点已合入的 delta」，须另立 RFC（要复用 iso 替换机制并新定义冲突处置路径）。
