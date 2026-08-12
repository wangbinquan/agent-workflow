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
