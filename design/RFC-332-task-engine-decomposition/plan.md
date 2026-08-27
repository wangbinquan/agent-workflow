# RFC-332 实施计划：TaskEngine 拆分

> 状态：Done（2026-08-27；T0～T13 已发布，provenance replay 与 exact-SHA hosted CI 已收口）
>
> 批准边界：用户已授权 T3～T13；不授权 P0-C、W2-C/D、W3、
> W4/W5、安全/权限或能力收缩工作。

## 1. 实施原则

1. 复用 RFC-328 的 owner/intent/effect/fence/context/runtime/outbox，禁止第二权威。
2. 先锁 current behavior，再迁 owner；任何用户能力变化都先回 proposal 重新请批。
3. admission commands 可继续特化，但已准入后的 attach/prep/drive/release 必须唯一。
4. DAG、workgroup、dynamic workflow 保留各自状态机；只共享任务 lifecycle 与 mechanics ports。
5. 不整体移动 `scheduler.ts`；W2-B 只迁 task-level drive/frontier，W2-C/D body 保持并登记 bridge。
6. production consumer 切换与旧 body 删除为一个原子批，不保留双驱动窗口，不新增临时 `KNOWN_VIOLATIONS`。
7. 所有门检视只检查功能正确性与模块职责，不扫描、不提出、不实施新的安全策略。
8. 共享 `main` 只精确 stage 本 RFC 路径；保留并发工作，发布前/后同步并核对 `origin/main`。
9. 本地只跑可归因 targeted checks；全仓结论以 exact-SHA GitHub Actions terminal 状态为准。

## 2. 任务分解

### 2.1 RFC、current baseline 与批准门

| ID         | 任务              | 状态   | 完成条件                                                                                                             |
| ---------- | ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| RFC-332-T0 | current inventory | 已完成 | source SHA、四 drive、boot prep、三 engine、scheduler mixed body、相邻 RFC oracle、canonical substring defect 可复跑 |
| RFC-332-T1 | 三件套与总纲回填  | 已完成 | proposal/design/plan、RFC-294、design index、STATE 一致；生产代码/测试/artifacts diff=0                              |
| RFC-332-T2 | 用户批准门        | 已完成 | 2026-08-27 用户以“ok”显式批准 D1～D12、能力影响与 DEV-1/DEV-2                                                        |

### 2.2 Batch A：additive contracts、oracle 与 canonical classifier（批准后）

| ID         | 任务                               | 状态/依赖            | 完成条件                                                                                                                             |
| ---------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| RFC-332-T3 | drive/application contracts        | 已完成               | `ResolvedTaskDriveConfig`、submission/receipt、coordinator/engine/store/bridge types；request 无 DB/controller/context/config spread |
| RFC-332-T4 | recording/no-op/poison composition | 已完成（依赖 T3）    | instance-local test application；production 无 optional fallback/global registrar；旧 consumer 尚未切换                              |
| RFC-332-T5 | behavior oracle expansion          | 已完成（依赖 T3,T4） | 四 drive 时序、attach/release、prep phase、三 engine truth table、task settle 与相邻 RFC矩阵先在旧实现上全绿                         |
| RFC-332-T6 | canonical classifier correction    | 已完成（依赖 T3）    | `schedule` token boundary；scheduler 反例；B/C/D key symbol owner/wave mutation先红后绿，不手改 artifact                             |

Batch A 只加合同、fixtures 与真值修正，不创建第二 production driver。若合同需要改正常功能，停止并回 T1/T2。

### 2.3 Batch B：repository preparation + coordinator

| ID         | 任务                      | 状态/依赖            | 完成条件                                                                                                          |
| ---------- | ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| RFC-332-T7 | persisted prep descriptor | 已完成（依赖 T3-T6） | current retry reconstruction 提成唯一 read model；initial/retry/boot 都不再传临时 input/space/ownership bag       |
| RFC-332-T8 | RepositoryPreparationStep | 已完成（依赖 T7）    | `workspace-prepare` ledger、prep row、network window、cancel/shutdown、atomic backfill 与现有 RFC-287 oracle 等价 |
| RFC-332-T9 | TaskDriveCoordinator      | 已完成（依赖 T7,T8） | 唯一 attach/controller/context/background/await/catch/release/finalize；submission request 仅三字段               |

T7～T9 在同一 production candidate 内完成，但尚不单独发布一个“新 coordinator → 旧 task-level scheduler”长期半态。

### 2.4 Batch C：三 engine 与 single-consumer cutover

| ID          | 任务                                           | 状态/依赖              | 完成条件                                                                                                                                                  |
| ----------- | ---------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC-332-T10 | orchestrator + registry                        | 已完成（依赖 T5,T9）   | hydrate/claim/preflight/settle 迁 module；registry 恰好 dag/workgroup-turns/dw-generate；code-round 无 active arm                                         |
| RFC-332-T11 | DagTaskEngine                                  | 已完成（依赖 T10）     | `runScope/deriveFrontier` 迁唯一 owner；top/nested scope、questions、commit-push、skipped/consumed 全等价                                                 |
| RFC-332-T12 | workgroup/dynamic strategies + mechanics ports | 已完成（依赖 T10,T11） | round/dynamic state machine 不改；typed host/node/nested-scope/replay adapters 有 W2-C/D remove wave，completion effect 经长期 required port，无 god-port |
| RFC-332-T13 | production cutover + closeout                  | 已完成（依赖 T10-T12） | 全入口改 coordinator；四 kick/boot 特例/legacy task drive/frontier body=0；artifacts 已重放；发布/provenance/exact-SHA CI 已收口                          |

T10～T13 的 consumer switch、旧 body 删除与 facade ledger 更新必须作为一个 cohesive production commit；
Batch A 的 additive contract commit 可以独立存在，Batch B/C 不能发布可双驱动的中间态。

## 3. production 入口 inventory

实现前将每个构造点映射到一个 test/receipt；不以调用次数总数替代 exact inventory。

| 来源                                 | current adapter/command                 | admission 后目标                                                       |
| ------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------- |
| direct JSON / task route             | `buildStartTaskDeps → startTask`        | coordinator submission                                                 |
| multipart                            | pre-materialized `startTask`            | phase0 skip → coordinator                                              |
| schedule                             | `scheduleLaunch`                        | 同 direct launch coordinator                                           |
| webhook                              | `webhookDispatch`                       | 同 direct launch coordinator                                           |
| agent/workgroup resource launch      | `agentLaunch` / `workgroup/launch`      | same admission receipt → coordinator                                   |
| DA/DE execution                      | task-execution composition adapters     | internal host task → coordinator/DAG                                   |
| fusion                               | two `StartTaskDeps` construction sites  | prepared/source-specific admission → coordinator                       |
| call workflow/workgroup              | scheduler/node legacy mechanics         | child admission → coordinator；parent observe语义不变                  |
| resume                               | `resumeKick`                            | lifecycle+intent CAS → coordinator                                     |
| sync workflow                        | `resumeKick` extra snapshot             | same coordinator                                                       |
| review/clarify/question continuation | route → resume/gate continuation        | same coordinator；P0-C 不在本 RFC迁                                    |
| retry node                           | `retryNode`                             | rollback/mint/admission → coordinator                                  |
| retry repository prep                | `retryRepoPreparation`                  | retry admission → same phase0/coordinator                              |
| boot auto-resume                     | CLI + `autoResumeInterruptedTasks`      | application recovery dispatcher → resume/retry admission → coordinator |
| lifecycle repair/auto repair         | injected `StartTaskDeps` / `resumeTask` | same coordinator                                                       |

新增生产入口若不在表中，architecture inventory 必须转红并要求先登记，而不是静默绕过 coordinator。

## 4. 生产提交拆分

计划发布链：

1. **Docs baseline**：本 RFC 三件套、RFC-294/index/STATE（Draft，零生产代码）。
2. **Batch A**：contracts + fixtures + canonical classifier tests；无 production consumer change。
3. **Batch B+C cohesive cutover**：prep/coordinator/orchestrator/three engines/bridges、全部 consumer switch、旧 body 删除。
4. **Canonical replay**：由 generator 重放 owner/facade/cross-context/current-report；若内容足够小可与 cutover 同笔，
   否则紧随 payload commit，且不在 replay 前声明 W2-B Done。
5. **Docs closeout**：回填真实 commits、artifact digest、targeted checks 与 exact-SHA hosted CI。

实际发布链：主实现 `fced3066790551ba6408ca7016b46e26b41c9bc5` → 首轮归一化/重钉
`e186d9dc621e36dde1ab9e195e114b638541ae97` / `8e756cbaa694d8cf62496dea06770e94cf1c4c61` → 首轮守卫修复
`0cdbcd3830d4e4583cc4c65bb0b1ac3ec9581e3f` → 最终内容修复 `b63733a4f77c232d0cb9b285281953f89cea9d8a` →
归一化 `a36fd94c28d1b8300e9b67c0b0ca5c3dcc6d0761` → provenance 重钉
`4dd30d034f1bcb0c6532301cec11bdd288702105`。

每笔提交前 exact-path 检查 shared index；若 `origin/main` 前进，按共享 main 规则安全 fast-forward/merge 并只对受影响内容做
比例验证。不得 reset/stash/rebase/amend/force-push 或携带并发无关 WIP。

## 5. 验证矩阵

### 5.1 targeted contract/architecture

| 面                   | 最小 suite/断言                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| topology/coordinator | RFC-331 suite 演进版 + RFC-332 recording/poison fixtures                                             |
| engine registry      | RFC-243 resolver、RFC-167 dispatch truth table、fourth-engine mutation                               |
| DAG                  | derive/dispatch frontier、scope outcome、scheduler boundary/audit/source-lock corpus                 |
| owner projection     | RFC-294 canonical manifests + direct classifier mutation；scheduler != schedule                      |
| bridge budget        | public surface/recursive field consumer ledger；SchedulerState/StartTaskDeps/DB/index-signature bans |
| old-body extinction  | AST inventory：four kick=0、CLI prep query=0、runTaskInner/runScope/deriveFrontier legacy body=0     |

### 5.2 behavior

| 面               | 必须覆盖                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| launch           | direct/multipart/schedule/webhook/agent/workgroup/DA/DE/fusion/call child                                      |
| prep             | RFC-287 T13 full matrix、effect receipt、retryIndex、atomic backfill、cancel/shutdown、immediate return        |
| resume/retry     | resume/sync/gate/retry-node/retry-prep、rollback/freshness/branch run-anyway、attach races                     |
| recovery         | RFC-108 auto-resume、RFC-186 workgroup reconcile、answered continuation、boot prep breaker/audit               |
| workgroup        | RFC-164 core/engine + RFC-186 e2e/reconcile/clarify                                                            |
| dynamic workflow | RFC-167 generate/execute/confirm/reject/resume/phase invariant                                                 |
| adjacent facts   | RFC-301 origin/inheritance、RFC-300 prune、RFC-303 termination、RFC-306 skipped/consumed、RFC-310 host/catalog |
| lifecycle/events | cancel-wins/park/done/fail CAS、RFC-328 outbox single-send、RFC-331 WS golden                                  |

### 5.3 gate discipline

- `git diff --check`、Markdown link check、RFC consistency/source anchors；
- targeted typecheck/lint/tests for touched packages and registered scheduler corpus；
- equivalent full local gate 已有运行时不重复启动；同一 candidate 最多一次；
- 发布后查询 exact commit SHA 的 CI jobs，等 terminal；失败按 job/test/path 归因并修复；
- scheduled CI 不属于本 RFC 默认发布门，除非用户另行要求；不能拿 unrelated/cancelled run 冒充绿色证据。

## 6. 完成清单

- [x] current source SHA 与 shared-tree ownership 已确认。
- [x] 四 drive、boot prep、三 engine、task settle、node/wrapper mixed body 已盘清。
- [x] RFC-287/300/301/303/306/310/328/331 功能不变量已纳入范围。
- [x] canonical `scheduler`→`schedule` 子串误分类已用 artifact 数据复现（112 rows 中 111 个误为 integration）。
- [x] RFC 三件套、RFC-294、index、STATE 完成一致性回填。
- [x] 用户显式批准 D1～D12、能力影响与 DEV-1/DEV-2（2026-08-27，“ok”）。
- [x] T3～T6 Batch A 完成。
- [x] T7～T9 coordinator/prep 实现完成。
- [x] T10～T13 engine/cutover/artifact 实现与发布收口完成。
- [x] production direct kick/boot prep special dispatch/legacy task drive-frontier body 全部归零。
- [x] 三 engine、prep、recovery、adjacent RFC 与 lifecycle/WS targeted oracle 全绿。
- [x] canonical payload artifacts 由真实 source 重放，关键 owner/wave、RI 与 source digest 对齐。
- [x] backend/repo value SCC 保持 RFC-331 收口后的 `4/6`，无 task-execution SCC 回归。
- [x] payload commit 后重放四份 N1a provenance，content digest 与真实 published snapshot 对齐。
- [x] exact-SHA hosted CI terminal success，失败/取消/排队均已精确归因。
- [x] RFC-332 标 Done；RFC-294 指针推进到 P0-C residual，而非误标 W2 全部完成。

### 6.1 最终验证记录（2026-08-27）

- backend typecheck 绿色；RFC-287 deferred preparation 全矩阵 `58/58`；resume/retry/lifecycle/prune 定向矩阵 `63/63`；
- RFC-331/RFC-332/RFC-243 与 architecture 定向组合 `65/65`；最终 engine/DAG/source-lock 行为组合 `158/158`；
- RFC-317 module boundary + ledger high-water 最终分别 `25/25` 与 `37/37`；
  `startTaskDeps → taskEngineApplication` 与 `task → taskDriveLegacy` 两条 exact composition seam 均进入 canonical exception/
  commons debt，具名 `RFC-332` 与各自 `W2-D` / `W4` 删除波次；内容提交使用的一次性 `allowGrowth`
  已在归一化提交中全部删除，未新增 `KNOWN_VIOLATIONS`；
- canonical manifest N1a/N1b 最终 `22/22`绿色；source digest
  `sha256:db8ee412d9cb1d96fede43392faa65095ccd2447f5af16f88dd805325daa6084`，四份 governance artifact 的
  `currentSnapshotSha` 均为 `a36fd94c28d1b8300e9b67c0b0ca5c3dcc6d0761`；
- current canonical denominator：mutation `911`、cross-context `1049`、exception `1023`、facade `371`、
  public surface `300`、owner `17622`；backend/repo value SCC 仍为 `4/6`；
- exact SHA `4dd30d034f1bcb0c6532301cec11bdd288702105` 已在 `origin/main`：CI `33052994260` `35/35`、
  git-protocols-e2e `33052994263` `1/1`、integration-opencode `33052994318` `2/2` 均 terminal `success`。

## 7. 已批准的精确内容

用户于 2026-08-27 以“ok”批准 proposal：

- D1 两级合同；
- D2 submission 三字段、config instance-bound；
- D3 单 attach/release owner；
- D4 preparation phase 0 与 manual resume 兼容；
- D5 复用 RFC-328；
- D6 三路 engine registry；
- D7 DAG/workgroup/dynamic 语义分离；
- D8 task settle 单写；
- D9 有界 mechanics ports 与明确 adapter 接管/删除波次；
- D10 canonical 真值先修；
- D11 single-consumer 原子切换；
- D12 功能优先、无安全/权限夹带；
- 能力影响清单十二行全部零行为变化；
- DEV-1 W2-C/D legacy adapters + W5 completion adapter 迁位，与 DEV-2 W3 前 status publisher compatibility。

T3～T13 已发布并完成 hosted closeout；本次批准不外溢到后续 wave。下一节点是 P0-C residual；
W2-C/D、W3、W5 仍需新 RFC 与明确批准。
