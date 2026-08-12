# RFC-284 — 任务分解（plan）

> 批次原则：每批独立可提交（pin worktree gate 全绿），先对拍后删旧；
> 依赖最少的先行。webhook 批显式 blocked by RFC-283。

## 批次与任务

### 批 A（防护制度先行——让后续批次在新护栏下进行）

- T1 spawn 棘轮 allowlist 测试（design §3.7）。
- T2 dep-cruiser 三条新规则 + KNOWN_VIOLATIONS 记账（design §4；routes→db 18 文件逐一入账带 removeWhen；**三规则加 type-only 过滤**；**过渡账目**：`auth/session.ts→services/authLoginPolicy` 现存反向边入账 removeWhen=T24、`ws/revalidationHook` 豁免注明；webhook 两路由账目与 T28 先后耦合注明——后落地一方同步清账防 depcheck 过期棘轮红）。
- T3 resourcePolicy 删 'agent' + schema 反射守卫 + 变异实证（design §2.5；含 selfCheck 输出复核）。
- T4 selfCheck 蕴含守卫（design §3.1）。

### 批 B（微 helper 收口）

- T5 safeJson（§1.1，按语义族收口为两 util，含 20 份逐一 diff 对照表；**webhookEndpoints/webhookTriggers 两文件的迁移子项挪 T28**）。
- T6 containment 双查（§1.2，四象限行为锁先行）。
- T7 hash + drained race + monotonicNow（§1.3/1.4/1.6）。
- T8 spawnVersionProbe 三胞胎收编（§1.5）。

### 批 C（资源侧）

- T9 反查泛型 + scheduled 扫描单点（§2.1/2.2）。
- T10 by-resource grant SQL + 快照式可见性收编（§2.3/2.4，行为矩阵快照先行）。
- T11 bundle initialAcl + skill 唯一性共享化（§2.5 尾两项）。
- T12 fence 选型表文档（§2.6）。

### 批 D（runtime/执行器；开工前 `git status` 确认 runner.ts/claudeCode driver/runtime types 等高频面无他人在途改动）

- T13 mcpRuntimeTest cast + MAX_STREAM_LINE_CHARS（§3.2/3.5 尾）。
- T14 drainTimedOut 观测面（§3.4，shared schema 可选字段 + 前端 banner i18n）。
- T15 session-not-found 下沉 driver（§3.3；claude 措辞须实测采样，采不到则登记）。
- T16 pluginInstaller 收编 runManagedProcess（§3.5）。
- T17 probeIndexer/runIndexer/probeInterpreter 治理（§3.5）。
- T18 git 双点文本锁（§3.5）。
- T19 opencode-models 迁移 + evictBinaryCaches 能力面 + resolveOpencodeCmd 删除 + legacy ctx @deprecated（§3.6）。

### 批 E（调度/任务侧）

- T20 buildChildDeps 整体透传（§4，对拍全字段）。
- T21 nextRetryIndex 收编（§4）。
- T22 agentRefOfNode 迁移 + S4 阈值 + cadence 注册表（§4）。
- T23 diffSplit 删除 + wrapperProgress.phase 删（§4）。

### 批 F（边界与归位）

- T24 authLoginPolicy 迁 auth/（§4）。
- T25 buildClosureRefNameMaps 下沉 + multipart 编排归位（§4，两臂对拍）。
- T26 env 开关文档化 + AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS 改 opts（§4）。**mcp/tools StartTaskSchema 锚挪 T28**（RFC-283 同文件冲突）。
- T27 clarify 家族迁移（§4，D18 示范；迁移前确认工作树）。
- T28 【blocked by RFC-283 完工】webhook CRUD 抽 service + webhook 两路由的 safeJson 迁移（自 T5 挪入）+ mcp/tools StartTaskSchema 锚（自 T26 挪入）+ T2 账目同步清账（§4）。

### 收尾

- T29 实现门（独立子代理对抗评审）+ findings 处置（纯实现自修；方向题反问用户）。
- T30 STATE.md / design/plan.md 索引 / audit-backlog 相应销账（含「containedSpawnRegistry 从未存在」条、backlog:64 进程治理面）。

## 依赖图

- 批 A 先行（T1 的 allowlist 在 T8/T16/T17 改动 spawn 站点时同步更新名单）。
- T6 先于 RFC-285 实现（285 不依赖，但共享 util 落位早于消费最稳）。
- T28 blocked by RFC-283；其余批间无硬依赖，按 A→B→C→D→E→F 顺序小步走。

## 验收清单（对应 proposal AC）

- [ ] AC-1 唯一性计数断言全绿（safeJson=1 / 双查=1 / sha1Hex=1 / spawnVersionProbe=1 / monotonicNow=1）
- [ ] AC-2 spawn 棘轮在位且变异实证红
- [ ] AC-3 selfCheck 蕴含守卫红→绿对
- [ ] AC-4 dep-cruiser 新规则 + 账本棘轮
- [ ] AC-5 resourcePolicy schema 反射守卫 + 变异红
- [ ] AC-6 clarify facade 迁移 gate 绿
- [ ] AC-7 各批对拍零漂移（C1-C6 白名单外）
- [ ] AC-8 每批 pin worktree gate + exact-SHA CI 绿

## 实施记录（2026-08-12）

已落 main（每批 pin worktree 门禁 + exact-SHA CI；本日多 session 满载期的门禁假红均按
「失败集全量枚举 → 逐文件隔离复跑 → CI 洁净房仲裁」归属，详见 dev-gotchas §测试/CI、§dev-env 新条）：

- **批 A**（bfcf7df9 + 补账 9807dced）：T1-T4——spawn 棘轮 23 站点 allowlist、dep-cruiser
  三规则 + KNOWN_VIOLATIONS 22 条、resourcePolicy 'agent' 死条目删除 + drizzle 反射守卫、
  selfCheck 蕴含守卫。
- **批 B**（a4854d1d / 2c9ef9a8 / e3be9d70）：T5-T8——safeJson 两 util、containment
  `checkLexicalThenRealpath` 单点、hash/monotonic/race 三组微件（26 文件 30+ 站点）、
  探针三胞胎收编 `spawnVersionProbe`（probe/models 双形态；整 chunk 上限语义诚实锁定）。
- **批 D/E 先行件**（56c953f3）：T13 cast、T22 S4 子任务阈值 + `daemonCadence` 注册表 +
  agentRefOfNode、T23 diffSplit 删除。该 commit 曾夹带并发 RFC 两文件半截，手术重建为
  父版+自改行后 amend（教训已落 dev-gotchas §git/多人协作）。
- **批 D/E 续**（b32c435b）：T17 探针治理三站点（scriptRun models 形态 / indexers 补 10s
  deadline / runner 树杀）+ T18 git 双点镜像文本锁。
- **批 D/E 续②**（1134954c）：T16 pluginInstaller 收编 runManagedProcess（proposal C7 补
  实测：信号死 exitCode 从 node `-1` 变 Bun `128+signal`=137；四路对拍锁）+ T19
  opencode-models 迁 `runtime/opencode/models.ts`、registry 改 `evictBinaryCaches?` 能力面
  盲调、`resolveOpencodeCmd` 删除（rfc143 锁改「零份」）、legacy ctx 两型 @deprecated。
- **批 F 先行**（42a6417e + 锁补 2e963484）：T26 env 登记面 `docs/env-flags.md` + src↔登记
  表同步守卫、`AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS` env 通道删除改 deps 注入（**实施偏差**：
  设计名 `ListRuntimesOpts.probeTimeoutMsForTest`，实装复用既有
  `runtimeDiagnosticTestDependencies` 测试缝，同语义未新造 opts 型）；T27 clarify 五文件迁
  `services/clarify/`（**实施偏差**：目录内去 `clarify` 前缀与既有 `clarify/service.ts`
  风格一致；家族内互引改兄弟相对路径；六处路径型源码锁改锚正体——前五处随批、第六处
  rfc128-p5-d 由钉住门禁抓出后补）。
- **批 C**（8d109b5f，= a69e1ad8 经共享分支 rebase 重放，16 文件跨 rebase 逐字节同）：
  T9-T12。**实施偏差**：§2.2 泛型落独立叶子 `scheduledTaskRefs.ts` 而非 scheduledTasks.ts
  本体——后者运行时 import workflow.ts（fire-time getWorkflow），按原落位 workflow.ts 反向
  引用即成 runtime cycle；scheduledTasks.ts 保留 design 命名的薄再导出面。
  `scheduledRowsReferencingWorkflow` 保留薄委托（rfc202 消费方零改动）。§2.3 现实比 design
  多两处点查（canView 双点），以 `grantsOfResourceWhere` 组合式顺带收编。
  **随批新发现（登记不修）**：`skill-version-op` / `skill-reserve-op` 在 126 文件单进程同跑
  下存在**存量顺序耦合**（stash 基线复现同款双红、隔离与小组合全绿；门禁 `--isolate` 分片
  天然规避）。
- **T30 部分**（本 docs commit）：STATE.md 进展、dev-gotchas 四条（携带检测器/门禁 exit
  吞噬/静默窗口/环境基线指纹 + CI 判定饿死）、audit-backlog centralized-answer-pane 复发
  数据点。

- **T28**（4e6aec66）：webhook 两路由（456+324 行）薄壳化下沉新
  services/webhook{Triggers,Endpoints}.ts；本地 safeJson 收编 util（T5 豁免清单
  按契约清空）；mcp launch_task inputSchema satisfies StartTaskSchema 键集镜像；
  depcheck 账本 -2 销账 +2 改口径；rfc257 错误码锁改锚 service 正体。保真判据
  = webhook 全家 142/142（93009 提供清单）。
- **T21 + §3.5 尾项**（a922f8af）：nextRetryIndex 七站点收编（scheduler 比 design
  记载多一处 :5307；**实施偏差**：纯函数吃预读行集而非 design 草稿的自带查询
  签名——五调用点行集读法/事务性各异，行为不变优先）；s13 freshest-fork 守卫
  G3/G8 随批改锚（G8 白名单 task.ts→nodeRunMint.ts，正是其「新文件必审」设计
  预期）；runner MAX_STREAM_LINE_CHARS 改 re-export managedProcess 单点。
- **T20**（本 commit）：buildChildDeps 继承面收口。**实施偏差**：design 草稿的
  「拆 inheritable 嵌套子对象」会连坐两型全部构造点且合并两侧字段注释；实装为
  INHERITABLE_RUN_CONFIG_KEYS 注册表 + Pick 派生型 + pickInheritableRunConfig
  整体透传（undefined 不落键与旧展开同构）。双向锁 rfc284-t20-child-inheritance
  .test.ts：处置表 satisfies Record<keyof RunTaskOptions,…> 编译期穷尽（31 键
  = 4 per-task + 15 inherit + 12 dropped-registered），dropped 12 键逐字段处置
  已登记（scriptInterpreters/scriptDeps/codeHostConnections/codeHostFetch 标
  「疑似漏配待另立」；fanoutMaxShardTotal 事实等效；commitPush×5/mergeAgent×2
  刻意不继承）。

- **T24**（e6217c05）：authLoginPolicy 迁 auth/loginPolicy（D22 归位，7 importer
  改路径无 facade；账本过渡条按 removeWhen 销账——过期条目检查删条前如设计般红，
  棘轮闭环实证）。
- **T25**（f4ef23b1）：loadClosureRefNames 下沉 services/agent + multipart 编排体
  独立成 services/multipartTaskStart.ts。**实施勘误/定形**：审计锚 :1298-1516 的
  骨架半截已被 RFC-218 先行；编排体并入骨架文件会经 launchMultipart⇄agentLaunch
  闭合运行时环（no-circular 实抓），中途的 startExecution 注入方案随「独立模块」
  定形撤销。四条路径/计数锁改锚（rfc165/107/103/104）。
- **T14**（fcead748；runner 半场被并发 commit 565c9b05 按仓规携带，本 commit 补齐
  shared/前端使链自洽）：drainTimedOut → 结构化 warn + record 仅真值附加可选
  outputTailTruncated（NULL 列 run 不合成占位——设计门裁决）+ envelope-missing
  文案条件前缀 + banner 专属行与 hasFindings ⊇ 关系保持；smoke/distiller 半场
  经查已由 RFC-280 T7 failSink 先行覆盖，登记不重复实现。
- **T15**（本 commit）：detectSessionNotFound? 下沉 driver 能力面——opencode 四
  正则迁 runtime/opencode/util；**claude 措辞实测采样兑现**（本机 CLI 双失败形态
  各采一条：`No conversation found with session ID:` / `--resume requires a valid
  session ID … not a UUID and does not match any session title`），scheduler 唯一
  消费点改按 frozenRuntime.protocol 盲调，sessionModeFallback 回归纯 pre-spawn
  决策；跨 driver 措辞不串锁随批。

**剩余**：T29 实现门（独立子代理对抗评审，一次覆盖全 RFC）+ T30 收尾
（design/plan.md 索引状态刷新 + STATE.md 终账 + 「疑似漏配」四字段与坟场清理
呈用户拍板）。
