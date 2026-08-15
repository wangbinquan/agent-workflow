# RFC-304 · 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
> 本文的一切设计从 proposal §2 的**两条宪法**推导；与宪法冲突的设计一律作废。

## 0. 导读（本文近千行，先看这里）

**必读的四节**，其余可按需查阅：

| 先读                            | 为什么                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| §2.1–2.2 工作项与状态机         | 整个系统的骨架。身份键、状态转移、守卫优先级、两条不变量（工作项串行 / MR lease）都在这里，后面各节都建在它上面 |
| §2.2「恢复语义」+「发布临界区」 | 两处最容易实现错的地方：前者关系到"人确认的 patch 与推送的是不是同一个"，后者是唯一的并发线性化点               |
| §4 阶段引擎                     | 四种 `kind`、确定性守卫（宪法 R3–R5 的落地）、钩子                                                              |
| §6.1 `mr-review` 序列           | 第一条要做的能力，也是另三条"自审"时复用的核心                                                                  |

**读的时候注意两个标记**：

- 标了 **（设计门 P1/P2）** 的段落，是三轮设计门抓出的问题及其修复。它们通常记着"初稿怎么写的、
  为什么不成立"——这些是踩过的坑，改回去之前请先读完那段理由。
- §1.4 的 **D1–D5 偏离项**与 proposal §6bis 的**待确认判断**，是尚未获得用户确认的部分，
  实现前须先看这两处的结论有没有变。

**三轮设计门的产出**（约 45 条 findings 全部处置）：第一轮查出五处**事实错误**——初稿建立在
"issue 事件面存在""每轮一个 task 有载体""配置包是通用格式"等不成立的前提上；第二轮查出十几处
**机制交互**问题——第一轮的修复彼此打架；第三轮转向实现可行性与宪法符合性。文档因此比初稿长了
近一倍，多出来的几乎全是"为什么不能那样做"。

## 1. 目标架构对齐（RFC-294，CLAUDE.md §RFC workflow 第 8 条）

### 1.1 落位：新增 bounded context `code-capability`

RFC-294 §3 列出「最终后台**至少**形成以下 bounded contexts」共 13 个，其中没有承载本 RFC 的一档：

- `integration` 的职责是「webhook、schedule、code-host ingress/egress 及其**触发合同**」——它是**通道**，
  本 RFC 的工作项、阶段序列、优先级仲裁、意见台账都不是通道语义，塞进去会让 integration 从
  「事件进出」膨胀成「代码协作业务」。
- `task-execution` 拥有 Task/NodeRun 生命周期。工作项是**比 task 长一个数量级**的业务对象
  （跨事件、跨天、跨多个 task），把它并进去会污染 RFC-294 W7 正在收敛的 NodeRun 身份轴。
- `collaboration` 是 human gate（review/clarify/question），本 RFC 消费它而不属于它。

因此新增 `code-capability`。RFC-294 的措辞是「至少」，新增不与总纲冲突，但**这是本 RFC 的第一条
偏离项，需用户确认**（§1.4）。

### 1.2 模块内分层

```
modules/code-capability/
  domain/           工作项状态机与转移表 · 阶段契约 · 优先级仲裁规则 · 意见指纹
                    position 组装规则 · 采纳信号判定 —— 纯函数，零 IO
  application/      命令与查询：发起 / 唤醒 / 推进一轮 / 发布 / 落账 / 读模型
  engine/           StageEngine（阶段执行）· HookRunner · DeterminismGuard（R3/R4/R5）
  ports/            CodeHostPort · ScriptRunnerPort · TaskLauncherPort · LedgerPort
                    · ClarifyPort · WorktreePort（application-owned，接口在此、实现在 infrastructure）
  infrastructure/   sqlite 台账与工作项存储 · code-host 适配 · 脚本执行适配
  public/           commands / queries / participants / events / types
  inbound/          HTTP 路由适配 · webhook 事件适配 · 定时唤醒适配
  composition/      装配（唯一 new 具体实现的地方，不做业务判断）
```

与既有 `integration` 模块的形态一致（`modules/integration/{domain,application,infrastructure,public,composition}`）。

### 1.3 跨模块依赖：只走 public 合同

| 依赖                      | 用途                                    | 合同                       |
| ------------------------- | --------------------------------------- | -------------------------- |
| `integration.public`      | 归一化 webhook 信封、code-host 出站调用 | 事件订阅 + 调用命令        |
| `task-execution.public`   | 起一轮（= 一个 task）、查状态、取消抢占 | 启动命令 + 状态查询 + 事件 |
| `source-control.public`   | worktree 准备与回收、diff 读取          | 命令                       |
| `resource-catalog.public` | agent 解析、模板资源 CRUD 与 ACL        | 查询 + 命令                |
| `collaboration.public`    | 反问（clarify）发起与作答回收           | 命令 + 事件                |

**禁止**：读对方的表、import 对方 `domain/` 或 `infrastructure/` 下任何符号、复用对方的全局单例。
新增代码**不得**在 `routes/` 或 `services/` 平铺层落任何跨域 facade。

### 1.4 偏离项清单（呈用户确认）

> ✅ **D1–D5 全部经用户确认（2026-08-15）**，无异议。D5 的跨 RFC 协调按「先加后收编」执行
> （proposal §6ter-H3）。

| #      | 偏离                                                          | 理由                                                                                        | 备选与代价                                                                    |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **D1** | 新增第 14 个 bounded context                                  | 三个候选 context 收编它都会破坏各自的职责边界（§1.1）                                       | 并入 `integration`：让通道模块承载业务聚合，后续 W-wave 拆分成本更高          |
| **D2** | 引入**第二套生命周期状态机**（工作项），与 task 状态机并存    | 两者层次不同：工作项跨多个 task；等待人回应发生在工作项层，故不存在"挂着一个 task 空等三天" | 复用 task 状态机：需要 task 支持天级挂起，与 RFC-097 转移表和恢复语义正面冲突 |
| **D3** | 编排层不落 `workflow_definitions`，自带阶段序列定义           | 阶段序列平台写死且版本化，与用户可编辑的工作流定义语义不同；混存会互相污染校验规则          | 复用 workflow 表：用户会在工作流列表里看到一堆不可编辑的系统行                |
| **D4** | 脚本挂载点直接消费 `scriptRun` 的执行机制而非 script **节点** | 钩子与适配脚本不是工作流节点，没有画布位置与端口连线                                        | 造成第二套脚本执行实现——**不接受**，故复用机制、不复用节点                    |
| **D5** | **新增第四种 execution kind `code-round`**                    | 见下方论证：现有三种都承载不了一轮                                                          | 三条退路各自更差，见下表                                                      |

D4 不算真偏离（复用机制是对的），列出是为了说明「为什么钩子不是 script 节点」。

#### D5 论证：现有执行入口承载不了「一轮」

初稿写「每轮物化为一个 task，复用既有执行内核」，设计门核实后发现**没有可用载体**——
`StartExecutionRequest`（`packages/backend/src/services/execution/types.ts:58`）只有三种 kind：

| 退路                    | 为什么不行                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind: 'workflow'`      | 要求持久化的 `workflowId` 并从库里读定义，与 D3「阶段序列不落 `workflow_definitions`」直接冲突；且十三阶段里有程序步、脚本步、`invoke` 子序列，workflow 节点模型表达不了 |
| `kind: 'agent'`         | 只承载**单个** agent 的一次运行，一轮里有多个 AI 步 + 大量程序步                                                                                                         |
| 直接调 `runSystemAgent` | 它是明确的 non-task primitive：各次 AI 调用不属于任何 task，取消/回放/中断修复/详情页**全部落空**——而"复用这些"正是本 RFC 选择跑在任务引擎上的全部理由                   |

故新增 `kind: 'code-round'`：它拥有一个 task 行与完整生命周期，其内部由 `StageEngine` 驱动阶段
序列，每个 `kind:'ai'` 阶段起一次 agent 运行并归属该 task。这是对 `task-execution` public 合同的
**扩展而非绕过**——取消、重试、中断修复、资源限额、详情页全部按既有语义工作。

代价：`task-execution` 模块需要接纳一个新 participant。这是本 RFC 唯一触及既有执行模块的改动。

**与 RFC-294 W2 的协调（须在动手前谈定）**：W2 目前是 **seed-only**——「task SCC 六条、durable
ownership、TaskEngine/Executor/Wrapper **未收口**」（`RFC-294/plan.md:79`），且总纲要求 W2 用
**新编号 RFC** 重新取锚过门（`plan.md:18`）。也就是说，本 RFC 要加东西的那块地基本身正等着被重构。
两条路：

- **等 W2** ⇒ RFC-304 被阻塞到一个尚未立号的大件之后，不可接受；
- **先加，但按最小侵入设计** ⇒ 本 RFC 采用这条：`code-round` 只**新增一个变体**，不改现有三种
  kind 的语义、不动它们的调用面、不引入新的 ownership 概念（复用既有 task 行的 ownership 与
  driver lease）。这样 W2 重构时它与其余三种一起搬，不构成额外收口负担。作为交换，本 RFC 须把
  `code-round` 的形态**登记进 RFC-294 的 W2 输入清单**，让 W2 立号时知道要收编四种而非三种。

这属于跨 RFC 协调，需用户裁决是否接受「先加后收编」（列入 §6bis-⑬）。

#### D5 实现约束（T0a 期间按源码核实，2026-08-15）

「最小侵入」不等于「只在启动入口加一个变体」。核实发现**第四种 kind 必须同时进
`taskExecutionKind()`**（`packages/shared/src/schemas/task.ts`），否则 code-round 的产出恒为空：

`buildExecutionOutcome`（`services/execution/outcome.ts:150`）按 `taskExecutionKind()` 决定
**输出从哪读**——`workflow` 去 snapshot 里找 `output` 节点、`agent` 读固定的
`AGENT_HOST_AGENT_NODE_ID`、其余落 `else` 读工作组状态。

**注意那个 `else` 不判 kind**：原实现是 `if workflow / else if agent / else`，所以不加判别的
code-round 落进的是 **workgroup 分支**（不是 workflow 分支），`workgroupModeOf(null)` 返回 null
⇒ `outputs` 恒 `{}`、`status` 仍 `done`、外加一条 `workgroup-config-unparsable` 警告——**归因还
指向该任务根本没有的工作组配置**。这比纯静默更糟：日志里有一条把人引向错误子系统的线索，而
真正的原因（新 kind 没有分支）在一个没人会去看的臂里。

故实现时一并把该 `else` 改成显式 `else if (kind === 'workgroup')`，末尾补 `never` 穷尽兜底——
第五种 kind 将来**编译期**就红，而不是再上演一次同样的静默。

由此确定 T0b 的实际形状（三点，均属既有形状的同形扩展，不新增概念）：

1. `taskExecutionKind()` 返回值增加 `'code-round'`，且**判在最前**（它比 workgroup / agent 更特殊）；
   返回类型是字面量联合，故 38 处调用点由 TS 强制穷尽——这是选它而非新开一个并行判别函数的理由；
2. 判别位需要 task 行上的一列（`code_round_id`，nullable）。沿用既有派生法：**不新增状态列**，
   kind 仍是从行字段**派生**而非存储，避免与行本身产生第二个可能不一致的事实源；
3. `buildExecutionOutcome` 增加 code-round 分支，从合成节点读产出；同时把兜底 `else` 显式化 + `never` 收口。
4. **`OutcomeTaskRow` 必须 select `code_round_id`**（实现时发现的第二个静默口）：`taskExecutionKind`
   的判别字段**全是可选的**，所以任何忘记 select 判别列的调用方拿到的是**错误分类**而非类型错误。
   该行类型上已加注释写明此约束，并有一条测试专门把「忘记 select ⇒ 静默 done + 空产出」这一形状钉住。
5. `Task` / `TaskSummary` wire schema 都要带 `codeRoundId`——前端调用同一个 `taskExecutionKind`，
   字段不上 wire 则前端永远判不出 code-round，会给它渲染一个指向合成宿主的工作流链接。

`ExecutionKind`（`services/execution/types.ts:23`）的注释写明其 domain **刻意等于**
`taskExecutionKind()`；上面三点正是维持该等式所需的全部改动，而不是打破它。

## 2. 领域模型

### 2.1 工作项（CodeWorkItem）——聚合根

一个工作项 = 一个被跟进的外部对象。**身份键**：

```
(codeHostEndpointId, stableProjectId, capability, anchorKind, anchorId)
例：(ep_7, 41823, 'mr-review',   'mr',    '412')   一个 MR 的检视
    (ep_7, 41823, 'mr-monitor',  'mr',    '412')   同一个 MR 的监视
    (ep_7, 41823, 'requirement', 'issue', '88')    一个需求
```

**为什么不是 `(provider, 'platform/api', …)`**（设计门 P1）：仓库路径是**可变的**——重命名或
转组之后，同一个 MR 会算出不同的键，于是凭空多出第二个工作项，而旧台账、去重链、抢占关系全部
断开；反过来，两个 GitLab/GHES 实例上存在同名路径时又会被错误合并成一个。RFC-303 的领域实现
（`modules/integration/domain/mrTerminalControl.ts:59`）已经踩过并解决了这件事：用稳定
`projectId`，跨 endpoint 再加 `endpointId`。本 RFC 沿用同一姿势。路径与 URL 只作**可变展示快照**
存在 `anchorMeta` 里，不进身份。

`mr-review` 与 `mr-monitor` 是**两个**工作项而非一个：proposal E1 拍板「检视独立于监视器」，
两者的触发源、闭环条件、台账内容都不同。它们通过同一个 `anchorRef` 关联，在状态图上并列展示。

### 2.2 工作项状态机

```
                        ┌───────────────────── 新事件（同一工作项）
                        ▼
   idle ──event──►  queued  ──►  running  ──publish ok──►  settled ──┐
                        ▲           │  │                      │      │
        新事件到达 ┌─────┘           │  └─需要人回应─► awaiting ─┘      │
                  │                 │                    │           │
          superseding ◄─────────────┘                    │ 基线变→作废 │
             （epoch+1，等旧 task 终态）                   │           │
                  │                 │                    └───────────┤
                  │                 ├──► failed ──重试/新事件──► queued│
                  │                 │                                │
                  └─旧 task 终态────►│                                │
                                    └──► handed_off ──人工/新 head──► queued
                                        （CI campaign 配额耗尽；MR 仍在跟进）
                                                                     ▼
              外部闭环（MR 合并/关闭 · 线程 resolve · 流水线转绿）───► closed
                                                        （并做终局采纳比对）
```

转移表（CAS 写入，照搬 `services/lifecycle.ts` 的 `trySetTaskStatus` 姿势）：

**守卫优先级（必须按此顺序判定，否则转移不确定）**：同一个事件可能同时命中多条转移——同事推了
新 commit，对处于 `awaiting` 的工作项既是「外部事件到达」又是「基线 sha 变化」。规则：

1. **基线变化优先**：`awaiting` 期间 head 变化一律先消费为**失效**（作废 + 回帖），不进 `queued`。
2. **确认关键词必须带匹配的 pending generation**：只有针对当前那一轮 patch 的确认才能唤醒；
   迟到的旧确认（generation 不匹配）被丢弃并回帖说明"该请求已失效，请重新发起"。
3. 普通 note / pipeline 事件**不得**唤醒一个等待推送确认的工作项。

| from                      | event                              | to                           | 副作用                                                                                                    |
| ------------------------- | ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `idle`/`settled`          | 外部事件到达                       | `queued`                     | 若有在跑轮次 → 请求 `task-execution` 取消                                                                 |
| `awaiting`                | 外部事件到达（且通过上述三条守卫） | `queued`                     | 同上                                                                                                      |
| `queued`                  | 调度取用                           | `running`                    | 起一个 task（一轮）                                                                                       |
| `running`                 | 轮次完成且已发布                   | `settled`                    | 落台账                                                                                                    |
| `running`                 | 轮次产出需人回应                   | `awaiting`                   | 记录等待句柄（线程 id / clarify 会话 id）                                                                 |
| `awaiting`                | 人回复                             | `queued`                     | 起**新一轮**，不复活旧 task。**新一轮从该能力声明的 `resumeFrom` 阶段开始**，不从头跑——见下方「恢复语义」 |
| `awaiting`                | 基线 sha 变化                      | `settled`                    | **作废**：本轮无产出，回帖说明并请重新发起。此处 `settled` 读作"本轮已收束"，不蕴含"已发布"               |
| `running`                 | 同一工作项的新事件到达             | `superseding`                | 请求取消旧 task；**epoch +1**；**不立即开新轮**                                                           |
| `superseding`             | 旧 task 到达终态                   | `queued`                     | 开新轮（携带新 epoch）                                                                                    |
| `running`                 | 轮次失败                           | `failed`                     | 平台内告警，MR 静默                                                                                       |
| `failed`                  | 人工重试 / 新事件                  | `queued`                     |                                                                                                           |
| `running`                 | 该 campaign 重试配额耗尽           | `handed_off`                 | 回帖汇总每轮尝试；**本 campaign 不再自动开轮**                                                            |
| `handed_off`              | 新 head sha                        | （先 collect+classify 预检） | **失败指纹变了才**解除并开新 campaign；指纹相同则保持 `handed_off`                                        |
| `handed_off`              | 人工显式重试 / 配置变更            | `queued`                     | 显式 override，解除接管                                                                                   |
| 任意非 `closed`/`closing` | 外部闭环事件                       | `closing`                    | epoch +1、请求取消在跑轮次、等待补偿与 lease 释放                                                         |
| `closing`                 | 旧 task 终态且补偿完成             | `closed`                     | 做一次**终局采纳比对**（见下）后终结                                                                      |

`handed_off` 是设计门补上的状态：CI 修复三轮未成后若只落 `failed` 或 `settled`，下一条 pipeline
事件会把它拉回 `queued` 从而**开始第四轮并再次回帖**；若为了止损落 `closed`，又会错误地终止整个
MR 的后续监视。故需要一个「已交人、但 MR 仍在跟进」的可持久化状态，作用域是**本次 failure
campaign**（键同 §6.4 的 `(工作项, 失败指纹)`），并在 MR 与 `/code` 上显示当前由谁接手、怎么解除。

**解除条件必须收紧到"失败指纹变了"**（第二轮设计门 P1）：初稿写「任何新 head 都解除」，于是作者
只改一个 README 推上去，同一个编译错误就白送三轮新配额，第 4–6 轮照跑——正好绕开了配额本身要
防的东西。故新 head 只触发一次 `collect + classify` **预检**，指纹变了才算新 campaign。
`handed_off` 行须持久化 `failureFingerprint`、已用 attempt 数、接管原因与接手人、配置 generation。

**不变量一**：同一工作项同时最多一个 `running` 轮次。抢占**不是**「直接开新轮」——初稿写「新轮不
等待旧轮清理完成」，但转移表里根本没有 `running + 新事件` 这条转移，且旧轮若正处在 publish/push
就会与取消请求竞速，产生两个实际运行的轮次。故引入显式的 `superseding` 中间态与 **round epoch**：
新事件先把工作项推进 `superseding` 并把 epoch +1，等旧 task 到达终态后才开新轮。

**「调用前复检 epoch」不够——那是 TOCTOU**（设计门 P1）。复检通过之后、HTTP 真正发出之前，事件
处理器完全可以把 epoch +1，于是陈旧产出照样落到 MR 上。lease 也挡不住：它只阻止**另一轮启动**，
不阻止**事件处理器改 epoch**。故需要一个明确的线性化点：

> **发布临界区**：轮次进入对外写动作前，以 CAS 把自己标记为该 MR 的 `publishing`（带 epoch）。
> 此后到临界区结束之前，**事件处理器不得推进该工作项到 `superseding`**，只能把事件登记为
> `pendingRevision`。临界区结束（成功或失败并完成补偿）后才处理登记的事件。
>
> 即：**已进入发布临界区的旧轮赢，新事件顺延到下一轮**。反过来（事件先赢、旧轮中止）也是自洽的，
> 但需要能中断已发出的 HTTP，代价大且对 GitLab 的分批草稿不可靠——故选前者。

§9 失败模式表里原来那句"新轮不等待旧轮清理完成"与本节冲突，已一并删除。

**不变量二：同一 MR 串行（MR 级 lease）。** 只有不变量一不足以兑现 proposal G7 承诺的「同一 MR
串行」——`mr-review` 与 `mr-monitor` 是两个工作项，各自都能进 `running`：MR update 与 pipeline
failure 同时到达时，监视器正在修 CI 并推送，检视轮却基于**旧 sha** 在发意见，作者会看到刚被机器
改掉的代码仍被评论。故在工作项之上再加一层以
**`(codeHostEndpointId, stableProjectId, anchorKind, anchorId)` 为键的 MR 级 lease**：任一能力
开轮前必须先取得该 MR 的 lease，取不到就排队。「检视独立于监视器」（E1）只表示**入口独立**，
不构成独立并发域。

#### lease 的完整协议（设计门 P1：初稿只说了"要有"，没说怎么用）

| 项                      | 规则                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| 键                      | `(codeHostEndpointId, stableProjectId, anchorKind, anchorId)`                                     |
| 持有者                  | 具体的 `roundId` + 一次性 token（fencing）；不是工作项                                            |
| 获取                    | `queued → running` 前获取；取不到则留在 `queued`                                                  |
| 续租                    | 轮次心跳续租；超时未续 ⇒ 视为失效可被抢                                                           |
| **释放时点**            | 轮次到达**任何**终态即释放：`settled` / `failed` / 取消完成 / 进入 `awaiting` / 进入 `handed_off` |
| `awaiting`·`handed_off` | **不持 lease**——它们可能持续数天，持锁会把该 MR 的其他能力全部饿死；恢复时重新获取                |
| 崩溃恢复                | token 带 daemon 代际；重启后旧 token 一律失效，由恢复流程重新认领                                 |

**排队期间的事件合并**：`queued` 期间又来新事件时不逐条排队（否则 lease 释放后会连跑一串已经
过期的轮次），而是**只保留最新的 `pendingRevision`** 并提升 epoch；真正开轮时用最新那个。
人工 `@叫` 与确认关键词**不参与合并**——它们是人的指令，必须各自产生一次回应。

#### 恢复语义（`awaiting → queued` 时新一轮从哪开始）

「起新一轮」**不等于「从头跑一遍」**。若从头跑，`mr-comment-fix` 会重新执行 `apply-change(ai)`，
于是**人确认的那个 patch 与最终推上去的不是同一个**——这是会真出事的。

**恢复策略按「等待原因」而不是「能力」声明**（第二轮设计门 P1）。初稿给每条能力一个 `resumeFrom`
并加了一条总规则「绝不重跑任何 AI 阶段」，两者对 `requirement` 直接打架：反问的答案是**新输入**，
`comprehend` 必须重做才能把答案吃进去；不重做就只能继承上一轮"信息不足"的旧产物，答案等于没给。
故等待分两类，各有各的恢复语义：

| 等待原因                                          | 语义                               | 恢复策略                                                                               |
| ------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `frozen-artifact-confirmation`（贴 patch 等确认） | 人是**对着已冻结的产物**做决定     | 从 `resumeFrom` 起；**禁止重跑任何 AI 阶段**——重跑会让人确认过的东西失效               |
| `clarification-answer`（反问等作答）              | 答案是**新输入**，上游理解必须更新 | 使 `comprehend` 及其下游产物**失效并重跑**；只继承取内容、建工作树这类与答案无关的前置 |

`awaiting` 行记录 `waitKind`，唤醒时据此选策略。共同规则：

- 被继承的阶段其产出从上一轮的阶段快照读取（存在 `code_round_stages`），标记为 `inherited`；
- 新一轮按新 `roundSeq` 记账；
- 契约里没为某个 `waitKind` 声明恢复策略的能力，不允许以该原因进入 `awaiting`（保存期校验）。

`mr-comment-fix` 的 `resumeFrom = verify-baseline`；`requirement` 的反问唤醒 `resumeFrom = comprehend`
（反问的答案是新输入，理解必须重做，但取内容与建工作树不必）。契约里没声明 `resumeFrom` 的能力
不允许进入 `awaiting`（保存期校验）。

**光有 `resumeFrom` 还不够——被确认的那份改动必须先落成不可变产物。** 新一轮拿到的是**新 worktree**，
而作者确认的是上一轮生成的那份确切 diff；若不持久化，`verify-baseline → push` 手里根本没有可推的
东西，而重新生成又不再是作者点头的内容。故进入 `awaiting` 之前，`post-patch` 阶段必须：

1. 把改动固化为不可变产物——**一个 detached commit**（推荐，天然带 tree 与 parent）或 patch blob；
2. 记录 `pendingArtifact = { ref, digest, baselineSha }` 到 Round；
3. 回帖里带上 digest 的短标识，确认关键词绑定它。

唤醒后 `verify-baseline` 校三件事：远端 head 仍是 `baselineSha`、artifact 仍存在、digest 匹配；
`push` 只**物化并推送这份确切产物**，不重新生成。artifact 的保留期与工作项同寿，`closed` 时清理。

### 2.3 轮次（Round）

一轮 = 一次 `queued → running → 终态`，物化为**一个 task**。轮次记录：

```
roundSeq          从 1 递增，永不复用
capability        本轮执行哪条能力
templateRef       本轮用的框架版本 + 绑定版本（快照，非引用——中途改配置不影响在跑的轮）
baselineSha       本轮基于哪个 commit（awaiting 作废判定、position 组装都要它）
epoch             抢占代际；publish/push 前复检自己仍是当前 epoch（§2.2 不变量一）
pendingArtifact   进入 awaiting 前**必须**持久化的不可变产物 + digest（见下）
workPackage       仲裁脚本返回的本轮工作包（可含多项，E8）
taskId            task-execution 侧的 id
stageContractVer  本轮使用的阶段契约版本
```

### 2.4 意见与台账（Finding / Ledger）

```
fingerprint    sha256(normalize(file) + ':' + symbolOrHunkDigest + ':' + normalize(body核心))
                行号**不进指纹**：代码一动行号就变，进指纹会让同一问题反复重提。
                但**光去掉行号会走过头**（设计门 P1）：同一文件里两个函数各缺一次空值判断、
                agent 对两处生成了相同正文时，两条会撞成同一指纹，其中一条被静默吞掉——
                而"一次提出多条精确的行级问题"正是本能力的核心承诺。
                故补一段**位置无关但出处有别**的摘要 symbolOrHunkDigest：优先取所属符号
                （函数/类名，由 codeIntel 提供），取不到则退化为该 hunk 的上下文摘要。
                它在代码位移时保持稳定，在"同文件不同处"时区分得开。
externalId     发布后拿到的 comment/thread id
publishedRound 首次发布于哪一轮
resolvedAt     信号一：线程被 resolve
codeChangedAt  信号二：下一轮发现该锚定行的代码实际变了
degradedReason 未能锚定到行时的原因（行不在 diff / 文件不在 MR / 基线漂移）
```

两个采纳信号**分列存储、不合成单一指标**（proposal C6）。

#### 台账为何与工作项解耦

检视有**两条触发路径**（proposal E1：webhook 直接触发 / 监视器仲裁后派发），而 §2.1 又把
`mr-review` 与 `mr-monitor` 定为两个工作项。若台账键含 `workItemId`，两条路径就各记各的账，
**同一个问题会被提两次**——去重直接失效，而这恰恰是本能力最影响体验的一环。

故台账键**直接复用 §2.1 的稳定 anchor**：`(codeHostEndpointId, stableProjectId, anchorKind,
anchorId, fingerprint)`——它锚定的是**那个 MR**，不是"哪个工作项跑的这一轮"。

初稿这里写的是 `(provider, projectRef, …)`，两路设计门同时指出这是**只改了一半**：工作项身份
换成稳定键了，台账却还用可变路径。后果——仓库转组后旧台账整批失联，下一轮把未解决的 20 条意见
全部重发；而若 `projectRef` 取平台内数字 id，两个 endpoint 上的同 id 又会撞车。路径与 URL 一律
只作展示快照。

`workItemId` / `roundSeq` 仍作为普通列记录来源，供追溯与状态图展示。`settle-stale` 要处理的
「上一轮线程」同样按稳定 anchor 查，与工作项无关。

#### 终局采纳比对（否则度量系统性偏低）

`codeChangedAt` 靠「下一轮比对锚定行是否变化」得到。但 MR 合并后**没有下一轮**——最后一轮提的
意见永远拿不到这个信号，而最后一轮往往正是作者最认真处理的那一轮。这会让采纳率**系统性偏低**，
而 proposal B2 拍板的「跑稳了再加码」正要靠这个数据做决策，偏低会导致错误结论。

故工作项进入 `closed` 时补一次终局比对：拉合并后的最终 diff，对本 MR 全部未标记 `codeChangedAt`
的意见做一次锚定行比对并回填。这一步是程序、无 AI，失败只记事件不影响闭环。

### 2.5 模板：两层

```
CapabilityFramework（部门层）        CapabilityBinding（小组层）
  scripts: {entry, collect,            frameworkRef      ← 一个能力只引用一个框架
            classify, arbitrate}       agentBySlot: {}   ← 每个 AI 步骤用哪个 agent
  hooks: [{stage, phase, script,       promptBySlot: {}
           blocking}]                  params: {}        ← 覆盖框架默认值
  paramDefaults: {}                    paramSchema 由框架声明、平台渲染表单
  stageContractVer
```

两者都是资源（owner / visibility / grants / 复制 / 配置包导出）。`CapabilityFramework` 的写权限
额外要求 `scripts:author`——它承载脚本与钩子，等于 daemon 全凭据面（proposal C2）。

## 3. 数据模型

新增表（全部落在 `code-capability/infrastructure`）：

| 表                       | 要点                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_work_items`        | 身份键唯一索引；`status`；`currentRoundId`；`anchorMeta`（MR/issue 元信息快照）；`initiatorUserId`（C3 的"事实作者"）；`closedAt`                                                                                   |
| `code_work_rounds`       | `workItemId` + `roundSeq` 唯一；`taskId`；`baselineSha`；`workPackage`；`templateSnapshot`；`stageContractVer`；`outcome`                                                                                           |
| `code_round_stages`      | 每阶段一行：`stageName`、`status`、`startedAt/endedAt`、聚合计数                                                                                                                                                    |
| `code_ai_attempts`       | **每次 AI 调用一行**（设计门 P2）：`roundId`、`stageName`、`shardKey`、`sessionRef`、`rerunSeq`（换会话重跑第几次）、`attemptSeq`（同会话重试第几次）、`validationOutcome`、`status`、时间、关联 nodeRun/session id |
| `code_findings`          | 台账，见 §2.4；唯一键 **`(codeHostEndpointId, stableProjectId, anchorKind, anchorId, fingerprint, generation)`**，**不含 workItemId**；带 `lifecycle` 状态与 `createdAt/lastSeenAt/closedAt` 及仓库+时间索引        |
| `capability_frameworks`  | 部门层模板资源                                                                                                                                                                                                      |
| `capability_bindings`    | 小组层模板资源                                                                                                                                                                                                      |
| `repo_capability_config` | 仓库 × 能力矩阵：`repoId` + `capability` 唯一，指向一个 binding，带启用开关与触发配置；另存 `readiness` 派生态（见 §3.1）                                                                                           |

`initiatorUserId` 是 C3 的落点：bot 开的 MR 上，「作者确认推送」的判定读它而不是 MR 的 author。

`code_ai_attempts` 是 G2 三层状态图第三层的**数据契约**：一个 stage 行无法表达"`review-shard` 有
四个并行调用、其中第二个同会话重试过两次、又换会话重跑过一次"。没有这张表，AC-25 的「每次 AI
调用」不可验收。

它自己也需要状态机与恢复规则（设计门 P2）：唯一键
`(roundId, stageName, shardKey, rerunSeq, attemptSeq)`；状态
`claimed → running → validated | failed | interrupted`。daemon 在写回 `validationOutcome` 前崩溃时，
恢复流程**先把悬挂的 attempt 收束为 `interrupted`**，再分配下一个 `attemptSeq`——否则重复行会让
历史轮次无法重建，而 `attemptSeq` 的分配也会撞车。

### 3.1 首次使用：从「装好了」到「能触发」（设计门 P2）

内置 framework/binding 只是**模板存在**，不等于**能跑**。新仓开了 MR 却毫无动静时，用户无从判断
是没开能力、触发器没建、code-host 没配、还是 agent 不可用——这类"配了但不动、且看不出为什么"
的体验是这类平台最常见的弃用原因。故矩阵每一格计算并显示一个 `readiness`：

| 态              | 含义                                                                                 | 界面动作                                 |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `disabled`      | 该仓未开这个能力                                                                     | 「启用」按钮                             |
| `misconfigured` | 已开但缺前置：无触发器 / code-host 未配 / binding 引用的 agent 不可见 / 框架脚本缺失 | **逐条列出缺什么**，每条给一键修复入口   |
| `ready`         | 前置齐备，等事件                                                                     | 显示上次触发时间；提供「发一个测试事件」 |

「启用」是一次**编排动作**而非单纯写一行配置：选默认 binding → 创建或复核 webhook 触发器 →
校验 code-host 连接与 agent 可见性 → 落 `ready`。AC-24 的"不用写脚本即可跑通"由这条路径兑现。

**`readiness` 必须会失效重算**（设计门 P2）：它是派生态，而它依赖的东西（binding、agent、
framework 脚本、webhook 触发器、code-host 连接、CI wake 入口）都会在启用之后被改动或删除。
没有失效机制的话，一个共享 binding 被删可以让**200 个格子继续显示 `ready`**，而事件到来才失败；
反向也一样——用户修好了缺项却一直停在 `misconfigured`。

规则：优先**按当前依赖实时计算**；若为性能而缓存，则一并保存 `dependencyRevision` 与
`lastValidatedAt`，并订阅所有依赖的变更事件做批量失效。判据**按能力声明**——`ci-fix` 的
readiness 必须包含 pipeline 事件或 wake 入口的可达性，否则会出现"显示就绪、但永远没有唤醒源"
（正是 AC-14d 要防的）。

## 4. 阶段引擎

### 4.1 阶段契约与版本化

每条能力有一个**平台内置、代码内定义**的阶段序列，带契约版本号：

```ts
interface StageContract {
  capability: Capability
  version: number // 阶段集合或语义变化时 +1
  stages: readonly StageDef[]
}
// 判别联合：每种 kind 只能携带自己那组字段，写错即 typecheck 红
type StageDef = StageBase &
  (
    | { kind: 'program' }
    | { kind: 'script'; scriptSlot: ScriptSlot }
    | { kind: 'ai'; aiSchema: JSONSchema; agentSlot: string } // 宪法 R3：schema 必填
    | { kind: 'invoke'; invokes: { capability: Capability; from: string; to: string } }
  )

interface StageBase {
  name: string // 公开契约，钩子按它挂载
  parallel?: boolean // 并行段：钩子整段前后各一次（F5）
  requires: readonly string[] // 需要的前置产物
  produces: readonly string[]
}
```

初稿把 `invoke` 只写在注释里，`kind` 的实际联合仍是三种——于是 `self-review` 既过不了类型也没有
执行分支，PR-8/PR-9 的核心证据链（"自己审自己"）**根本跑不起来**。改为判别联合后，保存期还要校验：
`invokes` 的 `[from, to]` 区间在目标契约里真实存在、不构成递归环、区间的输入输出闭包在父序列里
可满足、取消信号能传播进子序列。

`requires` / `produces` 不是运行期校验（序列写死，运行期无从拼错），而是**开发期**的编译时与
测试期断言：新增或调整阶段时，若某阶段声明的 `requires` 在其上游的 `produces` 并集里找不到，
契约自检测试直接红。它替代的是"靠人记住阶段顺序"。

**`invoke` 步骤——`self-review` 靠它落地。** proposal D7/E7 要求需求实现与 CI 修复都「自己把
改动审一遍」，即复用 `mr-review` 的核心阶段。子序列**不发布到 MR**（`publish` 不在区间内），
它的 findings 直接喂给父序列的下一步。钩子按 `<父阶段>/<子阶段>` 命名挂载。

**它和 per-shard 独立树会打架，必须在这里说清楚**（设计门 P1）：`ci-fix` 的 `fix(ai)` 在父工作树
里产生了修改，随后 `self-review` invoke 检视的核心阶段。若照 §6.1 的规则「每个 shard 从
`baselineSha` 建独立树」，各 reviewer 看到的是**修复前**的代码——自审了个寂寞；若让它们共享父
工作树，又违反"并行分片必须互相隔离"。

解法：**进入 `invoke` 前把父工作树冻结为一个不可变 snapshot**（detached commit / tree）。
此后 `baselineSha` 只作 diff 的**左侧**，snapshot 作**右侧**；每个 shard 从 snapshot 各建独立树。
于是三件事同时成立：审的是本轮真实改动、分片之间互不可见、重复执行结果一致。`invoke` 的契约
因此必须显式携带：区间 `[from,to]`、输入 diff 的左右两侧、工作树根、产物回流方式。

`kind` 字段不是注释而是**强制约束**：`kind: 'program'` 的阶段其实现不得调用任何 agent 派发
（源码层负扫描锁定，AC-10）。

#### 实现偏离（PR-1b 落地时按仓内实践确定，2026-08-15）

`aiSchema` 的**表示形式**改为 **zod schema**，而非手写 JSON Schema 对象。理由是本仓没有 JSON
Schema 校验器（无 ajv 等依赖），既有实践是**zod 为事实源、JSON Schema 为导出产物**——`mcp/
resourceSchemas.ts` 即以 `zodToJsonSchema` 导出给外部。若按字面写手写 JSON Schema，等于为本 RFC
单独引入第二套 schema 体系与一个新依赖。

**对外行为不变**：给 AI 的提示里仍带 JSON Schema 文本（由 `zodToJsonSchema` 导出），平台仍在
**下一步之前**校验（R3），校验失败仍按 R4 两级重试。变的只是「schema 在代码里长什么样」。

钩子声明它针对的 `stageContractVer`；平台升版后，声明旧版本的钩子**显式报需要迁移**而不是静默
跳过（F9 / AC-23）。

### 4.2 确定性守卫（宪法 R3/R4/R5）

`DeterminismGuard` 包住每个 `kind: 'ai'` 阶段：

```
run AI step
  → 提取 envelope（复用 services/envelope.ts 的 extractLastEnvelope + nonce）
  → ①结构校验：按 aiSchema 校验形状、必填、枚举、类型
  → ②语义合法性：severity 在闭集内、file 非空、line 是正整数……
  → 不通过 ⇒ 带**具体错误**同会话重试（≤ N 次）
              ⇒ 仍不过 ⇒ 丢弃会话、换新会话重跑（≤ M 次）
              ⇒ 两级耗尽 ⇒ 阶段失败
  → 通过 ⇒ 产出确定值，进入下一阶段
```

**「行号锚不到 diff」不属于校验失败**（设计门 P1）。初稿把它写进领域校验，于是同一条 finding 同时
落进两种互斥终态：AC-3 说它应该降级进总览、计入 `degraded`、节点仍算成功；而校验失败按 R4 会触发
重试直至阶段失败。两者不能同时成立。

拆开：

| 情形                                                        | 归属         | 处理                                             |
| ----------------------------------------------------------- | ------------ | ------------------------------------------------ |
| 结构不合 schema、字段缺失、severity 不在闭集                | **校验失败** | R4 两级重试，耗尽则阶段失败                      |
| 结构合法，但该行不在本次 diff 的 hunk 内 / 文件不在改动集合 | **锚定失败** | 不重试；标 `degraded` 并入总览评论，阶段**成功** |

判据：**AI 把话说得不对**是校验问题（它能改），**AI 把话说在了别处**是锚定问题（重试也不会变好，
而且那条意见本身可能是对的，值得以降级形态保留）。`validate-findings` 阶段只做前者，锚定判定属于
`resolve-positions`。

同会话重试与换会话重跑的区别是有意的：前者便宜且保留已读代码的上下文，后者跳出已经跑偏的上下文。
nonce 沿用脚本/agent 同一套（`services/scriptPorts.ts` 的注释已明确 nonce 防的是上游内容伪造，
不防作者本人——对钩子注入数据而言这正是所需语义）。

### 4.3 钩子执行

- **位置**：每个阶段边界 `pre:<stage>` / `post:<stage>`；并行段整段前后各一次（F5）。
  **这条选择的后果要写明**：`review-shard` 是并行段，它的 `pre` 钩子在拆块之后、所有分片启动之前
  跑一次，因此钩子**拿得到分块结果、但无法为某一块单独定制提示词**——per-shard 定制不在本 RFC。
  需要按块差异化时，当前的表达方式是在 `pre` 钩子里按块生成内容写进工作树，由各块 agent 自行读取。
- **执行机制**：复用 `services/scriptRun.ts` 的 `assembleScriptEnv` + 受管子进程，**不复用 script 节点**（D4）。
- **上下文**（F10）：环境变量给工作项基本信息（`AW_CWI_*`：capability / anchor / round / baselineSha /
  worktree / repos），当前阶段的输入输出走文件（大对象如 findings 列表 spill 到 `AW_INPUT_DIR`）。
- **权力**（F6）：
  - 副作用——直接改工作树；
  - 注入数据——envelope 输出，平台按阶段定义的可注入字段白名单合并（如 `promptSuffix`、`extraContext`）；
  - 中止——非零退出且声明了 `blocking: true` ⇒ 本轮失败。
- **失败语义**（F8）：每个钩子自己声明 `blocking`。非阻断钩子失败只记事件。

## 5. MR 监视器

### 5.1 主循环

```
外部事件（MR / note / pipeline webhook）
  → 唤醒工作项（不轮询，N7/E3）
  → collect   脚本：拉全量状态（含自研流水线门禁）      → CollectResult
  → classify  脚本：把失败日志分类                      → Issue[]
  → arbitrate 脚本：按优先级选出本轮工作包（可多项）     → WorkPackage
  → select    脚本：为工作包选 agent 与提示词           → AgentPlan
  → 起一轮（一个 task），依次做完这批，统一推送一次      （E8）
  → 回到唤醒等待
闭环：MR 合并 / 关闭 → closed
```

四个脚本全部由**部门层框架**提供；平台只定 schema、不猜实现（§3.1 外部系统适配原则）。
默认优先级（框架未覆盖时）：冲突 > 评论 > CI；CI 内：编译 > codecheck > UT 覆盖率（E6）。

#### 唤醒源：一个必须说破的前提（设计门 P1）

上面这条链有个隐含前提——**必须有一个事件把监视器唤醒**。采集脚本只在被唤醒后才跑，而 N7 又
禁止轮询。于是：

- 若自研流水线**由 GitLab CI 触发**（GitLab 侧有 pipeline 对象，实际执行在自研系统），
  `pipeline_failed` 事件正常到达 ⇒ 链路成立，这是用户拍板 E3 时所指的形态。
- 若自研流水线**完全独立于 GitLab**（不产生任何 GitLab/GitHub pipeline 事件），
  则**没有任何东西会唤醒监视器，CI 修复循环永久停住**——脚本是采集器，不是入站唤醒源。

故本 RFC 保留一条**唤醒入口合同**：自建系统可 `POST` 一个 wake 请求（携带
provider / project / MR / run revision），平台据此唤醒一次 collect。它**只负责唤醒**，不携带
业务判断，也不构成轮询（与 N7 不冲突）。若部署侧两种唤醒源都没有，则该仓的 CI 修复能力在
配置矩阵里**标为不可用并说明原因**，而不是配好了却永远不动。

> ✅ **已确认（2026-08-15，proposal §6ter-H1）**：贵司自研流水线**由 GitLab CI 触发，GitLab 侧
> 有 pipeline 对象**——即上述**第一种**。唤醒链路天然成立，你们的流水线**不需要做任何改动**。
> 因此 wake 入口**降为可选**：仍按合同实现（它是 readiness 判据的一部分，也为将来可能出现的
> 独立流水线预留），但不构成 CI 修复能力上线的前置。PR-9 范围不变。

### 5.2 脚本契约

```ts
// collect —— 输入：工作项上下文（env）。输出（envelope）：
interface CollectResult {
  conflict: boolean
  unresolvedComments: Array<{ threadId: string; author: string; body: string; anchor?: Anchor }>
  gate: { status: 'pass' | 'fail' | 'running' | 'unknown'; runId?: string; rawLogRef?: string }
  headSha: string
}
// classify —— 输入：collect 的 gate + 日志。输出：
interface ClassifiedIssue {
  type: string
  file?: string
  line?: number
  message: string
  raw?: string
}
// arbitrate —— 输入：CollectResult + ClassifiedIssue[]。输出：
// 一包**必须同 capability**：Round.capability 与 StageContract.capability 都是单值，
// 混合包（一个评论修复 + 一个 CI 修复）无法决定本轮走哪条序列，也无法定义统一的 push 边界。
// 故用 discriminated union 在 schema 层强制同类，跨类只能分轮（设计门 P1）。
type WorkPackage =
  | { capability: 'noop'; reason: string; observedRevision: string }
  | { capability: 'mr-comment-fix'; items: Array<{ threadId: string }>; note?: string }
  | { capability: 'ci-fix'; items: Array<{ issueRef: string }>; note?: string }
  | { capability: 'mr-review'; items: []; note?: string }
// select —— 输入：WorkPackage。输出：
interface AgentPlan {
  bySlot: Record<string, { agent: string; promptSuffix?: string }>
}
```

四者**全部是脚本，无 AI 参与**（宪法 R1，AC-10 源码层锁定）。

**`noop` 是一等结果，不是异常**（设计门 P1）。绝大多数唤醒其实无事可做——pipeline 转绿、普通
评论、无待处理项的 update。按 50 个活跃 MR、每个每天 3 次这类事件算，一天就是 **150 次健康唤醒**。
初稿的 union 里没有 `noop`，仲裁脚本只剩两条路：返回非法空值（被 schema 拒绝 ⇒ 阻断 ⇒ 告警风暴），
或伪装成 `mr-review`（凭空起 150 个 task 并在 MR 上留下 150 条"本轮无新增意见"）。两条都是错的。

`noop` 的语义：**不创建 `code-round` task、不在 MR 上说任何话**，只把本次采集结论落成一条可查询
的 observation（供排障链与"上次触发时间"用）。

## 6. 阶段序列（内置）

### 6.1 `mr-review`

```
resolve-target(program) → prepare-worktree(program) → fetch-diff(program)
→ split-diff(program) → review-shard(ai, parallel) → review-global(ai)
→ validate-findings(program) → gate(program) → resolve-positions(program)
→ reconcile(program) → publish(program) → settle-stale(program) → ledger(program)
```

#### `reconcile` / `settle-stale`：为什么不是「去重 + 清理上轮」

初稿写的是 `dedupe`（同指纹不重发）+ `cleanup-previous`（resolve 上轮未解决线程），设计门指出这个
组合会**丢掉反馈**：第一轮提了一个问题、作者没改，第二轮再次发现它——`dedupe` 因指纹相同不发布，
`cleanup-previous` 又把上轮那条线程 resolve 掉。结果**代码问题仍在，MR 上却一条活跃意见都没有**，
而这恰恰是最需要被看见的情形。

改成对**三个集合**做对账（`reconcile`），并把清理挪到发布成功之后（`settle-stale`）：

对账的「台账侧」**只取 `lifecycle = 'active'` 的行**（下方状态机），否则会把早已消失的旧问题
误判为"持续存在"。

| 集合                                 | 判定                                    | 动作                                                                        |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------- |
| **持续存在**（本轮有、台账 active）  | 指纹命中且仍能锚定                      | **不重发**，但**保持原线程未解决**；位置漂移则更新锚定行；刷新 `lastSeenAt` |
| **新增**（本轮有、台账无 active 行） | 指纹未命中，或命中的是 `disappeared` 行 | 发布；后者以 **新 generation** 发布并把旧行标 `reappeared`（见下）          |
| **已消失**（台账 active、本轮没有）  | 本轮结果里找不到该指纹                  | 走 `active → disappeared` **状态边沿**动作，只做一次                        |

#### finding 生命周期：状态边沿而非每轮重复

两路设计门同时指出初稿的两个洞：**已消失的问题再次出现时会被当成"持续存在"**（台账里有行 ⇒
不重发），于是当前真实存在的问题**没有任何活跃线程**；以及 **GitHub 侧每轮都会追加一条"已不再
出现"**——一个推送 80 次的 MR 上，同一条线程会收到 78 条同义回帖，把三方讨论淹掉。

故显式建模：

```
active ──本轮未出现──► disappeared ──再次出现──► reappeared（= 新 generation 的 active）
   ▲                        │
   └────────────────────────┘  只在**状态发生变化的那一轮**执行外部动作
```

- `active → disappeared`：**仅此一次**执行 provider 动作（GitLab resolve / GitHub 追加一条回复）；
  之后各轮该行保持 `disappeared`，**不再有任何外部动作**。
- `disappeared → reappeared`：以**新 generation** 发布一条新意见（旧线程已 resolve/已标注，
  复用它会让人困惑），并把旧行终结。
- 唯一键含 `generation` 正是为了容纳重现。

**GitHub 上 resolve 做不到**（设计门 P1）：`thread.resolve` 在动作注册表里对 GitHub 显式标了
`unsupported`（`packages/shared/src/codeHost/actions.ts:315`，reasonKey `graphqlOnly`）——REST 面
没有该端点，GraphQL 的 `resolveReviewThread` 又需要 REST 拿不到的 `PRRT_` 线程 node id。批量化
一个 unsupported 的 binding 不会让它变可用。故 `settle-stale` 是 **provider-specific** 的：

- **GitLab**：按上表 resolve 已消失的线程。
- **GitHub**：无法 resolve ⇒ 改为在该线程下**追加一条"此问题在最新一轮已不再出现"的回复**，
  并在台账标 `disappearedRound`。线程仍是 open 的，但读者能看到状态；这是 REST 面能做到的上限。

对应地 AC-6 必须写成 provider-specific 的两套判据，不能一句"上轮线程被 resolve"了事。
（若将来接入 GitHub GraphQL 并持久化 thread node id，可把 GitHub 也升到真 resolve——列入 §11。）

顺序也是判据的一部分：`settle-stale` 必须在 `publish` **成功之后**才执行——发布失败时保留上一轮的
last-known-good 反馈，绝不能出现「新的没发出去、旧的已经被关掉」的空窗。

- `split-diff`：按目录层级聚合，受行数上限约束（B7）。同目录改动尽量同块；超限再切。**确定性**：
  同一 diff 必然得到同一分块（供重跑复现）。
- **每个 shard 一棵独立的一次性工作树**（设计门 P1）。B6 要求并行、B8 允许 agent 试改并跑测试——
  两者组合下若共用一棵树，多个 shard 会互相看到甚至覆盖对方的临时改动，同一份输入重复执行会得到
  不同的测试结果与 findings，**直接违反宪法 R5 的确定性**。故各 shard 基于同一 `baselineSha` 各建
  一棵可写树，**全部禁止 merge-back**，跑完即弃。代价是磁盘与建树开销随分片数线性增长，因此分片
  数受 `split-diff` 的上限约束。
- `review-shard` 的 worktree 是可写一次性树（B8）；agent 可跑测试甚至试改。
  **行号锚定**：`fetch-diff` 产出的原始 diff 是唯一锚定基准，agent 自身改动不影响锚定（AC-4）——
  实现上 `validate-findings` 用 `fetch-diff` 的产物校验，不读当前工作树状态。
- `gate`：先按 (severity, file, line) 确定性排序，再按阈值过滤、按上限截断。
- **@叫但 sha 未变时**：仍然正常跑一轮（不静默跳过——人 @ 了却毫无动静是最差的体验），
  台账去重会让绝大多数意见不重发，总览评论显式写明「本轮无新增意见，上轮的 N 条仍未解决」。
  这样"机器收到了"与"没有新问题"两件事都传达到了。

#### fork MR / PR：两处会静默断掉（设计门 P1 ×2）

初稿假定「事件里的 branch 就是能 checkout 的 ref」，这在同仓 MR 上成立，**跨 fork 时不成立**：

1. **源分支不在目标仓里。** 两家 adapter 都从**顶层** `repository` / `project` 取仓库 URL
   （`githubAdapter.ts:143`、`gitlabAdapter.ts:108`），而 branch 取自 `pull_request.head` /
   `source_branch`；GitLab 官方也明确顶层 `project` 是 **target** project。dispatch 随后把该 branch
   当 ref 用（`webhookDispatch.ts:372`）。fork 场景下 target clone 里根本没有那个分支，
   `fetch --all` 也只抓 target remote——非 shallow 救不了「另一个仓库的 ref」。
   **对策**：归一化并冻结 **source project 的 clone URL + head SHA**；`prepare-worktree` 按
   source remote 精确 fetch head ref。两家的 fork MR/PR 必须各有一条端到端用例。
2. **fork PR 的 CI 事件找不到 MR。** `githubAdapter.ts:447` 已记录：fork PR 的
   `workflow_run.pull_requests[]` 为空，此时 `mrIid` 缺失，且该行为被
   `tests/rfc259-github-adapter.test.ts:291` 锁定。而工作项身份要求 `anchorId`。
   **对策**：以 head SHA 反查该仓当前开放的 PR 建立映射（带缓存）；命中唯一才唤醒对应工作项，
   零命中或多命中时**不唤醒**并记事件——绝不按 branch 另起一条与既有台账无关的流。

两条都属于"不处理就静默失效"的形态：用户看到的是"机器对 fork 的 MR 从来不响应"，而日志里只有
一条 `repo-ref-not-found` 或什么都没有。

### 6.2 `mr-comment-fix`

```
resolve-target → collect-thread(program) → prepare-worktree → apply-change(ai)
→ validate-change(program) → decide-form(program) → publish-suggestion(program)
                                                 ↘ post-patch(program) → [awaiting]
                                                     ← 人回关键词 → verify-baseline(program) → push(program)
```

`decide-form`（B/C1）：改动限于单文件且连续行数在阈值内 ⇒ 走原生 suggestion（无需写权限）；
否则走贴 diff + 等确认。`verify-baseline` 在推送前校远端 sha，变了就放弃（C7）。

**suggestion 路径的收束**：发出即转 `settled`，**不追踪单条 Apply**。人点没点 Apply 由代码平台
自己管（GitLab/GitHub 应用 suggestion 后是否自动 resolve 线程取决于各自设置，平台不做假设也不轮询）。
工作项随 MR 终态闭环。这条要写明，否则实现时容易为了"检测 Apply"去加轮询，与 N7 冲突。

### 6.3 `requirement`（issue 修复 + 设计文档实现，合并）

```
resolve-input(program|script) → materialize-attachments(program) → prepare-worktree
→ comprehend(ai) → [信息不足 → clarify(program) → awaiting]
→ implement(ai) → run-target-gate(program) → self-review(复用 mr-review 的核心阶段)
→ open-mr(program) → ledger
```

`resolve-input`：参数够用则直接进；只给了引用（如 issue 编码）则跑入口脚本取回
`{title, body, attachments, writebackHandle}`（D5）。

**"一组"设计文档，不是一份**——用户的原话是「给定**一组**设计文档实现代码并提交形成 MR」，
而本仓自己的 RFC 就是三件套（proposal / design / plan）。故输入契约是**文档集合**：

```
documents: Array<{ name, role?, content | attachmentRef }>   // role 如 'proposal' | 'design' | 'plan'
```

- 多份文档**按给定顺序**进入 agent 上下文，`role` 只作提示不作强制（各公司文档体系不同）；
- 文档之间的交叉引用（"见 design §4"）由 agent 自行解析，平台不做链接推断；
- 体量超限时**不静默截断**——`comprehend` 阶段显式报"文档集合超出上下文预算"，
  并在回执里列出各文档大小，由人决定拆分或精简。这比截断后实现错东西好得多。

一份设计仍**永远产出一个 MR**（D6），文档是多份不改变这一点。`clarify` 按 D2 分流：有 `writebackHandle`
且框架实现了回写 ⇒ 回写 issue 评论。

**按发起来源硬分流，没有兜底**（设计门 P1：此处原有一句"否则落平台 clarify"，与 AC-14c
「issue 侧双向通道不可用时拒绝启用该入口」直接矛盾）：

| 发起来源                | 反问落点                | 通道不可用时                             |
| ----------------------- | ----------------------- | ---------------------------------------- |
| issue 标签              | **只能**回写 issue 评论 | **拒绝启用该入口**并说明原因，不静默回退 |
| `/code` 界面 / 平台 API | 平台 clarify            | —                                        |

理由就是用户拍板的 D2 原文——「从哪进就从哪问」。若允许 issue 发起的反问落到平台，报告人会
一直盯着 issue 等问题，而问题出现在他可能根本没有账号的 `/code` 上。

**闭环回链（否则这个工作项永远闭不了环）**：本能力的 `anchorRef` 是需求侧标识（如 `issue-88`），
而它的闭环条件是**产出的那个 MR 被合并**——MR 事件里没有需求标识，无法路由回来。故 `open-mr`
阶段必须做两件事：①把新 MR 的 provider/project/iid 写回工作项 `anchorMeta.producedMr`；
②注册一条 `(provider, projectRef, mrIid) → workItemId` 的反向索引。MR 终态事件到达时先查这张
反向索引，命中则同时推进 `requirement` 工作项到 `closed`。反向索引同时供状态图展示「这个 MR 是
哪个需求产出的」。

### 6.4 `ci-fix`

```
collect(script) → classify(script) → arbitrate(script) → select(script)
→ prepare-worktree → fix(ai) → validate-fix(program) → self-review(ai)
→ anti-cheat-check(program) → push(program) → ledger
```

`anti-cheat-check`（E7）——**要诚实说清哪一半是程序、哪一半不是**：

| 判据                                                             | 谁来判                    | 强度               |
| ---------------------------------------------------------------- | ------------------------- | ------------------ |
| 本轮 diff 是否删除断言 / 新增 skip / 测试行净减少 / 放宽断言常量 | **程序**（diff 结构分析） | **硬**：命中即拦下 |
| 命中之后，"这个测试本来就该挂"是否成立                           | **判不了**                | 见下               |

第二行是关键：程序**无法**验证一段论证的正确性。若只做"要求 envelope 里带论证、检查论证字段
非空"，那等于**把判断权交还给了 AI 的自述**——AI 只要写一段话就能过，与宪法 R1/R2 的精神相悖。
初稿正是这么写的（"缺论证则本轮失败"），实为把软约束伪装成硬检查。

真实的防线因此是三层，按强度排列：

0. **程序化的 red-before / green-after 实证**（唯一有裁决力的一层，设计门第三轮 P1 补）：
   命中结构判据时，用**冻结的基线**与**冻结的修复产物**各跑一次目标测试：
   - 基线上该测试**确实失败**、修复后**通过** ⇒ 修复是真的，放行；
   - 基线上该测试**本来就通过**（即它是被这次改动弄挂或直接删掉的）⇒ **判失败**，不放行；
   - 测试无法机械重跑（环境依赖、非确定性）⇒ 不猜，转人工。

   这一步把"证明"从 AI 的自述变成**可复跑的事实**，正是宪法 R1 要求的"能程序判定的就程序判定"。

1. **程序硬拦**：red-before/green-after 无法实证时，本轮**不自动推送**，转人工确认
   （`awaiting`，`waitKind = frozen-artifact-confirmation`）。
2. **独立上下文复审**：`self-review` 用的是**另一个会话**、看的是本轮 diff——删掉一个断言在它眼里
   是显眼的高严重度问题。这层不保证必中，但它不是自评。
3. **论证进 MR 描述**：要求 AI 写明理由，但**它的作用是给人看**，不是给程序判。缺论证不构成
   通过与否的判据，只是描述不完整。

用户拍板 E7 选的正是"跑一遍检视 + 要求证明"这两条软约束（**没有**选两条硬禁止），本节忠实于此：
硬拦只用于"不自动推送"，不用于"判定论证真伪"。

**「3 轮」的计数范围**（E9）：计数键是 **`(工作项, 失败指纹)`**，不是工作项生命周期。失败指纹由
`classify` 的产出归一化而来（错误类型集合 + 首个错误的文件与消息）。作者自己推了新代码导致**另一个**
失败时指纹变化 ⇒ 配额重新计数；同一个失败反复修不好才吃配额。若不这样定，一个活得久的 MR 会在
第三次遇到任何 CI 问题时就永久失去自动修复，而用户完全不知道配额是什么时候被谁用掉的。
配额耗尽后回帖汇总每轮尝试，并**在总结里写明配额已用尽及重置条件**。

### 6.5 `mr-monitor`

不是线性序列，是 §5.1 的循环。它的每一次"起一轮"派发到上面四条之一。

## 7. 行级定位与批量发布

### 7.1 position 组装（程序，无 AI）

```
GitLab   拉 GET /projects/:id/merge_requests/:iid → diff_refs{base_sha,start_sha,head_sha}
         新增行 → {position_type:'text', new_path, new_line, ...diff_refs}
         删除行 → {position_type:'text', old_path, old_line, ...diff_refs}
         上下文行 → old_path+old_line 与 new_path+new_line **同时**给（待实证 §10-2）
GitHub   {path, line, side, start_line?, start_side?}；commit_id 由 review 统一给
```

锚定判定完全基于 `fetch-diff` 的产物：行必须在本次 diff 的 hunk 覆盖范围内。不在 ⇒ `degraded`。

### 7.2 批量发布

```
GitLab   逐条 POST draft_notes（失败即整体放弃并清理已建草稿）→ 一次 bulk_publish
GitHub   一次 POST /pulls/{n}/reviews，body=总览，comments[]=行级意见
```

**部分失败语义**：草稿阶段任一条失败 ⇒ 删除本轮已建草稿、整轮失败，MR 上不留半截（B10 的
"一次性发布"在失败路径上同样成立）。锚不上的意见并入 `body` 总览（B11）。

#### 发布意图必须可恢复（设计门 P1）

`publish` 成功之后、`settle-stale` / `ledger` 之前，若被抢占或 daemon 崩溃，远端评论**已经存在**
而台账里还没有它们的 external id。下一轮对账会把同一批 finding 当成"新增"**再发一次**——用户看到
的是同样的意见被贴了两遍。

故发布不是"一个动作"，是**带持久化意图的两段式**：

1. **发布前**持久化一条发布意图：本轮 `batchId` + 待发指纹清单 + 目标 anchor + epoch；
2. 远端调用成功后，**先原子写回 external id**（含 `batchId`），再允许响应取消或推进下一阶段；
3. 重启恢复时，对处于"意图已写、结果未写"的批次**按 `batchId` 核对远端**（GitLab 查该 MR 的
   draft/notes、GitHub 查 review），已存在则补齐 id，不存在才重发。

`settle-stale` 同理逐项落幂等状态（哪条已执行边沿动作），不能只依赖最后的 `ledger` 阶段——
否则中途中断会让一部分线程被处理两次。

**被抢占取消时同样要清理。** 抢占可能正好落在「草稿已建、bulk_publish 未发」这个窗口里，
若只按"取消 task"处理，MR 上会留下一批**永不发布的孤儿草稿**，而且它们对用户可见、看起来像
bot 发了一半就跑了。故：

- `publish` 阶段登记一个**取消补偿**：取消信号到达时先删除本轮已建草稿，再让 task 退出；
- GitLab 侧的草稿是可枚举的（按 MR + 作者），补偿失败时下一轮的 `cleanup-previous` 兜底清理；
- GitHub 侧不存在这个窗口（单请求提交整份 review），无需补偿。

## 8. 权限与凭据

| 面                   | 判据                                      | 说明                                 |
| -------------------- | ----------------------------------------- | ------------------------------------ |
| 配置仓库 × 能力      | 该仓库的管理权（走既有仓库 ACL）          | 不新增权限体系（G6）                 |
| 编辑小组层 binding   | 该 binding 资源的写权 + 引用的 agent 可见 | 普通资源 ACL                         |
| 编辑部门层 framework | 资源写权 **且** `scripts:author`          | 承载脚本与钩子 = daemon 全凭据（C2） |
| 叫机器发 suggestion  | 代码平台侧对该仓有写权限                  | 反查平台权限（C2）                   |
| 叫机器推送           | MR 作者；bot 开的 MR ⇒ `initiatorUserId`  | C3                                   |
| 平台 API 发起        | 普通 PAT + 对目标仓的可见性               | 发起不涉及特权配置                   |

**凭据边界不变**：agent 进程的 `SAFE_FORWARD_ENV` 白名单逐字节不动（N5 / AC-20）；一切需要凭据的
外部访问都发生在**脚本**里（脚本继承 daemon 环境，`services/scriptRun.ts:325`）或**平台代发**
（code-host 调用，RFC-269 的 token 密封路径）。

## 9. 失败模式

| 场景                                                         | 处理                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 输出不合 schema                                           | R4 两级重试；耗尽则阶段失败（AC-8）                                                                                                                                                                                       |
| **钩子**非零退出                                             | 按该钩子声明的 `blocking` 决定阻断或记事件（F8）                                                                                                                                                                          |
| **核心适配脚本**（entry/collect/classify/arbitrate）非零退出 | **一律阻断本轮**，`blocking` 字段对它们不适用。理由：它们产出的是后续阶段的必需输入——`collect` 失败就没有 `CollectResult`，`classify` 在 R5 下无从继续。允许"非阻断"等于允许用空产物往下跑，与确定性宪法冲突（设计门 P2） |
| `diff_refs` 拉不到                                           | 整轮失败；MR 静默、平台告警（B17）                                                                                                                                                                                        |
| 全部意见都锚不上                                             | 仍发布一条总览评论，`published=0 / degraded=N`，轮次算成功                                                                                                                                                                |
| 草稿部分失败                                                 | 清理已建草稿、整轮失败，MR 上不留半截（§7.2）                                                                                                                                                                             |
| 推送时远端已变                                               | 放弃并回帖请重叫（C7）                                                                                                                                                                                                    |
| 等待期间源分支变化                                           | 工作项从 `awaiting` 作废回 `settled`，回帖说明（§2.2）                                                                                                                                                                    |
| daemon 重启                                                  | 轮次是 task ⇒ 复用既有 interrupted 修复；工作项状态由轮次终态驱动重算                                                                                                                                                     |
| 抢占时旧 task 尚未清理完                                     | 工作项停在 `superseding`，**等旧 task 终态后才开新轮**（§2.2 不变量一）；取消幂等由 task-execution 保证                                                                                                                   |
| 抢占落在发布临界区内                                         | 旧轮赢：事件登记为 `pendingRevision`，临界区结束后再处理（§2.2 线性化点）                                                                                                                                                 |
| `publish` 成功但 `settle-stale`/`ledger` 前崩溃或被取消      | 靠**发布意图**恢复：发布前已持久化批次与指纹，重启时按批次核对远端结果并补齐 external id，不重发（§7.2）                                                                                                                  |
| 工作项在轮次运行中收到闭环事件                               | 先落 `closing`：epoch +1、发取消、等补偿与 lease 释放；旧 task 终态后才做终局比对并写 `closed`                                                                                                                            |
| 工作项引用的 binding 被删                                    | 轮次用的是模板**快照**，在跑的轮不受影响；下一轮拒绝启动并告警                                                                                                                                                            |

## 10. 与既有机制的耦合点

| 既有机制                    | 耦合方式                                                  | 风险                                     |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| webhook 入站（RFC-257/259） | 订阅归一化信封，新增一条"代码能力路由"                    | 低——不改入站链路                         |
| 任务引擎                    | 每轮起一个 task，新增独立任务类型（G7）                   | 中——需确认任务类型枚举扩展点             |
| code-host 调用（RFC-269）   | 复用动作注册表与凭据；**新增**批量发布与 draft_notes 动作 | 中——动作表新增列                         |
| 脚本执行（RFC-253）         | 复用 `assembleScriptEnv` 与受管子进程                     | 中——需要抽出不依赖 WorkflowNode 的调用面 |
| clarify（RFC-023 家族）     | 反问走 `collaboration.public`                             | 中——需要"外部回写"这条新通道             |
| 配置包（RFC-271）           | 两类新资源接入闭包与 requirements                         | 低——资源框架通用                         |
| 资源 ACL（RFC-099/231）     | 两类新资源按既有六类同构接入                              | 低                                       |

## 11. 长期运行与可运维性

第二轮设计门专门以「半年后会变成什么样」为视角审了一遍，报出的问题都不是边角——它们决定这套
东西会被用起来还是被静音。集中处置如下。

### 11.1 噪音预算与事件归属

按 §8 的六个故事叠加一个普通工作日：一个开发者 3 个活跃 MR × 每天推 3 次 = 9 次检视通知，
加 2 次 reviewer @叫的回复、2 次需求相关、CI 事故两轮——**最低 15 次机器发言**，还没算基线变化
重叫与冲突报告。更糟的是**机器自己的 push 又是一次 MR update**，默认会再触发检视，形成级联。
人会把 bot 静音；一旦静音，真正需要人接手的三轮失败与冲突报告**也一起丢了**。

三条对策：

- **事件归属**：每个 ingress event id 只能被**一个**顶层 capability claim；监视器的派发与直接
  触发共享同一 causation id。同一条 note 不再既触发检视又唤醒监视器各跑一次。
- **机器自身 push 打 cause 标记**：⚠️ 用户拍板 E2 是「bot 自动提的 MR **默认同样受监管**」，
  所以这里**不能**默认关掉检视（登记在 §6bis-B 改-5）。折中形态：cause 标记只用于**同因果链
  去重**——若该轮已经跑过等价的 `self-review`（`invoke` 记录可证），则程序化认定该 revision 已被
  覆盖、不再重复检视；**没跑过就照常检视**。这样既压掉级联，又不反转默认监管。
- **单条可更新的总览**：MR 上只维护**一条** bot 总览评论，每轮**编辑它**而不是追加新的；
  行级意见照常独立。另设 MR 级通知预算，超出时只更新总览不产生新通知。

### 11.2 失败可见性：按触发来源分，不再一刀切

proposal B17 / §6bis-⑤ 把"MR 上静默"推广到全部能力，第二轮指出这对**人工指令**是错的：
reviewer @叫改码、作者回确认关键词、issue 打标签，等了半小时毫无动静——他不知道是没收到、
在排队、还是失败了，只会**重复 @叫**，进一步制造轮次与噪音。

初稿的静默路径共八类：① AI 两级重试耗尽 ② 核心适配脚本阻断 ③ `diff_refs` 拉取失败
④ 草稿部分失败回滚 ⑤ binding 被删后拒绝启动 ⑥ fork CI 反查零命中/多命中 ⑦ webhook/wake 丢失
（连工作项都没有）⑧ 非阻断钩子与终局比对失败。

规则改为：

| 触发来源                                                   | 失败可见性                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 自动 webhook（MR 事件、pipeline）                          | **保持 MR 静默**，平台内告警                                                                                       |
| **人工指令**（@叫、确认关键词、issue 标签、平台/API 发起） | **必须有回执**：收到时即创建一条可更新的 receipt（带 operation id），成功/失败都在**同一条消息上更新**，不新增通知 |

⑦ 这类"根本没有工作项"的情形由 §11.3 的排障链兜底。

### 11.3 排障链：`code_trigger_deliveries`

管理员发现"某个仓的检视突然不工作了"时，`readiness=ready` + 上次触发时间 + 测试事件三样东西
在下面这些情形下**全都问不出结果**：webhook 没到、到了但被路由丢弃、fork 映射零/多命中、
卡在全局配额或 MR lease 队列里。

故持久化一条完整链路：

```
received → matched config → routed | dropped(reason)
         → queued(等 lease / 等配额，带队列年龄与排位)
         → round/task → published | failed(reason)
```

统一 correlation id 贯穿始终；`/code` 的"发一个测试事件"必须走**真实 ingress → route → round**
全链，并把断在哪一步直接显示在同一页面上。

### 11.4 数据寿命

一个仓 50 个活跃 MR、每个每天 3 轮，180 天 = **27,000 轮**；仅 `mr-review` 十三阶段就是 35 万条
stage 行，4 shard + 1 global 且平均重试一次约 40 万条 AI attempt，每轮 10 条新意见则 27 万条台账。
每轮还各存一份 `templateSnapshot`。没有寿命规则，列表与度量会持续变慢，最后管理员只能手工删数据，
把台账和采纳率一起破坏。

| 数据                       | 寿命                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| 活跃工作项的轮次与阶段明细 | 全量保留                                                                   |
| `closed` 工作项            | 物化汇总（轮数、耗时、意见数、采纳数）后**归档明细**                       |
| `code_ai_attempts`         | 明细按期限清理，保留每阶段的次数/耗时/结果**聚合**                         |
| `pendingArtifact`          | 一经消费或作废**立即回收**，不等工作项 closed                              |
| `templateSnapshot`         | 内容寻址存储，同一模板版本多轮共享一份                                     |
| `code_findings`            | 长期保留（采纳率要用），带 `createdAt/lastSeenAt/closedAt` 与仓库+时间索引 |

所有历史查询走 cursor 分页；状态图默认只取当前轮 + 最近 20 轮，AI attempt 按阶段惰性加载。

### 11.5 部门框架的发布：revision + 灰度 + 回退

部门框架是**一次面向全部仓库的即时生产发布**：200 个仓共用一个 `classify`/`arbitrate`，改坏之后
当天 150 次执行立刻受影响。最危险的形态不是脚本崩溃（那会成片失败、很快发现），而是它**exit 0
但返回错误分类**——没有任何失败信号，可能一个工作日后才靠开发者投诉发现。轮次快照只保护**正在
跑的**那一轮，挡不住下一轮。

故框架改为**不可变 revision** + 发布生命周期：

```
draft → validated（回放固定样本）→ canary（1–5 个仓）→ published → retired
```

- binding 声明 `pinnedRevision` 或 `followChannel`；
- 发布前用固定的采集/分类样本回放，并显示**受影响仓数**；
- 保留 last-known-good revision，灰度期失败率越阈值即停止推进并一键回退。

### 11.6 模板副本的上游关系

20 个小组各复制 5 个内置 binding = 100 个独立副本，跨实例导入还会再生更多。内置模板三个月后修好
了一个误报，**传不到任何副本**，管理员甚至列不出哪些仓受影响。

故 framework/binding 带 `upstreamRef` / `upstreamVersion` / `baseDigest` 与 `localOverrides`，
派生 `current / update-available / conflicted / orphaned` 四态，提供三方差异预览与"只合并未被
本地覆盖的字段"的升级操作。配置包携带来源与基线摘要；连不上原上游时明确标 `detached`，
不伪装成最新。

### 11.7 配置规模：三级继承 + 批量 + 唯一的最终配置

200 仓 × 5 能力 = **1,000 个格子**，每格 30 秒也要 8.3 小时铺开，之后统一改一个阈值又要再来一遍。
而一格的实际行为同时取决于框架默认、binding 覆盖、仓库触发配置、钩子、agent slot、阈值与上限、
分片上限、重试次数、全局并发、CI 配额——出事时说不清某个值最终来自哪一层。

- **批量操作**：按标签或仓库集合 preview / apply / revert——但落地形态是**对具体矩阵格的显式
  批量写入**，配置模型仍是用户拍板的两层 + 逐仓矩阵；
- **`EffectiveCapabilityConfig`**：唯一的最终配置读模型，界面逐字段显示**最终值、来源层、
  默认值、生效范围**；
- ⚠️ **三级 assignment（`department → repo-group → repo` 继承）已移出首发**——它实质推翻了
  用户拍板的 F11「两层配置」与 G4「仓库 × 能力矩阵」，登记在 proposal §6bis-B 改-3 待确认。
  未确认前不实现继承语义，只做上面那种"展开成显式写入"的批量。

## 12. 测试策略

按 CLAUDE.md §Test-with-every-change，以下 case **必写**：

> ⚠️ 本节在第一轮设计门后**整体重写**。初稿有三条把**已被推翻的行为**写成了断言——
> 「领域校验失败（行不在 diff）触发重试」「上轮线程被 resolve」「新事件到达 ⇒ 新轮启动」。
> 若照初稿实现，测试会把缺陷锁成契约（本仓 RFC-287 刚踩过同款：写的测试在测量那个本该被消除的
> 阻塞时长）。**写测试前先对照本节，不要照抄任何早期草稿。**

**纯函数预言（首选可断言面）**

- 工作项状态机转移表：全部合法转移 + 非法转移被拒（表驱动穷举），**含 `superseding` 与
  `handed_off` 的进入与退出**。
- **守卫优先级**：`awaiting` 收到"既是新事件又是基线变化"的输入时，必落作废而非入队；
  迟到的旧 generation 确认被丢弃。
- `fingerprint`：行号变化**不**改变指纹；**同文件不同符号/hunk 的相同正文必须得到不同指纹**
  （锁 P1-2 的修复，这条不写就等于没修）；正文空白/大小写归一。
- `split-diff`：同一 diff 必得同一分块；超限切分；空 diff；单文件超限。
- position 组装：新增行 / 删除行 / 上下文行 / 文件重命名；两家各一组。
- **锚定判定与校验失败的分野**：结构不合 schema ⇒ 走重试；结构合法但行不在 hunk 内 ⇒
  **不重试**、标 `degraded`、阶段成功。两者各一组用例，**并显式断言对方路径没有被触发**。
- `gate`：排序确定性、阈值过滤、上限截断与"未展开条数"计数。
- `reconcile` 三集合划分：持续存在 / 新增 / 已消失，边界是同一指纹在两轮的存在性组合（四种）。
- 优先级仲裁默认规则：冲突 > 评论 > CI；CI 内三档。
- CI 配额计数键 `(工作项, 失败指纹)`：失败指纹变化 ⇒ 配额重置。

**确定性守卫**

- envelope 不合 schema ⇒ 同会话重试 ⇒ 换会话重跑 ⇒ 阶段失败，三级各一条。
- **每次 AI 调用在 `code_ai_attempts` 留行**，且 `rerunSeq`/`attemptSeq`/`shardKey` 能唯一定位。
- **源码层负扫描（判据必须写死，否则是零预言力的锁）**：本仓有先例教训——只匹配到私有类型的
  源码锁等于没锁（RFC-284 T30 / RFC-287 同款）。故每条负扫描都要声明**扫描面**与**匹配式**：
  - AC-9/10：扫描面 = 阶段实现文件中 `kind: 'program' | 'script'` 的那些；匹配式 = 对
    agent 派发入口（`TaskLauncherPort` 的 AI 方法、`runSystemAgent`、agent spawn 符号）的**引用**；
    命中即红。**并配一条反向自检**：把某个 program 阶段临时改成调用 AI，扫描必须变红——
    扫描本身也要被验证有预言力。
  - AC-11「零轮询」：判据不是"没有 setInterval"（太窄），而是 = 监视器模块内不得存在
    **未由事件触发的定时器/循环调度**注册；同样配反向自检。
  - AC-20：`SAFE_FORWARD_ENV` 常量与本 RFC 前完全一致（值级对照，非文本包含）。

**集成**

- 完整一轮 mr-review：假 webhook → 假 code-host → 断言发布载荷（草稿条数、bulk_publish 一次、
  总览含 degraded 计数）。
- **第二轮对账**（取代初稿的"去重"）：仍存在 ⇒ 不重发**且原线程仍 open**；已消失 ⇒ 被处理
  （GitLab: resolve；GitHub: 追加"已不再出现"回复）；新增 ⇒ 发布。三类各断言一次。
- **发布失败时不清理**：模拟 bulk_publish 失败，断言上一轮的线程**原样保留**。
- **抢占**（取代初稿的"新轮立即启动"）：`running` 中新事件 ⇒ 落 `superseding`、epoch +1、
  **旧 task 未终态前不开新轮**；旧 task 终态后才 `queued`；全程无孤儿行。
- **epoch 复检**：让一轮在 publish 前被抢占，断言它**放弃产出**而不是照发。
- **awaiting 全链**：贴 patch（断言 `pendingArtifact` 已固化 + digest 入回帖）→ 回关键词 →
  新一轮**从 `resumeFrom` 起**（断言 AI 阶段**未**重跑）→ 推送的内容与 artifact digest 一致；
  以及源分支变化 ⇒ 作废。
- **MR 级 lease**：检视轮与监视器轮同时就绪时严格串行；持锁方释放前另一方不得开轮。
- **`invoke` 子序列**：self-review 在父轮的记账下执行，且**不触发 publish**。
- **per-shard 独立工作树**：两个 shard 同时改同名文件，互不可见；同一输入重复执行得到同一 findings。
- **fork 场景**（两家各一条 e2e）：源分支能 checkout；fork PR 的 CI 事件能经 head SHA 映射唤醒
  唯一 MR，多命中/零命中时不唤醒。
- **核心脚本阻断**：`collect` 非零退出 ⇒ 本轮阻断（不得带空产物继续）。
- 钩子：pre/post 各一，含注入数据、中止、非阻断失败三种。
- 阶段契约升版 ⇒ 旧钩子报迁移。
- 两层配置：部门改默认值，未覆盖的小组跟随、已覆盖的不变。
- **readiness**：缺触发器 / agent 不可见 / 未配 code-host 各自落 `misconfigured` 并给出该项修复入口。
- **闭环回链**：`requirement` 产出的 MR 合并 ⇒ 经反向索引把需求工作项推进 `closed`。
- **终局比对**：`closed` 时对未标记 `code_changed` 的意见回填。

**权限**

- 非 MR 作者叫推送被拒；bot MR 上 `initiatorUserId` 可叫、他人不可。
- 小组层写脚本/钩子被拒；PAT 拿不到 `scripts:author`。

**e2e**（Playwright）

- `/code` 配置矩阵 → 发起 → 状态图三层展开 → 切轮次回看。
