# RFC-287 — 任务分解（plan）

> 前置：RFC-284/285/286 已完工。**本 RFC 落档后须用户批准方可实现**
> （CLAUDE.md RFC workflow §3）。每批第一子任务=逐锚复核（行号基线 83088a83）。
> 2026-08-13 设计门修订版（P1-1/P1-2 契约重写 + P2 批量勘误已入
> proposal/design；本 plan 同步 T1 扩容与冲突面表述）。

## 批次

- T1 逐锚复核 + 对拍基线（P2-5 扩容，五件）：九线锚点核对；①scheduler.ts
  源码文本锁全量清单（≥20 文件）+ 逐条改锚方案；②L4/L7 merge-throw 行为
  夹具（兼 AC-3 红，替 rfc210 文本兜底）；③L1 双处置行为夹具（throw→replay
  可续 / conflict→abandon+failed）；④广播序列快照（L4 逐 attempt vs L5/L6
  单点两形态）；⑤iso discard 失败 warn 路径；外加 L4 三台机器现状夹具
  （拆分前 oracle，锚用勘误后 :5432/:5440-5464/:5905-5935/:5956）。
  **第二轮设计门补两件**：⑥ L5/L6 的 merge-throw keep 行为夹具（今天它们的 keep
  语义**只**由 `rfc210-publish-failure-hard-fails.test.ts:194-198` 的源码文本锁兜着，
  T1 原五件只替 L4/L7/L1，改锚后 L5/L6 彻底失去预言力）；⑦ 跨文件重锚同测试
  :227-231 的安全棘轮（`discardNodeIso(...)` 单行调用 **≥8 处且每处带 writeSem**
  ——它锁的是 RFC-210 round-6 的锚点交接不变量；骨架抽取后 scheduler.ts 内站点从
  13 掉到约 6，而该测试**只 read scheduler.ts**，把阈值改小即静默失守。必须改成
  同时扫 `schedulerAssembly.ts` 并按新分布重定基）；⑧ **rfc208 两条 oracle 重锚**
  （释放序 + try-depth 扫描器，后者在骨架抽走 acquire/release 后结构性失效）；
  ⑨ 三个行为面的夹具：线级抛出载荷（L5/L6 抛出即重试）、persistIsoBase 抛出结局、
  park 的 keep 分歧。

  > **T1-⑨ 提前于 T2**（第三轮门）：线级抛出载荷 / persistIsoBase 抛出结局 / park 的
  > keep 分歧这三条夹具的实测结果，是复核 §10.10 中 persistIsoBase 相位定案的判据来源。

- T2 骨架落地（G1）：assembly.ts + 单元测试（pools/keep 域含 park 短路/
  merge 默认三态 + disposition 覆写/漂移 A 语义/beforeSpawn 抛出=装配失败）；
  双模式窗口（per-attempt / 跨 attempt+retryPolicy）都有直测；此批不迁移
  任何线。
- T3 L6 迁移（最小对照）+ fanout aggregator 全家绿。
- T4 L5 迁移（beforeSpawn=T14 undo 钩子）+ shard 全家绿。
- T5 L7 迁移 + **漂移 A 红→绿对**（merge 抛出：楔死复现 → keep+
  markMergeFailed）+ rfc253 全家绿；F6 设计门注释改写。
- T6 L1 迁移（preResolved 行变体 + **disposition 覆写声明**：onThrow=
  keepHookIso+rethrow、onConflictHuman=abandon+failed，各带豁免锁）+
  workgroup 全家绿（rfc187-wg-merge-conflict-abandon 必绿）。
- T7 L4 拆分手术（outer + 模式 B assembly + retryPolicy 策略对象；iso 跨
  attempt 稳定性 D17 断言）+ 真实 followup 套件（scheduler-envelope-
  followup-branch / port-validation-followup-decide / rfc092 / rfc122 /
  rfc123 / rfc131 / rfc161 / rfc193）+ 拆分对拍夹具绿。
- T8 取行前奏收编 resolveSchedulerRunRow（4 份 → 1 + overrides）+
  L8 preResolved 短路。
- T9 G3 豁免显式化四锁 + 终局灭绝锁（骨架外散写归零）。
- T10 配额面可配（G4，独立 commit，**不与收敛批混提**）：设置页补三项 + i18n +
  过期头注修正（**只改池数表述，不动「峰值子进程=agent+script」那句**）+ 测试
  （含「设置页覆盖全部 6 项」的防漏锁）。**第二轮设计门追加（C9 后端修复）**：
  childBudget 单例闭包改读 live config、PUT 后触发 `scan()`、`maxInvocationDepth`
  读点、修「子任务启动把 daemon 级池 resize 回旧值」的既存 bug、
  `settings-drafts.ts` 最小写入白名单登记新三项、定 `max` 来源使 `rangeHint` 可渲染。
- T11 G5 `file://` 下线（独立 commit）。**第一件事是重算连带面**（第三轮门：e2e
  19 spec ≈30 处含 `pathToFileURL` 写法、backend 经 HTTP 面 9 文件、共享夹具
  `repoGroupFixture` 的 13 个下游），并把 `submoduleRefresh.ts:92` 的后台自动保鲜
  纳入拒绝面。**前置子任务**：e2e 改用
  `git daemon` 起真实远端（`e2e/commit-push.spec.ts` 现依赖 `file://` 经公开面），
  先绿再拒。然后三处入口拒绝（手动/定时/webhook）+ 内外通道源码锁 + 存量不
  grandfather 的启动校验拒绝（proposal §7）。
- T12 G6 窗口化重试与硬失败（独立 commit）：错误分类纯函数 + 窗口重试 + 红→绿对
  （网络类重试成功 / 窗口耗尽失败 / 鉴权类不重试）。
- T13 G7 准备成为 `runTask` 认领后的第 0 步（**最大一批，独立 commit**）：
  ①`worktreePath` 消费点清点分类（src 49 文件 / 519 处）+ 前端消费面；
  ②任务仍落 pending + AbortController 于 INSERT 后前置注册 + 准备作为第 0 步
  （三个 runTask 调用点自动共享）+ 回写前状态 CAS + **AbortSignal 串进 `runGit`/
  `spawnGit` 使取消真杀子进程** + `gitCloneTimeoutMs` 启动路径接线；
  ③合成 `__repo_prep__` 运行记录（同 `__commit_push__` 先例）与时间线展示；
  ④失败落该行 + 任务 failed，git stderr 原文可读；⑤重试复用 `retryNode`；
  ⑥boot reap / auto-resume 识别「准备未完成」改重跑准备；⑦其余随物化落库字段
  （含 `task_repos` / `task_space_nodes`）的占位与回填时序 + 所有权/清理协议新形态
  - `TaskStatusUpdateExtra` 白名单取舍；⑧C7 边界（有上传分支保持同步）；
    ⑨`stuckTaskDetector` / `childBudget` / `workgroup room` / `worktreeBackup` 按
    「准备中=running」复核。
- T14 实现门（双路独立子代理，按半场切）+ plan/STATE 记账。

> **T11-T13 顺序更正（启动路径半场 P2-5/P2-12）**：原序 T11(G5)→T12(G6)→T13(G7)
> 有两处隐患。①`resolveCachedRepo` 今天在 HTTP 请求内同步执行且每仓一次，先落
> G6 的窗口 = 启动接口最长阻塞 N×60s ⇒ **改为 T11(G5) → T13(G7 异步化) →
> T12(G6 窗口)**，或在 T12 声明窗口只在异步准备段生效。②T11 与 T12 都改
> `gitRepoCache.ts:501-518` 同一区（G5 后该 file 分支只剩内部通道可达，G6 重写
> 整块）——先后与冲突处置在实现时按此序解。三批仍各自独立 commit、可单独回退。

## 依赖

- T2 依赖 T1；T3-T6 依赖 T2、彼此独立但按序单批推进；T7 依赖 T1 夹具 +
  T2；T8 依赖 T3-T7 全落（改它们的取行段）；T9/T10 收尾。
- 冲突面（P3-10 勘误表述）：与 RFC-288/289 **同文件（scheduler.ts）且区域
  相邻**——289 的 fanout 内链贴 L5/L6 接缝、288 的 SCC 拆解会移码毁锚；
  靠 D3 既定顺序（287→288→289）严格串行消解，接手时按新基线重跑逐锚复核。

## 验收清单

- [ ] AC-1…AC-13（proposal §5；含第二轮新增的 AC-7 改写、AC-12 fanout abandon
      红→绿、AC-13 discard 失败不逃出 finally）
- [ ] C 表（C1/C2/C3）之外零行为差异（对拍豁免声明适用）
- [ ] 九线地图更新为终态（design §1 追记）

## 实施记录（2026-08-13）

**已完成并上库（门禁 + CI 逐批全绿）**：

- **T1** 六个夹具文件：源码锁全量账本（85 文件，机器可核，动一个必须同步一个，并钉死
  三份「必须换行为夹具、不许改锚了事」）、抛出结局、合并处置矩阵、释放先于清理（跨
  文件结构锁）、广播序列快照、清理失败处置基线。三条带变异实证。
- **T2** 骨架 `services/schedulerAssembly.ts` + 单测。三条核心契约各自单独变异**都恰
  红 1 条**（测试与契约一一对应，不是靠一条大断言糊过去）。
- **T3** 聚合线迁入。**验出骨架两处契约缺口**：`mergeBack.run` 拿不到 spawn 结果
  （真实合并要用其 portFilePaths）、合并返回类型按想象写窄了（真实原语是
  `merged | conflict-human`）。
- **T4** 分片线迁入。T14 undo 落 `beforeSpawn`（逐仓自兜、整体在物化 try 内，与契约
  吻合）。连带修 RFC-066 PB-G2 并**顺手加强**（放宽变量名匹配面的同时补反向断言，
  防止 `templateMeta` 回退到直接摊 `state.repos`）。
- **T5a** 漂移 A 根治（C1，本 RFC 唯一行为变更，先红后绿）+ 撞冲突改**显式**保留
  （C2 会让原来的「谓词碰巧」失效）。
- **T5b**（原 plan 无此批，实现时发现骨架漏实现模式 B 而拆出）跨 attempt 窗口的
  `retryPolicy`。**变异实证逼出一个真缺陷**：循环原本无硬上限，`shouldRetry` 永返真
  即在 daemon 里无限自旋且全程占许可与 iso ⇒ 已补保险丝。
- **T5c** 脚本线迁入（模式 B 首个消费者）。**再验出一处契约缺口**：模式 B 的 `spawn`
  必须知道 attempt 序号。收尾删掉迁移后不可达的旧结局（留着比删掉更危险）。

**每批的固定动作**（后续批次沿用）：逐锚复核 → 迁移 → 家族全套件 → 夹具/源码锁按预期
变红后**逐条改锚**（断言形态跟着代码形态走，绝不删断言）→ 计数型棘轮改数字时**必须
写明为什么变** → 变异实证 → pin worktree 全量门禁 → 推送 → exact-SHA CI。

---

## T6 接手指引（工作组主机线，已测绘未动刀）

**为什么单独留出**：它是五条里处置最全的一条，spawn 之后是一大段带**多处早退**的分支，
需要精细手术；赶工做完但验不透违背「严格保功能」的要求，故留给有完整上下文的一轮。

**四种处置全用到**（锚基线 `6d00ba63`）：

| 处置                             | 锚         | 要点                                                                                                                                                                                                                                      |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| park（clarify 停靠）             | :1286-1305 | **两种结局都在窗口内产出**：等待人工 / 迟到抑制后判失败（`lateSuppress()`）⇒ 必须走 `then: { produce }` 而非 `'settle'`；design §10.2 明写 L1 的 produce 必须留在窗口内（其 clarify 落库不纯，移出会把落库与 iso discard 的先后静默调换） |
| abandon（RFC-167 discardWrites） | :1316-1330 | 丢弃写入 + `tryTransitionMergeState(abandon,'discard-writes')` + 判 **done** + finally 照常 discard；与 park 完全相反                                                                                                                     |
| onThrow 覆写                     | :1354-1360 | `keepHookIso` + **重抛**，merge_state 留 `pending-merge` 交 entry replay（**不**打 markMergeFailed——与 DAG 各线相反，源注明说）                                                                                                           |
| onConflictHuman 覆写             | :1370-1380 | abandon + failed（RFC-187 T8：本线 finally 无条件清理 iso，许不起「留着给人解」的承诺；留状态不留树会让下次 resume 去找已 GC 的提交并**打挂整个任务**）                                                                                   |

另有 `processUnreaped ⇒ keepHookIso`（:1171，第五维）与 `passthrough` 门控（:1316/:1327）。

**三处覆写各自必须带豁免锁**（design §10.2「凡覆写必须带豁免锁」）；`rfc187-wg-merge-conflict-abandon`
与 `rfc167-dynamic-workflow-engine` 是现成的行为锁，迁移后须仍绿。

**注意**：本线不是顶层函数，而是 `buildWorkgroupHooks` 工厂内的 `runHostNode`。

### T6 实施记录（2026-08-13，已完成）

**切法**：spawn **把早退结局原样打包传出**（判别式 `HostSpawn = {kind:'early',out} | {kind:'ran',…}`），
骨架只管相位与清理。这样 spawn 之后那段带多处早退的分支（clarify 停靠两种结局、canceled、
非 done）**逐字保留**，不需要为迁移而重构——上面担心的「精细手术」由此降为可控改动。

**顺手改掉的一处**：接手指引写的 `pools: [{ acquire: async () => releaseGlobal }]`（外面先抢
许可、再把释放函数传进骨架）**没有采纳**——那样会留出「抢到许可 ~ 进 `runAssembly`」这段
无人兜底的窗口，正是 RFC-208 那类漏 permit 的形状。改为 `pools: [state.agentSem]`，许可由
骨架自取自放；脚本线的 `{ acquire: () => scriptSem.acquire() }` 包装同批改成 `[scriptSem]`，
全五条线同一口径。

**改锚 6 件**（全部做过变异实证，逐条确认变红）：

| 文件                                    | 原形态                                           | 新形态                                             |
| --------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `rfc287-t1-merge-disposition-matrix`    | 分支体含 `keepHookIso = true` + `throw err`      | spec 上 `onThrow → keep:true/rethrow`、`onConflictHuman → keep:false` |
| `rfc210-publish-failure-hard-fails`     | `if (!keepHookIso) await discardNodeIso(...)`   | spec 声明浅锁（逐格断言归矩阵夹具）                |
| `rfc287-t1-discard-failure-paths`       | finally 里 try/catch 吞                          | 骨架统一 `.catch(+warn)`；**反向**禁本线自兜        |
| `rfc287-t1-release-before-discard`      | 只认 `discardNodeIso(`/具名 release             | 补认骨架的 `spec.discardIso(`/匿名 `release()`     |
| `rfc208-unbounded-git-and-permits`      | 扫 scheduler.ts 函数体（已结构性失效）           | 不变量重钉到骨架 + 防零覆盖改判「两种形态择一」     |
| `process-node-concurrency`              | `toContain('scriptSem.acquire()')`               | 钉死整张池清单 `pools: [scriptSem]`（更强）         |

**两处自查出的真缺口**（不是 T6 引入的，是被 T6 照出来的）：

1. `rfc287-t1-release-before-discard` 自称「跨文件结构锁、对代码搬到哪个文件免疫」，但它
   只对**文件**免疫、没对**名字**免疫——骨架把释放写成匿名 `release()`、清理写成
   `spec.discardIso(`，两者都不在名单里，于是这条锁**从未真正扫到骨架**，而骨架恰是迁移后
   该不变量唯一还成立的地方。已补两种形状并单独钉死「骨架那个 finally 必须在被扫之列」。
2. T6 重构时把 `projectOutputs` 复制成了两份，IIFE 里那份成死代码——`--max-warnings 0`
   当场抓出。已删死副本、注释归位。

**剩余未迁**：只剩 agent 线（T7）。`rfc287-t1-discard-failure-paths` 的「完全没兜」现状条目
与 `rfc208` 的直线取许可扫描，都只剩它一个消费者，T7 迁完即可一并收口。

---

## T7 实施记录（2026-08-13，已完成——五条线迁移到此收官）

**形态**：模式 B。一次许可 + 一棵 iso 贯穿全部 attempt，窗口内由 `retryPolicy` 驱动 1..N 次
spawn；D17 要求同会话续跑落在同一棵树上，正是 `isoOnRetry.keepIf` 的语义。

**拆分手术切在哪**：窗口只到「合并相位收束」为止，**clarify 落库那段收尾留在窗口外**。
现状顺序是「先释放许可 + 按 keep 清理 iso，再建 clarify 轮次」；把收尾挪进窗口会让
daemon 级 agent 许可多握住一段 DB 写——那是行为变更不是重构。故 `TResult` 取判别式
`{ kind: 'settled', out } | { kind: 'ran', result }`：窗口内已定局的直接回传，需要窗口外
收尾的回 `'ran'`，窗口外那 120 行逐字未动。

**又验出一处骨架契约缺口（第 4 处）**：`isoOnRetry.keepIf` 原为同步，而 agent 线的留树
判据就是 RFC-042 续跑决策，它要读上一次 attempt 的 text 事件计数与 port 校验失败记录
——**同步签名根本接不住**。改为允许返回 `boolean | Promise<boolean>`。

同时把**每次重试内的调用序写成契约**并用骨架单测钉死：

    shouldRetry → keepIf →〔不留树时 discardIso + iso.create〕→ onNextAttempt → spawn

agent 线依赖它：`keepIf` 里算出的决策 memo 进闭包，`onNextAttempt`（铸行带不带
envelopeNonce、写哪种审计事件）与 `spawn`（发不发续跑短提示、带不带 resumeSessionId）
随后各读一次。序一变那三处就会读到上一轮的决策——静默错，且只在重试路径上现形。

**TS 的一处真实限制**（值得记）：`lastResult` 是闭包上的 `let`，窗口内由 spawn / markMergeFailed
改写，但 TS 的控制流分析**看不见闭包里的赋值**，于是窗口外把它收窄成 `never`。解法不是
`as`：让 `settle` 把值随判别式带出来，窗口外 `lastResult = windowOut.result` 直线回填，
控制流自然复位。

**改锚 8 件**（全部变异实证过）：

| 文件                                 | 变化                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| `rfc287-t1-merge-disposition-matrix` | throw 列**翻面**：从「各线各写一份 keep+markMergeFailed」改为「谁都不许再自己写」；conflict 列改读 spec 声明 |
| `rfc287-t1-line-throw-disposition`   | clarify 停靠改读 `skip:'park', keep:true`                        |
| `rfc287-t1-discard-failure-paths`    | **翻面**：从「剩余未迁线仍是完全没兜」改为「scheduler.ts 里不得再有 finally-discard」 |
| `rfc287-t1-release-before-discard`   | 下限降到 1（骨架那一处）并注明**永不再降**——再降就是关锁         |
| `rfc208` oracle #1                   | 扫描面并入骨架（scheduler.ts 已无此形状的 finally）              |
| `rfc210-publish-failure-hard-fails`  | agent 线改锁「走骨架默认处置」：声明 markMergeFailed 钩子且无 onThrow 覆写 |
| `rfc122-clarify-directive-dispatch`  | 「循环体内」等价改写为「`runOneAttempt` 体内」+ 反向禁其落在窗口外前奏 |
| `rfc188` 计数棘轮                    | `createIsoUnderLock` 8→7：首建与 fresh-session 重建收进同一个 `iso.create` 闭包（**站点合并，不是覆盖变少**） |

**核实过、因而没有动骨架的一处**：模式 B 在「换树失败」路径上不走 `keepFromOutcome`，
看似会丢掉 processUnreaped 那一维；但 `shouldRetryNodeFailure` 里 `processUnreaped ⇒ return false`
（`scheduler.ts:1593`），该组合在 agent 线**不可达**。为不可达路径改骨架属于臆测，不做。

**至此 G1 达成**：五条装配线（L1 工作组主机 / L4 agent / L5 分片 / L6 聚合 / L7 脚本）
全部走 `runAssembly`，许可取放、iso 生命周期、合并处置、清理兜底各只剩一处实现。

---

## T8 实施记录（2026-08-13，已完成）

**落位**：`resolveSchedulerRunRow` 放进 `services/nodeRunMint.ts`——`mintNodeRun` /
`schedulerMintCause` / `nextRetryIndex` 都在那里，同域；广播用回调注入，免得把 WS 层
拖进铸行模块。

**差异矩阵是实证出来的、不是照设计抄的**：用 difflib 把四份手抄逐行对差（以 L4 为基准），
差异恰好收敛到五项，与 design §10.3 逐格吻合：

| 维度                       | L4 agent | L7 script | L8 call | L9 code-host |
| -------------------------- | -------- | --------- | ------- | ------------ |
| 继承 reviewIteration       | ✔        | ✘         | ✔       | ✘            |
| 显式清 agentOverrideName   | ✔        | ✘         | ✔       | ✘            |
| 复用 pending 行时追 retryIndex | ✔    | ✔         | ✔       | **✘**        |
| 收尾广播 pending           | ✔        | ✔         | ✔       | **✘**        |
| 领养短路（preResolve）     | ✘        | ✘         | **✔**   | ✘            |

后两项的「✘」都是真语义、不能统一：L9 没有节点级重试（只有 HTTP 幂等重试），且它铸完
立刻转 running——多播一条 pending 会让前台看到一个不存在的中间态。

**L8 领养区按设计不进收编**：它复用一条 running/interrupted/canceled 的行并就地转
running，与「铸行」是两码事（在那里 mint 会把子任务的 canonical iso 判为 superseded）。
以 `preResolve` 回调短路——领养逻辑仍留在 L8 自己的代码区，RFC-243-LOCK 标记原样保留，
并新增一条「标记区间内不得出现 mintNodeRun」的反向锁。

**收编到位的硬证据**：`nextRetryIndex(` 与 `schedulerMintCause(` 在 `scheduler.ts` 里
**归零**（lint 的 unused-import 当场报出来），两者现在各只在收编函数里出现一次。

**顺带修一条既存 flaky（不是本 RFC 引入的）**：`scheduler-clarify-mid-batch` 的
「aggregation priority」用例真起两个 opencode 子进程（asker + crasher，后者还要走完协议
重试预算），单跑 5.4-5.6s，正好骑在 bun 默认 5000ms 上——**无负载下 3 跑红 2**，且在
迁移前的 `443ba01e` 上同样红。按仓规不靠重跑，给它与同文件另一条同档的 `20_000` 显式
预算并写清依据。（同批门禁里另外两条超时——`worktree-files-service` 与 `rfc131-review-
reject-aging` ——在隔离下各跑两次全绿，属我在门禁窗口内并发跑 tsc 造成的争用，
**不给它们加预算掩盖**，正确的修法是我别再制造争用。）

---

## T9 实施记录（2026-08-13，已完成）

新增 `rfc287-t9-exemptions-and-extinction.test.ts`（9 例），两组：

**① 四条豁免各带「理由锁」**——不是「这条线不许改」，而是**改动时先撞到理由**：

| 线                | 锁的是什么                                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| L3 合并 agent     | 绝不取池位（调用方全程持 writeSem，再等池位就闭合死锁环）+ 源注里的理由必须在 |
| L8 call           | 整线不迁；其许可是**带 signal 的配额 hold**（排队中可被取消 → 标 canceled），与信号量池位不同型 |
| L8 的可取消性     | 单独一条，指向 `rfc243-child-budget` 里那条真行为夹具「abort rejects a queued waiter」——统一时最易做丢的正是它 |
| L9 代码平台       | 没有节点级 retry（只有 HTTP 幂等重试）：无 attempt 循环、无 retryPolicy      |
| L2 commit-push    | 无池、无 iso（canonical 直跑）                                              |

**② 终局灭绝锁 + 三处显式挖洞**：五条迁移线里的 iso 物化只能**经装配 spec 到达**；
L8 整线 / wrapper 便车 / 恢复 replay 段三处显式允许直接物化，不被误伤。另加「五条线
不得再自己取/放池许可」与「骨架是唯一窗口实现」（后者与 T1⑤ 从两侧对拍，两边都塌
才可能漏过去）。

**灭绝锁的判据修过一次**：初版用「文本位置在 `runAssembly<` 之后」判定，当场误伤脚本线
——它把「首建 + fresh-retry 重建」收进一个提前声明的具名闭包 `createScriptIso` 再挂到
`iso.create`（T5c/T8 的收编产物），位置在前但**可达性**完全合规。改为真正判可达：
写在 spec 里，或宿主闭包被 spec 的 iso 块引用。后续又把「必须直接挂 `create: name`」
放宽为「iso 块引用即可」——套一层 arrow 语义等价，锁死会让无害重构变红。
用**真违规**（闭包不挂 spec、改在窗口外直线物化）复验仍红。

---

## T10 实施记录（2026-08-13，已完成）

**先修后端、再补前端**——第二轮设计门核实过「不是补三个输入框就完事」，本轮实测确认
六项里有两项根本不即时生效，且症状对用户完全不可见：

| 问题 | 实测到的行为 | 修法 |
| ---- | ------------ | ---- |
| `getNodePoolSemaphore` 是 **resize-on-read** | 每个 `runTask` 都把 daemon 级池改成**自己 opts 的值**；子任务继承父任务 opts，于是「配置改成 9 → 父任务在跑 → 派生子任务」这条日常路径上，用户的调整被静默撤销、无任何日志 | 新增 `mode: 'set' \| 'seed-only'`；三处任务启动改传 `seed-only`（池不存在才按该值创建），配置写入点仍用默认 `set` |
| `ensureChildTaskBudget` 的容量**凝固在第一个调用者的闭包**里 | 单例只在 `singleton === null` 时用调用方的 `capacity()`，之后永远读**首个**启动任务捕获的 opts；设置页改完要等 daemon 重启 | 容量改为模块级 live 值；`PUT /api/config` 用 `setChildTaskBudgetCapacity` 推入（与三个池热应用同一个线性化点） |

**原则一句话**：daemon 级配额的实时值只由配置写入点决定，任务启动只「取」不「改」。

前端补齐三项（`maxConcurrentCodeHostCalls` / `maxActiveChildTasks` / `maxInvocationDepth`）
到设置页的并发区，含中英双语 label+hint，并**同时登记进 `SETTINGS_CONFIG_SCOPE_KEYS.limits`
最小写入白名单**——漏登记的键在保存时被静默丢掉：表单能改、能点保存、不报错，值却不落盘。

`SETTINGS_NUMERIC_BOUNDS` 三项上界按语义分档而非照抄 256：代码平台调用是外发 HTTP
（256）、活跃子任务每个都会再撑开一整套池占用（64）、嵌套深度是防环护栏（16）。

三条变异实证：`seed-only` 退回 `set` / 白名单漏登记一项 / 设置页少一个输入框，各变红。
顺带改锚 `process-node-concurrency` 那条接线锁——它钉的是三处池获取的确切写法，现在
要求**必须带 `'seed-only'`**，否则回退到默认 `'set'` 无人察觉。

---

## T11 接手测绘（2026-08-13，已完成测绘、未动刀）

**连带面重算结果**（设计门要求「第一件事是重算」，实测数字）：

| 面 | 数量 |
| -- | ---- |
| e2e spec 含 `file://` / `pathToFileURL` | **21 个文件 / 50 处** |
| backend 经 HTTP 面的测试 | **14 个文件**（含共享夹具 `helpers/repoGroupFixture.ts`） |
| `repoGroupFixture` 的下游消费者 | **13 个文件** |
| src 里的 file 分支 | `gitRepoCache.ts:428/511/548/742` + `codeHost/project.ts:13/19` |

**落点结论（与初稿不同，实测改判）**：

- ❌ **不落在 `startTask`**：它是内部服务函数，HTTP 路由与大量测试共用同一个入口；
  在这里拒绝会把「内部通道」一起掐掉，与用户「不对用户开放、内部可用」的口径相悖。
- ❌ **不落在 `resolveCachedRepo`**：它更低层，`repoGroup.ts` / 刷新 / 后台保鲜都过它，
  但内部夹具也直接调它。
- ❌ **不落在 `taskLaunchGate` / `assertTriggerPreflight`**：前者只管工作流可见性与
  静态校验（生产里只有 `routes/tasks.ts:349` 一个调用方，注释所说的「三处共用」已
  与现状不符——这条**顺带修文档**）；后者管的是 trigger 依赖，与仓库源无关。
- ✅ **落在公共面的 zod schema**：JSON 路由、multipart 路由、定时任务 payload
  （`scheduledPayloadSchemaFor`）都经它解析，而内部服务层直接构造 spec 天然绕开
  ——这正好就是「内外通道」的天然分界，不需要新造一个旁路开关。

**因此实施顺序**：①先把 e2e 21 个 spec 与 backend 14 个 HTTP 面测试改用真实远端
（`git daemon` 起本地 HTTP/git 协议），**先全绿**；②再在 schema 上加拒绝 +
`submoduleRefresh.ts:92` 的后台自动保鲜纳入拒绝面；③补内外通道源码锁与存量不
grandfather 的启动校验拒绝。①是纯机械但量大的一批，不可与②混提。

---

## T13 子项①：`worktreePath` 消费点清点分类（2026-08-13，已完成清点）

计划把这一项排在 T13 第一位是对的——**清点结果推翻了「520 处都要审」这个前提**：

| 形态 | 处数 | 是否属风险面 |
| ---- | ---- | ------------ |
| read | 296 | 绝大多数是**形参传递**，不读任务态 |
| write/assign | 105 | 集中在物化与回填路径 |
| type-decl | 94 | 纯类型声明 |
| comment | 25 | — |

按文件看密度前八：`util/git.ts` 139、`scheduler.ts` 53、`task.ts` 49、
`structuralDiff/service.ts` 26、`nodeIsolation.ts` 24、`gc.ts` 20、`gitSubmodule.ts` 18、
`structuralDiff/gitBackend.ts` 12。其中 **`util/git.ts` 那 139 处全是形参**
（`resolveGitCommonDirSync(worktreePath: string)` 这一类），与任务是否已准备好无关。

**真正的风险面因此收敛到三处**——「任务已入库但工作树尚未物化」这个新中间态谁会读到：

1. `gc.ts`（20 处）——**已有先例**：它本来就在用 `t.worktreePath !== '' && existsSync(...)`
   做空值防御（:129/:144），说明「路径为空」这个形态在 GC 侧已经是可表达的；
2. `worktreeBackup`（1 文件）——需按「准备中=running」复核（子项⑨）；
3. 前端 22 处，集中在 `tasks.detail.tsx`(11) 与 `task-detail-tabs.ts`(7)——任务详情页要能
   呈现「正在准备仓库」而不是显示一个空路径或崩掉。

**因此 T13 的剩余工作量比原估小一档**，但仍是一次真正的启动路径重构：`startTask` 的
准备段横跨 :754→:2345（1591 行，中间夹着校验/ACL/仓组解析/space 节点等大量非准备逻辑），
真正的准备动作只有 4 处（`resolveCachedRepo`×2、`materializeWorktree`×2）。要把这 4 处
移出 HTTP 请求，需要 INSERT 时用占位路径落行，并新增「未准备好」这一合法中间态。
现状 `worktreePath: ''` **只出现在错误路径**（:611/:1665 的 earlyError），没有健康占位先例
——这正是子项②「任务仍落 pending + 准备作为第 0 步」要新建的东西。
