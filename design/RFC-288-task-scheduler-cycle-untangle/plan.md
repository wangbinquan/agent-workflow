# RFC-288 — 任务分解（plan，2026-08-14 第三轮门后修订）

> **实现前置（按 RFC-294 `be31dd62` 的已提交 DAG，不是未提交稿的「W0-R」命名）**：
> `W0 + P0-A/B/C/D → W1 → RFC-288 final gate → W2`。即 **W0 与四个 P0 落地、W1 exit
> 收敛之后**，本 RFC 才过 final gate 进入实现；`TaskOwnershipPort` 的实现由 **P0-D**
> 提供，本 RFC 只做 consumer/owner cutover（属 W2-A）。
> 本轮交付 = 修订后的三件套 + 行为 oracle 清单，**零生产改动**。
> 每刀第一子任务 = 逐锚复核（本稿锚对准 `6e8c4f9f`，开工时以 T1 冻结的 manifest 为准）。

## 0. 提交纪律与并发窗口（DEV-1 修订形态）

- **原子提交**：源码移动 + 全部生产/测试 consumer 改锚**必须同一个 commit**。
  「源码与改锚分提交」已被证伪（无 facade 时必有一个 commit typecheck 红），
  该承诺**作废**。共享 `main` 上不得出现不可构建的 SHA。
- **排它窗口**：与 RFC-289 及任何在改 `task.ts` / `scheduler.ts` / `util/git.ts` /
  `server.ts` / `mcp/*` 或相关高频测试的工作建立**同一 repo-wide exact consumer
  文件窗口**（不只是「与 RFC-289 串行」）。
- **T11（MCP）开工前必须与 RFC-247 owner 协调**（DEV-5：该环账目的 removeWhen 指向
  RFC-247 收尾）。
- 每刀前 `git pull --rebase`；pin worktree 跑 `bun run gate:local`；推完按 exact SHA
  查 CI。

## 1. 批次

### 前置刀

- **T0** `AGENT_HOST_AGENT_NODE_ID` 下沉为 task-execution node 域常量（消费者
  `execution/outcome.ts:25,160`）。附常量唯一来源锁 + 消费者锁。**无账本变化。**
- **T1 基线与 inventory（不改生产代码）**，产出五份冻结物：
  1. 开工 SHA → 全部承重锚的 manifest（AC-3 以它为准）；
  2. 四个 kick 的 `KickRequest` 保真表；
  3. scheduler export inventory：**依赖闭包**（含 `SETTLES_WITHOUT_ROW_KINDS` /
     `isLiveStatus` / `parseIsoJsonMap` / `parseIsoSubmodules`）+ 27 个 import 消费
     文件 + 4 个 source-text consumer + 1 个生产消费者；
  4. `materializingSpaces` / prune 的全部调用路径表；
  5. `RUN_GIT_NETWORK` 套件现扫清单（`grep -rln "skipIf(!RUN_GIT_NETWORK" packages/backend/tests/`）。
- **T1b 机器账本子刀**（RFC-294 W0 强制）：为本 RFC 将新增/迁移的每个 symbol 建
  `module-symbol-owners` / `public-surfaces` / cross-context edge / composition entry /
  exception 条目（含 `removeAfterWave`、`expiresOn`、`mutationTest`）与 API snapshot。

### G1 四件合同

- **T2a** 新增四个端口 + 最小 `TaskExecutionModule` composition（落**当前** composition
  root），不切换 consumer；装配锁 **+ canary**（HTTP launch / background launch /
  scheduler child recovery 观测同一 module id）+ poison-method 变异实证。
- **T2b-0** 把同一个 `TaskExecutionContext` 线程化进
  `StartTaskDeps → KickRequest → SchedulerState → child cancel/resume/isActive`，
  **仍适配旧 registry**（堵住双 registry 中间态，见 design §3.2）。
- **T2b** 迁 `TaskRuntimeRegistry`：按 RFC-294 §5.3 合同（token/epoch、`abortAll(reason)`
  非可选），保留 RFC-303 全部语义；**必须全量盘点 `taskDriverRegistry.*`**，显式覆盖
  `6e8c4f9f:.../task.ts:4491` 的直接 release（「失败可重试、只 release、不 prune」）；
  admission/settlement 留 application。新增「同步准备失败 → handle 不泄漏」锁。
- **T2c** `TaskStatusPublisher` transitional port + adapter（DEV-4：不切 committed
  event / outbox）；WS golden 对拍；**保留三处后置屏障**。
- **T2d** 四个 kick 全切 `SchedulerDriverPort`；**同一提交内删 A1 + 销 depcheck 前 5
  条账**；负扫描「`task.ts` 无 `runTask(`」（AST）；kick 计数锁延续。
- **T2e** 断 B1（`scheduler.ts:205`）。
- **T2f** 断 B2（cancel）：保留 `cascadeFromParent` 并等 stop receipt；端口错误**不得**
  被裸 catch 吞掉。
- **T2g** 断 B3/B4（resume / isActive）：resume 用 `ResumeDriverDeps`（复用
  `InheritableRunConfig`，21 项）。
- **T2h** C1 转静态 + import-order smoke + `build:binary` + 二进制启动 smoke。
- **T2i** C2 收编为内部 participant（`LaunchFrozenWorkgroupChild`）+ call-workgroup
  E2E 对拍 + CALL_FACES 更新 + AC-7 逐项断言表。

### G2 / G3 / G5（终局迁位，DEV-3）

- **T3** workspace lease：`materializingSpaces` + `finishClaimedWebhookWorkspacePrune`
  一并迁走（保留「mkdir 前登记、落行/清理后释放」）。
- **T4** materialization 符号级终局迁位至 source-control + 窄 `MaterializeDeps`；
  编排（`runDeferredRepoPreparation` 等）留 application 经 port 调用。
  **另跑 `RUN_GIT_NETWORK=1`**。
- **T5** read model 三分：窄义 `getTask`/node-run projection → application queries；
  archived events/stdout → application query + FS port；`getTaskDiff` 拆
  orchestration + source-control participant；`minimalNodePaths` 提成纯投影。
  `expandService.ts:12` 改锚（E3 断，销第 6 条账）。每个 query 列 DTO / 错误码顺序 /
  consumer 与对应测试。

### G4 归位与收缩

- **T6** scheduler **依赖闭包级归位**（含四个私有符号）；同一原子提交内改
  `lifecycleRepair/options-S1.ts` + 27 个 import 消费文件 + 4 个 source-text consumer。
  **改锚纪律**：除 import specifier 外不得改断言体/期望值/snapshot。
- **T7** export 收缩锁（白名单 `runTask` / `RunTaskOptions` / `buildWorkgroupHooks` 级）
  + rfc257 同型源锁 + 新增「T6 owner 不得值 import scheduler」；零外部 consumer 的
  类型单独去 export。

### G6 四族环（各自独立可回退；每族按 baseline oracle → additive port/参数化 → 单 consumer cutover → 负扫描）

- **T8 agent 三族**：注入 agent loader / list loader 断 `agent ↔ agentDeps ↔
  agentResourceIntegrity`；oracle = agent integrity / dependsOn 校验行为不变。
- **T9 git 5-SCC**：①切 `repoGroup ↔ gitRepoCache` 直接对边；②**消 `util/git` 分层
  倒置**——把 `resolveSubmoduleParams` / `syncSubmodules` 参数化注入 util 层
  （`util/git.ts:1181-1182,2744-2745`），util 不得反向 import services；
  `gitRepoCache.ts:78,97` 的两个队列继续由 cache 持有。oracle = submodule / repo-group /
  cache 语义 + **`RUN_GIT_NETWORK=1` 全套**。
- **T10 workflow 二族**：注入 workflow loader；oracle = validator 错误顺序不变。
- **T11 MCP 三族**（**需 RFC-247 协调，DEV-5**）：把路由注册表下沉成不依赖
  `server.ts` 的独立模块；oracle = HTTP/MCP parity + route registry + transport。

### 收尾

- **T12** fixture 与账本：`KNOWN_CYCLE` → `SYNTHETIC_CYCLE`（或改为从
  `KNOWN_VIOLATIONS` 取样并断言存在），处理 `:63-64/:78/:85/:143-152/:301`；
  depcheck 头注计数更新。
- **T13** 终局 Tarjan 棘轮：复用 depcruise 原始 `modules` 图源，扩
  `CruiseDependency` 携带 `dependencyTypes`，断言 backend **零值级 SCC**。
- **T14** 文档账本同步：08-03 审计 ⓪ 回填、RFC-294 §5.2/§16.2 状态、`design/plan.md`
  索引、`STATE.md`；required-doc-key 检查。
- **T15** 实现门（双路独立子代理，**错开视角**）+ 全量 `gate:local` + exact-SHA CI。

## 2. 依赖

```
T0                                        ── 随时可先行（无账本变化）
T1 ──► T1b
T1 ──► T2a ──► T2b-0 ──► T2b ──► T2c ──► T2d ──► T2e ──► T2f ──► T2g ──► T2h ──► T2i
                                   └── T2d 同刀：删 A1 + 销前 5 条账
T2i ──► T3 ──► T4
T3  ──► T5            （T5 依赖 T3 的 lease 先落；销第 6 条账）
T1  ──► T6 ──► T7
T1  ──► T8 / T9 / T10 / T11   （四族独立，彼此可并行，但共用 §0 的文件窗口；T11 另需 RFC-247 协调）
T2i, T5, T7, T8, T9, T10, T11 ──► T12 ──► T13 ──► T14 ──► T15
```

- **硬前置**：`W0 + P0-A/B/C/D → W1 exit`（RFC-294 `be31dd62` 的 DAG）。
- **T13 必须在全部切环刀之后**——否则「零 SCC」会在环仍存在时先跑出假红。

## 3. 验收清单

- [ ] AC-1…AC-10（proposal §6 的四列表：owner / 精确命令 / 产物 / 绿判据）
- [ ] 零能力变化，且 proposal §4 的**六项**保真项各有锁（含同步准备失败路径）
- [ ] RFC-294 落位表六列逐行落实；DEV-1..DEV-6 台账无新增未确认项
- [ ] 每刀：depcheck 零 unknown / 零 stale + `gate:local` 全绿 + exact-SHA CI 绿；
      T4/T9 另有 `RUN_GIT_NETWORK=1` 全绿
- [ ] T1b 的机器账本随每刀同步，manifest gate 全绿
- [ ] 环地图（design §1）更新为终态；`design/plan.md` 与 `STATE.md` 同步
