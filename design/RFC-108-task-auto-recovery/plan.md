# RFC-108 — 任务分解与 PR 拆分

> 读前置：`proposal.md`（决策 D1–D6）、`design.md`（接口契约 + 失败模式）。
> 原则：fortify-then-refactor（先护栏再动刀）；test-with-every-change（每条先红后绿）；所有自动执行**默认 OFF**；单一伞形 RFC、单一审批 gate、有序多 PR。

## 1. 任务编号（RFC-108-TN → AR-NN 缺口）

| 任务                                               | 缺口      | 标题                                                                                                                                                                                                      | effort | 默认状态                   |
| -------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------- |
| **PR-A 地基（无行为变更）**                        |
| T1                                                 | AR-12     | `nextTaskStatus(from,event)` 转移表 oracle + eslint `no-direct-task-status-write` + 增量迁移调用点                                                                                                        | M      | —                          |
| T2                                                 | AR-19     | 共享状态集模块（terminal/retryable/tone）穷举 + 前端 4 站接线                                                                                                                                             | S      | —                          |
| T3                                                 | AR-11     | `recovery_events` 表 + `recordRecoveryEvent` 原语 + 现有 5 actor 接线 + counters + `/api/recovery`(or /health)                                                                                            | M      | —                          |
| **PR-B 配置接线（P0 / 低风险 / 即时收益）**        |
| T4 ✅                                              | AR-01     | `resolveLaunchRuntimeConfig`（上移共享模块）透传 `defaultPerNodeTimeoutMs` → **全部 StartTaskDeps 站点**（tasks start/resume/retry/repair + clarify/review resume + fusion，30min 硬超时下限，可配 — D2） | S      | **生效**（行为变更）       |
| ~~T5~~                                             | AR-02     | per-task 预算自动默认——**移出 PR-B / 不做**（Codex 实现 gate P1：stale-config 1h 误杀，canceled 非 resumable；需 config-migration 框架，推后续）。显式 `input.maxDuration/Tokens` 仍生效                  | —      | 不做                       |
| **PR-C 独立安全/正确性修复**                       |
| T6 ◑                                               | AR-15     | resume worktree-missing 410 前检 ✅（existsSync 门、resume-only gated，commit 见 §9）；**GC-side 推后续**（gc.ts 排除可恢复 + 多仓 repoCount-aware，有磁盘泄漏权衡）                                      | M      | 前检生效                   |
| T7 ✅                                              | AR-17     | resume 跨 node_run 回滚 all-or-nothing（`checkOnly` dry-run 预检，覆盖 resume+sync）                                                                                                                      | S      | 生效                       |
| T8 ✅                                              | AR-16     | S2 cross-clarify 误杀修复（改读 `clarify_rounds`）                                                                                                                                                        | S      | 生效                       |
| T9 ✅                                              | AR-14     | fail-safe survivor-kill：持久化 `spawn_binary_path`(0051) 精确匹配 + resume/retry 在 `kill-failed` 拒绝(409，不在活进程下 git-reset) + orphans 升 error                                                   | M      | 生效                       |
| T10                                                | AR-13     | 写时 U1 partial unique index（shadow→enforce）+ per-rule reconcile grace                                                                                                                                  | M      | shadow 先行                |
| **PR-D 四道安全护栏（默认关闭 / alert-only）**     |
| T11                                                | AR-09     | 熔断 + 隔离（attempts 计数 + 退避 + `auto_recovery_suspended` soft flag 经 nextTaskStatus + 一键清）                                                                                                      | M      | 计数生效、隔离待自动 loop  |
| T12                                                | AR-08     | driver-lease 原语 + `touchesLiveState` 标注 + 引擎级 gate + boot 清陈旧 lease + DB seam                                                                                                                   | M      | 替换 isTaskActive 约定     |
| T13                                                | AR-07     | `autoApplyEligible` 分类器（RepairOptionMeta 加字段）+ 标注 + property 测试锚                                                                                                                             | S      | 元数据 only                |
| **PR-E 检测扩展 + 廉价可观测**                     |
| T14                                                | AR-06     | S6 成员删除死锁检测（仅检测 — D4）+ `S6.acknowledge`                                                                                                                                                      | M      | alert-only                 |
| T15                                                | AR-05m    | `S5.kill-and-resume` 手动修复选项（复用 killStaleRunProcessTree fail-safe）                                                                                                                               | S      | 手动可用                   |
| T16                                                | AR-20     | 廉价可观测：boot-reap awaiting\_\* alert / `/diagnose` 跑 stuck / doctor 生命周期检查 / DiagnoseTable fallback                                                                                            | S      | 生效                       |
| T17                                                | AR-10     | 周期性 post-boot 孤儿 reconciler（reap-to-interrupted 安全默认）+ 新不变式                                                                                                                                | M      | reap 可 on / 续跑受 T18 门 |
| **PR-F 自动执行（实现但默认 OFF — D1）**           |
| T18                                                | AR-03     | boot auto-resume（`autoResumeOnBoot=false`）daemon-restart cause + 熔断 + snapshot-resolvable + 幂等                                                                                                      | M      | **默认 OFF**               |
| T19                                                | AR-04     | 闭环 detect→classify→auto-repair loop（`autoRepair` per-rule off）lease+grace+breaker + system actor                                                                                                      | L      | **默认 OFF**               |
| T20                                                | AR-05a    | 心跳驱动 stalled-child auto-kill（`autoKillStalledChild=false`）                                                                                                                                          | M      | **默认 OFF**               |
| **PR-G 前端（恢复健康面 + 设置 + 通知 + parity）** |
| T21                                                | AR-11/20  | 系统健康/恢复事件页（开放 alerts + recovery_events 历史 + counters，ACL 过滤）                                                                                                                            | M      | —                          |
| T22                                                | AR-11     | 任务列表行 stuck 徽标                                                                                                                                                                                     | S      | —                          |
| T23                                                | AR-11     | WS `recovered`/`resolved` transition + 任务成员通知（去噪）                                                                                                                                               | S      | —                          |
| T24                                                | 配置      | Settings auto-knobs 开关 + 超时/预算/熔断（公共组件 + i18n 中英）                                                                                                                                         | M      | —                          |
| T25                                                | UI parity | 视觉对齐自查 + 源码文本断言锁公共组件                                                                                                                                                                     | S      | —                          |

## 2. 依赖关系

```
T1 (nextTaskStatus) ─┬─> T11 (quarantine 经事件)
                     └─> T18 (auto-resume status 写)
T2 (status 集) ──────────> T24/T22 (前端状态分类)
T3 (recovery_events) ────> T11/T18/T19/T20 (落痕) + T21 (健康页读)
T13 (autoApplyEligible) ─> T19 (自动白名单驱动)
T12 (lease) ─────────────> T18/T19 (apply 前取租约)
T11 (breaker) ───────────> T18/T19 (隔离门)
T9 (fail-safe kill) ─────> T15/T17/T20 (复用 kill 路径)
T10 (U1 index) 独立，但 enforce 前需验证 T6/resume 路径
T4/T5 独立，可最先落（P0 即时收益）
```

强序：**T1+T3 → T11/T12/T13 → T18/T19/T20**。T4/T5/T6/T7/T8/T9/T16 互相独立、可并行/早落。前端 PR-G 依赖后端端点（T3/T21 数据、T23 WS、T24 config）。

## 3. PR 拆分建议（7 PR，单一 RFC umbrella、单审批 gate）

1. **PR-A 地基**：T1 T2 T3（无行为变更；transition 表 + 状态集 + 审计表 + 现有 actor 落痕）。
2. **PR-B 配置接线**：T4 T5（P0，最先合，立即关掉无超时/无预算的洞 — D2 行为变更，release note 提示）。
3. **PR-C 安全修复**：T6 T7 T8 T9 T10（各自独立可验，多为读侧/additive；T10 shadow 先行）。
4. **PR-D 护栏**：T11 T12 T13（默认关闭 / 元数据；自动 loop 的前置）。
5. **PR-E 检测+可观测**：T14 T15 T16 T17（alert-only / 手动 / reap 安全默认）。
6. **PR-F 自动执行**：T18 T19 T20（实现但默认 OFF；每条带「关闭=零变更」锚 + 「开启路径」测试 + 幂等/熔断 oracle）。
7. **PR-G 前端**：T21 T22 T23 T24 T25（健康面 + badge + 通知 + 开关 + parity 自查）。

> 若某 PR 过大（尤其 PR-F 的 T19 auto-repair loop），可再拆但在本 plan 注明并各自立 PR。

## 4. 门禁与落库（每 PR）

- push 前本机全跑：`bun run typecheck`（三包）+ `bun run test`（全量，非针对性）+ `bun run format:check`；触及共享导出 / 新 migration 必跑 `bun run build:binary` smoke（[reference_binary_build_module_cycle]）。
- 多人协作：按精确路径 `git commit -- <paths>`（[feedback_shared_index_commit_race]）；不动他人未追踪文件；不 `git add -A`。
- push 后立即查 CI（[feedback_post_commit_ci_check]，run id 记进 STATE.md）。
- **Codex 双 gate**（[feedback_codex_review_after_changes]）：① 设计 gate——本三件套写完、**实现前**先过 Codex 复审，fold 后再动代码；② 实现 gate——每 PR 代码改完、声明完成前再过 Codex 复审，fold findings。
- STATE.md 同步：RFC 落档即在顶部追加「进行中 RFC-108」一行；每 PR 完工更新；全 RFC 完工改 Done 并在已完成 issue 表加行 + plan.md RFC 索引登记。

## 5. 验收清单（对应 proposal §4 AC）

- [ ] AC-1/2 配置接线：default 节点有 30min 硬超时、default 任务有预算（T4/T5）
- [ ] AC-3 recovery_events + counters + ACL 过滤（T3/T21）
- [ ] AC-4 熔断隔离 + 一键清 + 经 nextTaskStatus（T11/T1）
- [ ] AC-5 driver-lease 引擎级拒绝 + TTL + boot 清（T12）
- [ ] AC-6 autoApplyEligible 永不自动 destructive/多选项/中高危（T13）
- [ ] AC-7 GC 不删可恢复 worktree + resume 410 + 多仓 GC（T6）
- [ ] AC-8 resume 跨行原子回滚（T7）
- [ ] AC-9 S2 不误杀 cross-clarify（T8）
- [ ] AC-10 fail-safe survivor-kill 3-of-3（T9）
- [ ] AC-11 写时 U1 唯一约束 shadow→enforce（T10）
- [ ] AC-12 S6 成员删除检测（T14）
- [ ] AC-13 S5.kill-and-resume（T15）
- [ ] AC-14 nextTaskStatus oracle + 共享状态集（T1/T2）
- [ ] AC-15 boot auto-resume 默认 off / 开启幂等（T18）
- [ ] AC-16 auto-repair loop 默认 off / S4 首发 / 多选项 escalate（T19）
- [ ] AC-17 心跳 auto-kill + 周期 reconciler（T20/T17）
- [ ] AC-18 前端健康面 + badge + 开关 + parity（T21–T25）
- [ ] 全部默认 OFF 的自动执行各带「关闭=零行为变更」回归锚
- [ ] release note 显著提示 D2 默认超时行为变更
