# RFC-288 — 任务分解（plan，2026-08-14 设计门后重写）

> **实现前置（RFC-294 §16.2 / plan.md:92 的固定批准路径）**：**P0-D
> （canonical durable Task ownership fence）与 W0-R 汇合之后**，本 RFC 才进实现。
> 本轮交付 = 重写后的三件套 + 行为 oracle 清单，**不动生产代码**；请批通过后
> 仍需等前置落地再开工（用户 2026-08-14 决策：「重写后请批，实现等前置」）。
> 每刀第一子任务 = 逐锚复核（基线 `01d2160e`；初稿锚 `da706b19` 已漂勿照抄）。

## 0. 并发与串行窗口（偏离项 1 的缓解措施）

`task.ts` / `scheduler.ts` 是共享 main 上的持续热点（近 20 条提交里 6 条直接
触及；相对初稿基线 `task.ts` 经 22 个提交、`scheduler.ts` 经 15 个提交）。因用户
选择「不留 facade、一刀清干净」，冲突面必须靠流程压住：

- 与 RFC-289 及任何在改 `task.ts` / `scheduler.ts` / 相关高频测试的工作建立
  **同一排它文件窗口**（不只是「与 RFC-289 串行」）。
- 每刀开工前 `git pull --rebase`；**改锚提交与源码提交分离**（review 可读、
  回滚可分）。
- 每刀在 pin 到自己 commit 的分离 worktree 里跑 `bun run gate:local`，推完按
  exact SHA 查 CI。

## 1. 批次

### 前置刀

- **T0** `AGENT_HOST_AGENT_NODE_ID` 下沉为 task-execution node/domain owned type
  （消费者 `execution/outcome.ts:25,160`）。独立可回退；**不产生账本变化**。
- **T1** 行为基线夹具：把 design.md §10 的九组既有锁跑成基线并记录
  「文件 + 用例 + 期望值」；产出 ①四个 kick 的 `RunTaskOptions` 保真表、
  ②scheduler export inventory（生产 1 + 测试 28 的逐符号消费表）、
  ③`materializingSpaces` / prune 的调用路径表。**不改生产代码。**

### G1 四件合同（原 T2 拆成九刀）

- **T2a** 新增四个窄端口 + 最小 `TaskExecutionModule` composition（落**当前**
  composition root），**不切换任何 consumer**；加装配锁（未装配 fail-fast 必须
  早于 `Bun.serve`/ticker/auto-resume；重复装配同实例幂等、异实例硬拒）。
- **T2b** `TaskRuntimeRegistry` 迁位：复用既有 `TaskDriverSupervisor` +
  `InMemoryTaskDriverSupervisor`，完整保留 RFC-303 语义（generation / 精确
  owner release / stop ticket / unreaped）；admission 与 settlement 留 application。
- **T2c** `TaskStatusPublisher` 单独迁（`emitTaskStatus` 载荷）+ WS golden 对拍。
- **T2d** 四个 kick 点全部切 `SchedulerDriverPort`；加负扫描「`task.ts` 除注释外
  无 `runTask(`」；延续 kick 计数锁。
- **T2e** 断 B1（`scheduler.ts:205` 静态边；消费仅 `:9348-9350`）。
- **T2f** 断 B2（cancel）：必须保留 `cascadeFromParent` 语义并等 stop receipt；
  **`catch` 不得吞掉端口错误**。
- **T2g** 断 B3/B4（resume / isActive）：resume 用独立窄 DTO，不引 `StartTaskDeps`。
- **T2h** C1 转静态 + import-order smoke + `build:binary` + 单二进制启动 smoke。
- **T2i** C2 收编为内部 participant（`LaunchFrozenWorkgroupChild`，见 design §7）
  + call-workgroup E2E 对拍 + CALL_FACES 更新；同刀做 C1/C2 的初始化锁复跑。

> A1 在 T2d-T2g 全部完成后删除；那一刀同步删除 depcheck 前 5 条账（按实跑 exact
> tuple，禁预测性预登记）。

### G2 / G3 / G5

- **T3** workspace lease：`materializingSpaces` + `finishClaimedWebhookWorkspacePrune`
  一并迁走（G5），保留「mkdir 前登记、落行/清理后释放」的竞态保证。
- **T4** materialization 符号级迁移（design §4 清单）+ 窄 `MaterializeDeps`；
  `runDeferredRepoPreparation` 等编排留 application 经 port 调用。
- **T5** read model 三分（design §5）：窄义 `getTask` / node-run projection →
  application queries；archived events + stdout → log/artifact query（经 port
  读 FS）；`getTaskDiff` → source-control / workspace-insight；
  `minimalNodePaths` 提成无 IO 投影。`expandService.ts:12` 改锚（E3 断，销第 6 条账）。

### G4 归位与收缩

- **T6** scheduler **纯符号归位刀**：按 T1 的 inventory 把 `Frontier` /
  `deriveFrontier` / `buildContainerMap` / `isFresherNodeRun` / envelope-retry /
  prior-output / upstream-inputs / wrapper-iso / fanout-key 各归 owner；
  同刀改 `lifecycleRepair/options-S1.ts:24` 与 28 个测试文件的 import
  （源码提交与改锚提交分离）。
- **T7** export 收缩锁：consumer 清零后上白名单断言（只留 `runTask` /
  `RunTaskOptions` / `buildWorkgroupHooks` 级）+ rfc257 同型源锁
  （scheduler 禁 import task）。零外部 consumer 的类型单独去 export。

### G6 三族环外扩（各自独立可回退）

- **T8** `agent ↔ agentDeps ↔ agentResourceIntegrity`（3 成员）
- **T9** `gitRepoCache ↔ repoGroup`（**不含** `util/git` 分层倒置族）
- **T10** `workflow ↔ workflow.validator`

### 收尾

- **T11** fixture 与账本：`depcheck-gate.test.ts` 的 `KNOWN_CYCLE` 改名
  `SYNTHETIC_CYCLE`（或改为从 `KNOWN_VIOLATIONS` 取样并断言存在），一并处理
  `:78` / `:85` / `:143-152` / `:301`；depcheck 头注计数更新。
- **T12** 终局 Tarjan 棘轮：复用 depcruise 原始 `modules` 图源做 SCC 投影，
  扩 `CruiseDependency` 携带 `dependencyTypes`；断言 backend 零值级 SCC。
- **T13** 文档账本同步：2026-08-03 审计 ⓪ 回填、RFC-294 §5.2/§16.2 状态、
  `design/plan.md` RFC 索引、`STATE.md`。
- **T14** 实现门（双路独立子代理）+ 全量 `gate:local` + exact-SHA CI。

## 2. 依赖

```
T0 ─────────────────────────────────────────────► 随时可先行
T1 ──► T2a ──► T2b ──► T2c ──► T2d ──► T2e ──► T2f ──► T2g ──► T2h ──► T2i
                              └──────────► A1 删除 + 销前 5 条账（T2g 后）
T2* ──► T3 ──► T4
T2* ──► T5（销第 6 条账，需 T3 的 lease 先落）
T1 ──► T6 ──► T7
T8 / T9 / T10 独立，可与主线并行但需避开同文件窗口
T11 / T12 / T13 ──► T14
```

- **硬前置**：P0-D + W0-R 汇合（RFC-294 §16.2 / plan §3.1）。
- 与 RFC-289（已按 RFC-294 §5.3 冻结）及其他触及 `task.ts` / `scheduler.ts`
  的工作共用 §0 的排它窗口。

## 3. 验收清单

- [ ] AC-1…AC-10（proposal §6）
- [ ] 零能力变化，且 proposal §4 的五项保真项各有锁
- [ ] RFC-294 落位表逐行落实；偏离项台账无新增未确认项
- [ ] 每刀：depcheck 零 unknown / 零 stale + `gate:local` 全绿 + exact-SHA CI 绿
- [ ] 环地图（design §1）更新为终态
