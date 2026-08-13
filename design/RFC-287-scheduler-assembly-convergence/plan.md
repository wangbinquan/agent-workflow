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

**注意**：本线不是顶层函数，而是 `buildWorkgroupHooks` 工厂内的 `runHostNode`；许可不是
信号量而是外部传入的 `releaseGlobal`，故 `pools` 需以 `{ acquire: async () => releaseGlobal }`
形态适配（已验证类型可行）。
