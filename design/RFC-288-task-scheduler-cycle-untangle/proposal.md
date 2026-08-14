# RFC-288 — backend 值级环归零（taskDriver → 四件合同）（proposal）

状态：**CLOSED（2026-08-14，用户决定关闭；未实现，零生产改动）**
（历程：2026-08-13 初稿 → 08-14 第二轮门后按 RFC-294 §5.2 重写 → 08-14 第三轮门
〔三路错开视角〕后再次修订 → 关闭）

> ## 为什么关闭
>
> 三轮设计门之后，本 RFC 的范围收敛到「四件合同的 owner/consumer/import 拓扑 +
> 断 task↔scheduler 环」——而这**正是 RFC-294 §16.2 已经逐条规定的内容**，接口形状
> 也由其 §5.3 逐字定义，排期更早已写进它的 DAG（`W1 → RFC-288 final gate → W2`）。
> 也就是说，收敛到正确形状之后，本文档**不再承载 RFC-294 之外的设计信息**。
>
> 同时实现有硬前置（P0-D + W1 exit），而本稿的源码锚**两天内烂了三轮**
> （`da706b19` → `01d2160e` → `6e8c4f9f`，每轮都要全量重锚）。为一件还开不了工的事
> 维护行级 inventory，到开工时必然重写——这是关闭而非继续修订的决定性理由。
>
> **后续**：解环工作归 RFC-294 §16.2 / W2；待 `W1 exit` 后按当时的真实锚另立一份
> 轻量实现 RFC。**本文不删**——下面的正文与 §7 门记录是那次实现的输入。
>
> ## 关闭前必须带走的结论（不随锚烂掉，均经实测）
>
> 1. **四件合同必须携带 `OwnershipToken`/epoch**。taskId-only 的 `requestStop` 会
>    **误杀继任者**（第三轮门 B 路实测复现：`tryAttach(old) → release → tryAttach(next)
>    → requestStop(taskId)` abort 掉的是 next）。
> 2. **`abortAll(reason)` 的 reason 不可选**。丢了它，daemon 优雅停机会从可恢复的
>    `interrupted` 降级成用户 `canceled`（RFC-202 语义，`rfc202-source-locks` 锁）。
>    ——此后 RFC-287 并发面审计在生产代码里抓到**同一形态的真回归**（只判 `aborted`
>    不判 `reason`，任务永久楔死），可见这条不是纸面推演。
> 3. **kick 是四点不是三点**：`startTask` / `resumeTask` / **`retryRepoPreparation`
>    （RFC-287 AC-11 新增）** / `retryNode`。漏第三点则 A1 删不掉或直接编译红。
> 4. **不能用全局 `registerSchedulerDriver` + 「未注册即响亮 throw」**：throw 会被
>    scheduler 的两处裸 `catch` 吞掉（取消看似成功而 child 仍在写盘）；且 19 个直调
>    `startTask(` 的测试里 **17 个不走 `createApp`**。正解是实例注入 + bootstrap
>    fail-fast（早于 serve / ticker / auto-resume）。
> 5. **先迁 registry 再切 consumer 会出现双 registry**（DB 写了 canceled 而真 driver
>    在另一个 registry 里继续跑）。必须先把同一个 `TaskExecutionContext` 线程化进
>    deps 链，再替换 backing instance。
> 6. **同步准备失败路径有一处直接 release**（`awaitScheduler:true` + 准备失败）。漏迁
>    会让 handle 永久泄漏 ⇒ `__repo_prep__` 重试永远 `task-still-running`，只能重启
>    daemon，**AC-11 直接失效**。
> 7. **解环的最小充分集** = 断 A1 + B1 + B2/B3/B4 + E3。C1/C2 **不必**转静态（断 A1
>    后该方向已无环，转静态反而引入 ESM 初始化风险）；materialization 拆分与
>    `task → gc` 边**都不必动**（C-7 的必要断点只有 E3）。
> 8. **判据：不跨 context**。留在 `task-execution` 内 = 该刀可做；跨到
>    source-control / resource-catalog / platform-events / integration = 属 W4/W5。
> 9. **不要用仓库级指标当单个 RFC 的 AC**。「零值级 SCC」是范围吸引子：它三次把无关
>    域的债吸进本 RFC（三族环 → git 5 节点含 `util/git` 分层倒置 → MCP 三环）。环是
>    症状，边界才是目标。
来源：`design/system-commons-unification-audit-2026-08-12.md` D3 大件二；原始工作包
=`design/task-execution-architecture-audit-2026-08-03.md` §A3（:182-188）+ WP-5
（:306-312）。⚠️ 命名注意：`design/scheduler-audit-2026-06-10.md:303` 另有一个
「WP-5」（写锁注册表，已随 RFC-098 完成）——本 RFC 指 **2026-08-03 审计的 WP-5**。

> **锚约定（第三轮门 F7 的修法）**：本文所有源码锚一律写成 **`6e8c4f9f:path:line`**
> 的自证形式——它们对准评审基线那个 commit，**不是「当前 HEAD」**。实现期每批第一
> 子任务仍是逐锚复核；锚漂时更新 SHA 前缀，不要默默沿用行号。
> **RFC-294 对齐基线 pin：`be31dd62`**（RFC-294 三件套目前唯一的提交）。⚠️ RFC-294
> 正在被并行重写（主工作树有未提交改动），本稿只依据 `be31dd62` 的**已提交**内容；
> RFC-294 再提交后按 SHA diff 做增量对齐，不重头返工。

## 1. 背景

backend 里最大的值级 SCC 是 **8 模块环**（task / scheduler / execution.{executor,outcome}
/ agentLaunch / workgroup.launch / gc / callGraph.expandService），由
`scripts/depcheck.ts` KNOWN_VIOLATIONS 前 6 条记账。唯一**闭环上行边**是
`6e8c4f9f:packages/backend/src/services/task.ts:153`（`import { runTask } from './scheduler'`）。

**初稿之后运行期事实已变**（第二轮门实测，本稿沿用）：active-task 注册表早已不是
Map，而是 RFC-303 的 `TaskDriverSupervisor` 端口 + `InMemoryTaskDriverSupervisor`
适配器；`abortAllActiveTasks` 是 `(reason?: string): string[]` 且 reason 决定
daemon shutdown 落 `interrupted` 而非 `canceled`；kick 是**四点**
（`6e8c4f9f:.../task.ts:2946 / 3757 / 4308 / 4936`，第三点是 RFC-287 AC-11 的
`retryRepoPreparation`）。

**RFC-294 已对本 RFC 作出裁决**（`be31dd62` 的 `proposal.md` **§5.2** +
`design.md` **§16.2**）：目标必要，但初稿的 `taskDriver` 单叶子把 active registry、
status publisher、kick/cancel/resume locator 三种生命周期塞进一个 process-global
叶子，**必须拆成四件合同**；且「P0-D 先落 canonical durable ownership/fence，
RFC-288 只迁四件合同的 owner/consumer/import 拓扑并复用 P0-D authority，不新建第二套
lease/schema」是**已固定的批准路径**。

## 2. 目标

- **G1 四件合同**（接口**逐字采用** RFC-294 `be31dd62:design.md` §5.3，不再自创）：
  `TaskRuntimeRegistry`（`attach(token, handle)` / `get` / `detach(token)` /
  `abortAll(reason: TaskAbortReason)`——reason **非可选**）、`TaskOwnershipPort`
  （由 P0-D 提供，本 RFC 只做 consumer/owner cutover）、`TaskStatusPublisher`、
  `SchedulerDriverPort`（`TaskExecutionModule` 实例注入 + bootstrap fail-fast）。
  停机语义走独立的 `TaskDriverSupervisor.requestStop(token, reason)` /
  `awaitStopped(taskId, epoch)`。details 见 design §2。
- **G2 workspace / materialization**：符号级迁移至 **source-control 终局 owner**
  （用户决策：本 RFC 完成终局迁位，不留到 W5）。
- **G3 task read model 三分**：窄义 `getTask` 族 → task-execution application
  queries；archived events / stdout → 经 port 读 FS 的 log/artifact query；
  `getTaskDiff`（`6e8c4f9f:.../task.ts:5613`）→ source-control / workspace-insight
  participant（orchestration 仍留 task）。
- **G4 scheduler 符号归位 + export 收缩**：先做**依赖闭包**级归位（含私有依赖，
  见 design §6），consumer 清零后再上白名单锁。
- **G5 gc 旁支**：`materializingSpaces` 与 `finishClaimedWebhookWorkspacePrune`
  一并迁走，`task→gc` 值边消失；workspace GC lease 落终局 owner。
- **G6 全 backend 环归零（用户 2026-08-14 决策，范围较上稿扩大）**：除主 8 环外，
  另拆 **四族**——
  1. `agent ↔ agentDeps ↔ agentResourceIntegrity`（3 成员，注入 agent/list loader 可断）
  2. `workflow ↔ workflow.validator`（2 成员，注入 workflow loader 可断）
  3. **git 5-SCC**：`gitRepoCache / util/git / gitSubmodule / gitVersion / repoGroup`
     ——**含 `util/git` 的分层倒置**（`6e8c4f9f:packages/backend/src/util/git.ts:1181-1182,2744-2745`
     以 `await import('@/services/git*')` 反向依赖 services，即架构审视 RC-4 的老债）
  4. **MCP/server 3 环**：`mcp/dispatch:28 → server` → `server.ts:16 → mcp/server`
     → `mcp/server.ts:24 → mcp/dispatch`
- **G7 归位与锁**：源锁 + CALL_FACES + depcheck 全量销账 + **RFC-294 要求的机器账本**
  （module-symbol-owners / public-surfaces / exception schema）+ 文档账本同步。

## 3. 非目标

- **不新建 durable ownership / lease / schema**——P0-D 的范围（RFC-294 §16.2 明令：
  要并回本 RFC 须先显式 Supersede 该决策并重新请批）。
- 不动装配线内部结构（RFC-287 已收敛）。
- 不动 fanout 内链（RFC-289，按 RFC-294 §5.3 冻结）。
- 不改 depcruise 规则语义（type-only 豁免保持；no-circular 不得退化为 pathNot）。
- 不做 RFC-294 W9 的全局 container 清仓。

## 4. 能力影响清单

**零能力变化**，以下六项是「零」的前提（前五项承自第二轮门，第六项为第三轮门新增）：

| 必须保真的行为 | 若按错误合同实现会怎样 | 锁 |
| --- | --- | --- |
| `abort(reason)` → shutdown 落 `interrupted` | 丢 reason ⇒ 降级成用户 `canceled`，任务不再可恢复 | `rfc202-source-locks.test.ts:16-23,35-40` |
| 精确 owner（token/epoch + controller 身份） | 旧 takeover 误杀继任者（第三轮门 B 路**实测复现**：`tryAttach(old) → release → tryAttach(next) → requestStop(taskId)` 会 abort 掉 next） | `rfc303-runtime-ownership.test.ts:27-71` |
| stop ticket：cancel 必须等确切 driver 停 | cancel 只改 DB，child driver 继续写盘 | 同上 |
| unreaped receipt（`child-unkillable`） | 结果丢失，清理与子进程判定失真 | 同上 |
| frozen workgroup 不重读 live resource | 破坏父任务冻结闭包 / 被 node-invoker guard 拒 | `rfc243-call-workgroup.test.ts:129` |
| **同步准备失败路径的直接 release**（`6e8c4f9f:.../task.ts:4491`） | `awaitScheduler:true` + 准备失败时 handle 永久泄漏 ⇒ 重试 `__repo_prep__` 永远 `task-still-running`，只能重启 daemon（**AC-11 直接失效**） | 新增锁，见 design §10 |

登记但不属能力收缩：`SchedulerDriverPort` 未装配从「运行期静默错判」变成
**bootstrap 启动失败**（修正而非收缩——旧行为的 throw 会被
`6e8c4f9f:.../scheduler.ts:3487` 与 `:3528` 的裸 catch 吞掉）；scheduler export 收缩
是迁位后收内部面，现有 1 个生产 + 27 个测试 consumer 全部随刀改锚。

## 5. RFC-294 对齐（pin `be31dd62`）

落位表按第三轮门 C 路要求改为**六列**，把「本 RFC 的 W2 抽缝」与「终局 owner /
波次」分开；带斜杠的双 owner 一律拆成 orchestration owner + participant owner：

| 当前 symbol | 本 RFC 抽取 owner / 层 | 本 RFC 动作 | 终局唯一 owner / 层 | 终局波次 | 偏离 ID |
| --- | --- | --- | --- | --- | --- |
| active handle 表 | task-execution ports + infrastructure | 采用 §5.3 合同 | 同左 | P0-D / W2 | — |
| ownership lease/epoch | task-execution application/ports | **只做 consumer cutover**（实现来自 P0-D） | 同左 | P0-D | — |
| `emitTaskStatus` | task-execution ports（transitional publisher） | 定义 port + adapter | platform/events committed event | **W3** | DEV-4 |
| kick/cancel/resume | task-execution application/ports | 实例注入 | 同左 | W2 | — |
| 窄义 `getTask` / node-run projection | task-execution application/queries | 迁位 | 同左 | W2 | — |
| archived events / stdout | task-execution application/queries + FS port | 迁位 | 同左 | W4 | DEV-3 |
| `getTaskDiff` | task orchestration（留）+ source-control participant | 拆双 owner | 同左 | W5 | DEV-3 |
| repo/cache/worktree materialization | source-control commands + workspace port | **终局迁位** | 同左 | W5 | DEV-3 |
| workspace GC lease | task-execution owner job + participant | **终局迁位** | 同左 | W4 / W9 | DEV-3 |
| multipart / pre-created prestage | — | **本 RFC 不动** | task-execution direct-launch prestage | W4-E1 | — |
| `AGENT_HOST_AGENT_NODE_ID` | task-execution node 域常量 | 下沉 | 同左 | W2 | — |
| agent / workflow / git / MCP 四族环 | 各自现 owner（只改 import 拓扑与注入 seam） | 断环 | resource-catalog / source-control / bootstrap-platform | W4 / W5 | DEV-2、DEV-5 |

**偏离项台账**（逐条经用户确认；新增项标注日期）：

- **DEV-1 不留 facade（2026-08-14 确认；第三轮门后修订形态）**：与 D18
  （`CLAUDE.md` §services 目录组织轻规则）及 RFC-294 §16.2 的渐迁预期相反。
  **修订**：原「源码提交与改锚提交分离」被证明与「每刀 gate 全绿」不可兼得（无
  facade 时至少一个 commit 必然 typecheck 红）⇒ 改为**源码移动 + 全部生产/测试
  consumer 改锚必须在同一个原子 commit 内**；缓解措施改为 repo-wide exact consumer
  文件窗口 + 每刀前 `git pull --rebase` + pin worktree `gate:local` + exact-SHA CI。
- **DEV-2 G6 四族环早于 W4/W5（2026-08-14 确认，范围已扩大）**：只动 import 拓扑与
  注入 seam，不动 owner 归属；各族独立成刀可单独回退。
- **DEV-3 终局迁位提前（2026-08-14 确认）**：materialization（W5）、archived
  events/stdout（W4）、GC lease（W4/W9）在本 RFC 内完成终局迁位而非只抽缝。
- **DEV-4 status publisher 只落 transitional port**：committed-event / outbox /
  sanitized WS projection 属 W3，本 RFC **不**提前（RFC-294 plan 明确 W2 定义 port、
  W3 切 outbox）。
- **DEV-5 MCP 三环与 RFC-247 收尾撞面（新增，需协调）**：该环账目的 `removeWhen`
  写的是「RFC-247 收尾时把路由注册表下沉」。本 RFC 纳入它 = 代做 RFC-247 的未竟工作，
  **实现前必须与 RFC-247 owner 协调排它窗口**，否则同一文件双改必撞。
- **DEV-6 `ports/` 落位条件化**：RFC-294 目标结构是 `application/ports/`，HEAD 既有
  `modules/task-execution/ports/` 是**存量债不是目标**。默认新端口落
  `application/ports/`；若 W0 的 canonical inventory 批准根级过渡，则引用其 exception
  ID / owner / `removeAfterWave`，不以「已有先例」为由自证。

## 6. 验收标准

每条按「owner / 精确命令 / 产物 / 绿判据」四列给出（第三轮门 F6 的修法）：

| AC | owner | 精确命令 | 产物 | 绿判据 |
| --- | --- | --- | --- | --- |
| **AC-1 全 backend 零值级 SCC** | T14 / CI | `bun test --isolate packages/backend/tests/backend-value-scc.test.ts` | SCC 报告 | 值级 SCC 数 = 0（复用 depcruise 原始 `modules` 图源做 Tarjan 投影，**不另写 parser**；需把 `CruiseDependency` 扩到携带 `dependencyTypes`）；`bun run depcheck` 零 unknown / 零 stale，全部 no-circular 账目删除 |
| **AC-2 中间态无双红** | 每刀 / CI | `bun run depcheck` | 退出码 | exit 0 且 unknown=stale=0；**禁止预测性预登记**（只按实跑 exact tuple 追加） |
| **AC-3 行为对拍** | 每刀 / CI | `bun run gate:local` + T1 冻结的 import manifest 比对 | manifest diff | scheduler 94 / task 92 静态（含动态各 94）——**以 T1 冻结的 manifest 为准，不以本文数字为准**；四 kick、shutdown reason、driver seam 行为逐项保持 |
| **AC-4 启动面锁** | 每刀 | 定向跑 CALL_FACES / 源锁族 | 测试结果 | rfc243 CALL_FACES、rfc257 同型源锁、helper 族（**3 文件 11 处引用**）全部改锚且绿 |
| **AC-5 装配可验收** | T2a→T2d | `bun test --isolate packages/backend/tests/task-execution-module-assembly.test.ts` + `bun test packages/backend/tests/...`（共享进程模型另跑一条具名脚本） | 测试结果 | 未装配时在 `Bun.serve`/ticker/auto-resume **之前**失败；同实例幂等、异实例硬拒；HTTP launch / background launch / scheduler child recovery **观测到同一 module id**（canary consumer，防 T2a 零预言力）；poison-method 变异必红 |
| **AC-6 初始化安全** | T2h / T2i | `bun test --isolate packages/backend/tests/import-order-smoke.test.ts` + `bun run build:binary` + 二进制 `--version` smoke | 二进制 + 日志 | 四种 import 顺序均可加载且真实 facade 可调用；单二进制启动零错误 |
| **AC-7 frozen 语义** | T2i | `bun test --isolate packages/backend/tests/rfc243-call-workgroup.test.ts` + 新增逐项断言表 | 测试结果 | frozen payload / parent linkage / depth / 继承 space / owner-active preflight / collaborator 并集 / gates ④-⑦ **各有一条断言**，错误码与顺序逐项对拍 |
| **AC-8 文档账本同步** | T13 | `bun test --isolate packages/backend/tests/rfc-index-status-drift.test.ts` + required-doc-key 检查 | 文档 diff | depcheck 头注计数、08-03 审计 ⓪、路线表、STATE 四处 required key 全部命中 |
| **AC-9 每刀门禁** | 每刀 | `bun run gate:local`；**T4/T9 另加** `RUN_GIT_NETWORK=1 bun test --isolate <T1 扫出的清单>` | CI 结论 | 本地全绿 + exact-SHA CI terminal 绿（`gate:local` 不跑 `skipIf(!RUN_GIT_NETWORK)` 门后的套件，清单用 `grep -rln "skipIf(!RUN_GIT_NETWORK" packages/backend/tests/` 现扫，不凭记忆） |
| **AC-10 实现门** | T14 | 双路独立子代理（错开视角） | 两份报告（路径固定） | unresolved P0/P1 = 0；分歧逐条归零 |

## 7. 设计门记录

### 7.1 第二轮（2026-08-14，两半场）

报 **P0×8 / P1×7 / P2×1**（共 16 条；此前表头误记为 P1×5，第三轮门 F8 更正）。
逐条处置见第二轮记录；第三轮 A 路复核判定：**10 条已实质解决、4 条处置引入新问题
（RFC-294 对齐 / taskDriver 契约 / G4 计数 / T2 拆刀 DAG）、2 条仅措辞解决
（AC-1、C1-C2 smoke）**——这 6 条已在本稿重做。

### 7.2 第三轮（2026-08-14，三路错开视角）

A=回归验证、B=攻击可实施性、C=总纲与仓规一致性；三路均 NOT-CLEAN，去重后
**P0×5 / P1×11 / P2×5**。处置：

| # | finding（合并） | 提出方 | 处置 |
| --- | --- | --- | --- |
| P0 | 四件合同混淆 port(3 异步)/adapter(3 同步)/application 语义，且丢 `OwnershipToken`/epoch、`abortAll(reason)` 变可选 | A+B+C 三路 | §2 逐字采用 RFC-294 §5.3 两份接口；现 3 方法 port 标为迁移前兼容面 |
| P0 | AC-1 不可达：漏 MCP 三环，且 git 是 **5 节点 SCC** 不是二环 | A+C | 用户决策扩为全 backend 归零，G6 纳入四族（含 `util/git` 分层倒置）；DEV-5 登记 RFC-247 撞面 |
| P0 | T2b-T2g 无可独立绿的单-registry 中间态（双 registry ⇒ canceled 行 + 仍在跑的 driver） | B | 先加一刀把同一 `TaskExecutionContext` 线程化进 deps 链，再替换 backing instance |
| P0 | T6 清单不是依赖闭包（`deriveFrontier`→`SETTLES_WITHOUT_ROW_KINDS`/`isLiveStatus`；`createOrRebuildWrapperIso`→`parseIsoJsonMap`/`parseIsoSubmodules`） | B | design §6 补闭包 + 新增源锁「T6 owner 不得值 import scheduler」 |
| P0 | T2d 必红：切完四 kick 即等于删 A1，账本却排到 T2g 后（depcheck stale 红 / lint unused import 红二选一） | B | A1 删除 + 前 5 条销账并入 T2d 同一提交 |
| P1 | `TaskStatusChanged` / `ResumeDriverDeps` 是占位符；`kick` 吃 god-type `RunTaskOptions` | A | §2 补全字段；resume 复用 `InheritableRunConfig`（B 路实测只需 17+4 项，非 45） |
| P1 | T2b 漏 `6e8c4f9f:.../task.ts:4491` 直接 release ⇒ handle 泄漏、AC-11 永久失效 | B | 入 §4 保真表 + T2b 全量盘点 `taskDriverRegistry.*` |
| P1 | `TaskExecutionModule` 生命周期/DB 权威未定义；同进程多 app 会分叉 registry | B | design §3 定死：每 daemon 一个、`createApp` 只借用、`dispose()/awaitIdle()`、registry 不闭包在 `DbClient` 上、测试统一 factory |
| P1 | 「28 个测试文件」是分组行数之和，去重后 **27**；且漏 source-text consumer | A | §6 更正并另列源码文本锁 inventory |
| P1 | 前置引用了不存在的 `W0-R` | A+C | 改用 `be31dd62` 的真实 DAG：`W0 + P0-A/B/C/D → W1 → RFC-288 final gate → W2` |
| P1 | 落位表混淆 W2 抽缝与终局波次 | C | §5 改六列 + DEV-3 |
| P1 | publisher 把 W2 端口与 W3 committed-event 混一刀 | C | DEV-4：本 RFC 只落 transitional port |
| P1 | 缺 RFC-294 强制的机器账本 | C | T1 后增账本子刀（module-symbol-owners / public-surfaces / exception schema） |
| P1 | 根级 `ports/` 是存量债不是目标落位 | C | DEV-6 条件化 |
| P1 | T0/T5/T8-T10 不是可执行切片（G6 三刀只有标题） | C | plan 逐族展开 baseline oracle → additive port → 单 consumer → 负扫描 |
| P1 | AC-3/5/6/7/8/10 无机械 oracle；AC-3 计数错 | A | §6 四列表 + manifest 冻结 |
| P2 | 多处锚只对 `01d2160e` 成立 | A | 全量改写为 `6e8c4f9f:` 自证形式 |
| P2 | §7 表头计数错（P1×5 应为 ×7） | A | 已更正 |
| P2 | `gate:local` 不跑 `RUN_GIT_NETWORK` 套件 | C | AC-9 增列 |
| P2 | T2a 装配锁零预言力 | B | AC-5 增 canary consumer + 实例身份断言 |
| P2 | 文本锁需 AST + 变异实证 | C | design §10 |

**三路「攻击未打穿」的结论**（据此不再改动）：`TaskStatusPublisher` 的「只消费已提交
事件」成立——9 个 `emitTaskStatus` 调用点全在事务外，但 `task.ts:3745` 等 reap/rollback、
`:4930` 等 node-run mint、`dwActions.ts:217` 等 DW state 这些**后置屏障必须原样保留**；
`ResumeDriverDeps` 不会退化成 `StartTaskDeps` 同义词；T3 先于 T4 无编译矛盾；
`buildContainerMap` 在 scheduler 内零调用、可干净搬走。
